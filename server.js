import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { runSolver } from "./main.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const sessions = new Map();

function broadcast(sessionId, msg) {
  const entry = sessions.get(sessionId);
  if (!entry || !entry.ws) return;
  try { entry.ws.send(JSON.stringify(msg)); } catch (_) { }
}

app.post("/api/start", async (req, res) => {
  const body = req.body || {};
  const steelKey = body.steelKey || process.env.STEEL_API_KEY;
  const openrouterKey = body.openrouterKey || process.env.OPENROUTER_API_KEY;
  const startUrl = body.startUrl || process.env.IXL_URL || "https://www.ixl.com/";
  const panelTitle = body.panelTitle || "notes";
  const defaultHidden = !!body.defaultHidden;

  const sessionId = "sess_" + Math.random().toString(36).slice(2, 10);
  sessions.set(sessionId, { ws: null, stop: false, startedAt: Date.now() });

  const sessionConfig = JSON.parse(JSON.stringify(config));
  sessionConfig.panel.title = panelTitle;
  sessionConfig.panel.defaultHidden = defaultHidden;

  res.json({ sessionId });

  runSolver({
    sessionId,
    config: sessionConfig,
    creds: { steelKey, openrouterKey },
    startUrl,
    shouldStop: () => sessions.get(sessionId)?.stop === true,
    onEvent: (msg) => broadcast(sessionId, msg)
  }).catch(err => broadcast(sessionId, { type: "fatal", message: err.message }))
    .finally(() => {
      broadcast(sessionId, { type: "ended" });
      setTimeout(() => sessions.delete(sessionId), 60000);
    });
});

app.post("/api/stop/:id", (req, res) => {
  const entry = sessions.get(req.params.id);
  if (!entry) return res.status(404).json({ error: "session not found" });
  entry.stop = true;
  res.json({ ok: true });
});

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
  console.log(`[ixl-server] keys loaded from .env. opening IXL: ${process.env.IXL_URL || "https://www.ixl.com/"}`);
});