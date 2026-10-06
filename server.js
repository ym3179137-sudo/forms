import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { runSolver } from "./main.js";
import { acquire, release, getStatus } from "./lib/session-pool.js";
import { login, verify, getIxlCreds, saveIxlCreds } from "./lib/auth.js";
import { attachLiveView } from "./lib/live-view.js";
import { handleInput } from "./lib/input-relay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const OPEN_PATHS = new Set(["/api/health", "/api/login"]);
app.use((req, res, next) => {
  if (OPEN_PATHS.has(req.path)) return next();
  if (req.method === "GET" && !req.path.startsWith("/api/")) return next();
  if (req.path === "/") return next();
  const token = req.headers["x-ixl-token"] || req.query.token;
  const payload = verify(token);
  if (!payload) return res.status(401).json({ error: "not logged in" });
  req.ixlUser = payload.u;
  next();
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const token = login(username, password);
  if (!token) return res.status(401).json({ error: "invalid username or password" });
  res.json({ token, username });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));
app.get("/api/status", (req, res) => res.json(getStatus()));

app.get("/api/ixl-creds", async (req, res) => {
  const creds = await getIxlCreds(req.ixlUser);
  if (!creds) return res.json({ email: "", password: "", has: false });
  res.json({ email: creds.email, password: creds.password, has: !!(creds.email && creds.password) });
});

app.post("/api/ixl-creds", async (req, res) => {
  const { email, password } = req.body || {};
  const ok = await saveIxlCreds(req.ixlUser, email || "", password || "");
  res.json({ ok });
});

const sessions = new Map();

function broadcast(sessionId, msg) {
  const entry = sessions.get(sessionId);
  if (!entry || !entry.ws || entry.ws.readyState !== 1) return;
  try { entry.ws.send(JSON.stringify(msg)); } catch (_) { }
}

app.post("/api/start", async (req, res) => {
  const sessionId = "sess_" + Math.random().toString(36).slice(2, 10);
  const user = req.ixlUser || "unknown";
  const entry = {
    ws: null, stop: false, startedAt: Date.now(), released: false,
    page: null, liveView: null, user, pingInterval: null, urlInterval: null
  };
  sessions.set(sessionId, entry);

  try { await acquire(sessionId); }
  catch (err) {
    sessions.delete(sessionId);
    return res.status(503).json({ error: err.message });
  }

  res.json({ sessionId });

  const sessionConfig = JSON.parse(JSON.stringify(config));
  let ixlCreds = null;
  try { ixlCreds = await getIxlCreds(user); } catch (_) { }

  runSolver({
    sessionId,
    config: sessionConfig,
    creds: {
      openrouterKey: process.env.OPENROUTER_API_KEY,
      geminiKey: process.env.GEMINI_API_KEY,
      groqKey: process.env.GROQ_API_KEY
    },
    startUrl: process.env.IXL_URL || "https://www.ixl.com/",
    username: user,
    shouldStop: () => sessions.get(sessionId)?.stop === true,
    onEvent: (msg) => broadcast(sessionId, msg),
    onBrowserReady: async ({ page }) => {
      entry.page = page;
      try {
        const live = await attachLiveView(page, (data) => {
          broadcast(sessionId, { type: "frame", data });
        });
        entry.liveView = live;

        const vp = await page.evaluate(() => ({
          w: window.innerWidth, h: window.innerHeight
        })).catch(() => ({ w: 1366, h: 768 }));

        broadcast(sessionId, { type: "view-ready", viewportW: vp.w, viewportH: vp.h });
        broadcast(sessionId, { type: "url", url: await live.currentUrl() });

        if (ixlCreds && ixlCreds.email && ixlCreds.password) {
          setTimeout(async () => {
            const r = await live.tryAutoLoginIxl(ixlCreds.email, ixlCreds.password);
            if (r.ok) broadcast(sessionId, { type: "log", message: "auto-login submitted" });
          }, 4000);
        }

        entry.urlInterval = setInterval(async () => {
          if (!entry.liveView) return;
          const u = await entry.liveView.currentUrl();
          broadcast(sessionId, { type: "url", url: u });
        }, 2500);
      } catch (err) {
        console.error(`[solver ${sessionId}] live view failed:`, err.message);
      }
    }
  })
    .catch(err => broadcast(sessionId, { type: "fatal", message: err.message }))
    .finally(async () => {
      broadcast(sessionId, { type: "ended" });
      if (entry.urlInterval) clearInterval(entry.urlInterval);
      if (entry.pingInterval) clearInterval(entry.pingInterval);
      if (entry.liveView) { try { await entry.liveView.stop(); } catch (_) { } }
      if (!entry.released) { entry.released = true; release(sessionId); }
      setTimeout(() => sessions.delete(sessionId), 60000);
    });
});

app.post("/api/stop/:id", (req, res) => {
  const entry = sessions.get(req.params.id);
  if (!entry) return res.status(404).json({ error: "session not found" });
  entry.stop = true;
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  let pathname = "/";
  try { pathname = new URL(req.url, "http://localhost").pathname; } catch (_) { }
  if (pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const sessionId = url.searchParams.get("sessionId");
  const token = url.searchParams.get("token");
  if (!sessionId || !verify(token)) return ws.close(4001, "auth");
  const entry = sessions.get(sessionId);
  if (!entry) return ws.close(4004, "no session");

  entry.ws = ws;
  ws.send(JSON.stringify({ type: "hello", sessionId }));

  if (entry.pingInterval) clearInterval(entry.pingInterval);
  entry.pingInterval = setInterval(() => {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: "ping", t: Date.now() })); } catch (_) { }
    } else clearInterval(entry.pingInterval);
  }, 15000);

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    if (msg.type === "input" && entry.liveView) {
      const payload = msg.payload || msg;

      if (payload.type === "copy-request") {
        try {
          const r = await entry.liveView.cdp.send("Runtime.evaluate", {
            expression: "navigator.clipboard.readText().catch(()=>'')",
            awaitPromise: true, returnByValue: true
          });
          ws.send(JSON.stringify({ type: "clipboard", text: r?.result?.value || "" }));
        } catch (_) {
          ws.send(JSON.stringify({ type: "clipboard", text: "" }));
        }
        return;
      }

      await handleInput(entry.liveView.cdp, payload);
    } else if (msg.type === "nav" && entry.liveView) {
      if (msg.action === "back") await entry.liveView.goBack();
      else if (msg.action === "forward") await entry.liveView.goForward();
      else if (msg.action === "reload") await entry.liveView.reload();
      else if (msg.action === "navigate") await entry.liveView.navigate(msg.url);
      const u = await entry.liveView.currentUrl();
      broadcast(sessionId, { type: "url", url: u });
    } else if (msg.type === "auto-login") {
      if (entry.liveView) {
        const r = await entry.liveView.tryAutoLoginIxl(msg.email, msg.password);
        ws.send(JSON.stringify({ type: "log", message: "auto-login: " + (r.ok ? "submitted" : (r.reason || "failed")) }));
      }
    }
  });

  ws.on("close", () => {
    if (entry.ws === ws) entry.ws = null;
    if (entry.pingInterval) clearInterval(entry.pingInterval);
  });
});

const port = process.env.PORT || config.server.port;
const host = process.env.PORT ? "0.0.0.0" : config.server.host;
server.listen(port, host, () => {
  console.log(`[ixl-server] http://${host}:${port}`);
  console.log(`[ixl-server] max concurrent: ${getStatus().max}`);
});