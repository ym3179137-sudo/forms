import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import express from "express";
import { fileURLToPath } from "url";
import { login, verify, getIxlCreds, saveIxlCreds } from "./lib/auth.js";
import { getAnswer } from "./lib/answer-engine.js";
import { lookupAnswer, saveAnswer, recordWrongAnswer } from "./lib/answer-cache.js";
import { ensureInjected } from "./lib/inject.js";
import { loadSecrets } from "./lib/keys.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));

const app = express();
app.use(express.json({ limit: "5mb" }));

// CORS for the injected panel
app.use("/api", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-IXL-Token");
  res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, "public")));

// keep the process alive
process.on("uncaughtException", (err) => {
  console.error("[uncaught]", err.message, err.stack?.split("\n")[1]);
});
process.on("unhandledRejection", (err) => {
  console.error("[unhandled]", err?.message || err);
});

// ─── auth middleware ────────────────────────────────────────
const OPEN_PATHS = new Set(["/api/health", "/api/login", "/api/solve", "/api/feedback"]);
app.use((req, res, next) => {
  if (OPEN_PATHS.has(req.path)) return next();
  if (req.path.startsWith("/vnc")) return next();
  if (req.method === "GET" && !req.path.startsWith("/api/")) return next();
  if (req.path === "/") return next();
  const token = req.headers["x-ixl-token"] || req.query.token;
  verify(token).then((payload) => {
    if (!payload) return res.status(401).json({ error: "not logged in" });
    req.ixlUser = payload.u;
    next();
  }).catch(() => res.status(401).json({ error: "auth error" }));
});

// ─── login ──────────────────────────────────────────────────
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const token = await login(username, password);
    if (!token) return res.status(401).json({ error: "invalid username or password" });
    console.log(`[auth] ${username} logged in`);
    res.json({ token, username });
  } catch (err) {
    console.error("[login]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

// ─── IXL creds ──────────────────────────────────────────────
app.get("/api/ixl-creds", async (req, res) => {
  try {
    const creds = await getIxlCreds(req.ixlUser);
    if (!creds) return res.json({ email: "", password: "", has: false });
    res.json({ email: creds.email || "", password: creds.password || "", has: !!(creds.email && creds.password) });
  } catch (_) {
    res.json({ email: "", password: "", has: false });
  }
});

app.post("/api/ixl-creds", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const ok = await saveIxlCreds(req.ixlUser, email || "", password || "");
    res.json({ ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SOLVE ──────────────────────────────────────────────────
app.post("/api/solve", async (req, res) => {
  try {
    const q = req.body || {};
    if (!q.stem || q.stem.length < 3) return res.status(400).json({ error: "no stem" });

    const cached = await lookupAnswer(q).catch(() => null);
    if (cached) {
      console.log("[solve] cache hit");
      return res.json(cached);
    }

    const answer = await getAnswer(q, config);
    console.log("[solve] ai →", JSON.stringify(answer).slice(0, 120));
    res.json(answer);
  } catch (err) {
    console.error("[solve] error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/feedback", async (req, res) => {
  try {
    const { question, correct, correctAnswerText } = req.body || {};
    if (!question) return res.status(400).json({ error: "no question" });
    if (correct === true) {
      await saveAnswer(question, question._answer || {}, true).catch(() => { });
    } else {
      await recordWrongAnswer(question, question).catch(() => { });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── VNC proxy ──────────────────────────────────────────────
app.get("/vnc/package.json", (req, res) => res.json({ name: "novnc", version: "1.5.0" }));

app.use("/vnc", (req, res) => {
  const targetPath = req.url === "/" ? "/vnc.html" : req.url;
  const opts = {
    method: req.method,
    host: "127.0.0.1",
    port: 6080,
    path: targetPath,
    headers: { ...req.headers, host: "127.0.0.1:6080" }
  };
  const proxyReq = http.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (err) => {
    console.error("[vnc proxy]", err.message);
    if (!res.headersSent) res.status(502).send("vnc err");
  });
  req.pipe(proxyReq);
});

// ─── HTTP server + VNC websocket bridge ────────────────────
const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/vnc/websockify")) {
    socket.destroy();
    return;
  }

  const backendPath = req.url.replace(/^\/vnc/, "") || "/websockify";
  const headers = { ...req.headers, host: "127.0.0.1:6080" };
  delete headers["content-length"];

  const proxyReq = http.request({
    host: "127.0.0.1",
    port: 6080,
    method: "GET",
    path: backendPath,
    headers
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\n");
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      const val = Array.isArray(v) ? v.join(", ") : v;
      socket.write(`${k}: ${val}\r\n`);
    }
    socket.write("\r\n");
    if (proxyHead && proxyHead.length) socket.write(proxyHead);
    if (head && head.length) proxySocket.write(head);

    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on("error", () => { try { socket.destroy(); } catch (_) { } });
    socket.on("error", () => { try { proxySocket.destroy(); } catch (_) { } });
    socket.on("close", () => { try { proxySocket.destroy(); } catch (_) { } });
  });

  proxyReq.on("error", (err) => {
    console.error("[vnc ws bridge]", err.message);
    try { socket.destroy(); } catch (_) { }
  });

  proxyReq.end();
});

// ─── boot ───────────────────────────────────────────────────
const port = process.env.PORT || config.server.port || 3000;
const host = process.env.PORT ? "0.0.0.0" : (config.server.host || "127.0.0.1");

server.listen(port, host, async () => {
  console.log(`[ixl-server] http://${host}:${port}`);
  console.log(`[ixl-server] VNC at /vnc/vnc.html`);

  try {
    await loadSecrets();
    console.log(`[ixl-server] secrets loaded`);
  } catch (err) {
    console.error("[ixl-server] secrets load failed:", err.message);
  }

  try {
    await ensureInjected("/app/chromium-ext/content.js");
    console.log(`[ixl-server] inject watcher started`);
  } catch (err) {
    console.error("[ixl-server] inject failed:", err.message);
  }
});