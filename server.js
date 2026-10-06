import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { runSolver } from "./main.js";
import { acquire, release, getStatus } from "./lib/session-pool.js";
import { login, verify } from "./lib/auth.js";
import { attachLiveView } from "./lib/live-view.js";
import { handleInput } from "./lib/input-relay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── login auth ──────────────────────────────────────────────
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
  console.log(`[auth] ${username} logged in`);
  res.json({ token, username });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));
app.get("/api/status", (req, res) => res.json(getStatus()));

// ─── sessions ────────────────────────────────────────────────
const sessions = new Map();

function broadcast(sessionId, msg) {
  const entry = sessions.get(sessionId);
  if (!entry || !entry.ws) return;
  try { entry.ws.send(JSON.stringify(msg)); } catch (_) { }
}

app.post("/api/start", async (req, res) => {
  const sessionId = "sess_" + Math.random().toString(36).slice(2, 10);
  const user = req.ixlUser || "unknown";
  const entry = {
    ws: null,
    stop: false,
    startedAt: Date.now(),
    released: false,
    page: null,
    liveView: null,
    user
  };
  sessions.set(sessionId, entry);

  console.log(`[solver] session ${sessionId} from user ${user}`);

  try {
    await acquire(sessionId);
  } catch (err) {
    sessions.delete(sessionId);
    return res.status(503).json({ error: "queue timeout — try again shortly" });
  }

  res.json({ sessionId });

  const sessionConfig = JSON.parse(JSON.stringify(config));

  runSolver({
    sessionId,
    config: sessionConfig,
    creds: {
      openrouterKey: process.env.OPENROUTER_API_KEY,
      geminiKey: process.env.GEMINI_API_KEY,
      groqKey: process.env.GROQ_API_KEY
    },
    startUrl: process.env.IXL_URL || "https://www.ixl.com/",
    shouldStop: () => sessions.get(sessionId)?.stop === true,
    onEvent: (msg) => broadcast(sessionId, msg),
    onBrowserReady: ({ page }) => {
      entry.page = page;
      console.log(`[solver ${sessionId}] browser ready, page stored`);
      broadcast(sessionId, { type: "log", message: "browser window live — clicks go through the view above" });
    }
  })
    .catch(err => broadcast(sessionId, { type: "fatal", message: err.message }))
    .finally(() => {
      broadcast(sessionId, { type: "ended" });
      if (!entry.released) {
        entry.released = true;
        release(sessionId);
      }
      setTimeout(() => sessions.delete(sessionId), 60000);
    });
});

app.post("/api/stop/:id", (req, res) => {
  const entry = sessions.get(req.params.id);
  if (!entry) return res.status(404).json({ error: "session not found" });
  entry.stop = true;
  res.json({ ok: true });
});

// ─── http server + upgrade router ────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const viewWss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  let pathname = "/";
  try { pathname = new URL(req.url, "http://localhost").pathname; } catch (_) { }
  console.log(`[upgrade] path=${pathname}`);

  if (pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else if (pathname === "/view") {
    viewWss.handleUpgrade(req, socket, head, (ws) => viewWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// ─── /ws: status events ──────────────────────────────────────
wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const sessionId = url.searchParams.get("sessionId");
  const token = url.searchParams.get("token");

  if (!sessionId || !verify(token)) {
    console.warn(`[ws] auth fail for ${sessionId}`);
    return ws.close(4001, "auth");
  }
  const entry = sessions.get(sessionId);
  if (!entry) {
    console.warn(`[ws] no session ${sessionId}`);
    return ws.close(4004, "no session");
  }

  console.log(`[ws ${sessionId}] connected`);
  entry.ws = ws;
  ws.send(JSON.stringify({ type: "hello", sessionId }));
  ws.on("close", () => { if (entry.ws === ws) entry.ws = null; });
});

// ─── /view: live chromium stream ─────────────────────────────
viewWss.on("connection", async (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const sessionId = url.searchParams.get("sessionId");
  const token = url.searchParams.get("token");

  console.log(`[view] incoming connection for ${sessionId} (token len ${(token || "").length})`);

  const payload = verify(token);
  if (!payload) {
    console.warn(`[view ${sessionId}] auth failed`);
    return ws.close(4001, "auth");
  }

  const entry = sessions.get(sessionId);
  if (!entry) {
    console.warn(`[view ${sessionId}] no session`);
    return ws.close(4004, "no session");
  }

  console.log(`[view ${sessionId}] waiting for page...`);
  let waited = 0;
  while (!entry.page && waited < 30000) {
    await new Promise(r => setTimeout(r, 500));
    waited += 500;
    if (ws.readyState !== 1) return;
  }
  if (!entry.page) {
    console.warn(`[view ${sessionId}] timeout waiting for page`);
    try { ws.send(JSON.stringify({ type: "error", message: "browser never started" })); } catch (_) { }
    return ws.close();
  }

  console.log(`[view ${sessionId}] page found, attaching CDP...`);

  let live = null;
  try {
    live = await attachLiveView(entry.page, (data) => {
      if (ws.readyState !== 1) return;
      try { ws.send(JSON.stringify({ type: "frame", data })); } catch (_) { }
    });

    const dims = await entry.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight
    })).catch(() => ({ width: 1366, height: 768 }));

    ws.send(JSON.stringify({ type: "meta", width: dims.width, height: dims.height }));
    entry.liveView = live;

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      await handleInput(live.cdp, msg);
    });

    ws.on("close", async () => {
      try { await live.stop(); } catch (_) { }
      entry.liveView = null;
      console.log(`[view ${sessionId}] disconnected`);
    });

    console.log(`[view ${sessionId}] attached — streaming`);
  } catch (err) {
    console.error(`[view ${sessionId}] failed:`, err.message);
    try { ws.close(); } catch (_) { }
  }
});

// ─── listen ──────────────────────────────────────────────────
const port = process.env.PORT || config.server.port;
const host = process.env.PORT ? "0.0.0.0" : config.server.host;

server.listen(port, host, () => {
  console.log(`[ixl-server] http://${host}:${port}`);
  console.log(`[ixl-server] max concurrent: ${getStatus().max}`);
});