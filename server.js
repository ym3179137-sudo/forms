import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { runSolver } from "./main.js";
import { acquire, release, getStatus, queuePosition } from "./lib/session-pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── login auth ──────────────────────────────────────────────
import { login, verify } from "./lib/auth.js";

const OPEN_PATHS = new Set(["/api/health", "/api/login"]);
app.use((req, res, next) => {
  if (OPEN_PATHS.has(req.path)) return next();
  if (req.method === "GET" && !req.path.startsWith("/api/")) return next(); // static files
  if (req.path === "/") return next(); // landing page

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
  const entry = {
    ws: null,
    stop: false,
    startedAt: Date.now(),
    released: false
  };
  sessions.set(sessionId, entry);

  // try to acquire a slot (queues if full)
  try {
    await acquire(sessionId);
  } catch (err) {
    sessions.delete(sessionId);
    return res.status(503).json({ error: "queue timeout — try again shortly" });
  }

  // respond immediately — the client already has a sessionId
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
    onEvent: (msg) => broadcast(sessionId, msg)
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

// ─── websocket ───────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) return ws.close();
  const entry = sessions.get(sessionId);
  if (!entry) return ws.close();
  entry.ws = ws;
  ws.send(JSON.stringify({ type: "hello", sessionId }));
  ws.on("close", () => { if (entry.ws === ws) entry.ws = null; });
});

const port = process.env.PORT || config.server.port;
const host = process.env.PORT ? "0.0.0.0" : config.server.host;

server.listen(port, host, () => {
  console.log(`[ixl-server] http://${host}:${port}`);
  console.log(`[ixl-server] max concurrent: ${getStatus().max}`);
});