import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import net from "net";
import express from "express";
import { fileURLToPath } from "url";
import { login, verify } from "./lib/auth.js";
import { getAnswer } from "./lib/answer-engine.js";
import { lookupAnswer, saveAnswer, recordWrongAnswer } from "./lib/answer-cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));

const app = express();
app.use(express.json({ limit: "5mb" }));

// CORS for /api/solve from ixl.com pages
app.use("/api", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-IXL-Token");
  res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, "public")));

const OPEN_PATHS = new Set(["/api/health", "/api/login", "/api/solve", "/api/feedback"]);
app.use((req, res, next) => {
  if (OPEN_PATHS.has(req.path)) return next();
  if (req.path.startsWith("/vnc")) return next();
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

// ─── SOLVE ────────────────────────────────────────────────────
app.post("/api/solve", async (req, res) => {
  try {
    const q = req.body || {};
    if (!q.stem || q.stem.length < 3) return res.status(400).json({ error: "no stem" });

    // cache lookup first
    const cached = await lookupAnswer(q).catch(() => null);
    if (cached) {
      console.log("[solve] cache hit");
      return res.json(cached);
    }

    // AI call
    const creds = {
      openrouterKey: process.env.OPENROUTER_API_KEY,
      geminiKey: process.env.GEMINI_API_KEY,
      groqKey: process.env.GROQ_API_KEY
    };
    const answer = await getAnswer(q, config, creds);
    console.log("[solve] ai →", JSON.stringify(answer).slice(0, 100));
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
      // don't re-save, but bump stats if we want
    } else {
      await recordWrongAnswer(question, question).catch(() => { });
      if (correctAnswerText) {
        // best-effort: parse and save
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/vnc/package.json", (req, res) => res.json({ name: "novnc", version: "1.5.0" }));

app.use("/vnc", (req, res) => {
  const targetPath = req.url === "/" ? "/vnc.html" : req.url;
  const opts = {
    method: req.method, host: "127.0.0.1", port: 6080, path: targetPath,
    headers: { ...req.headers, host: "127.0.0.1:6080" }
  };
  const proxyReq = http.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", () => { if (!res.headersSent) res.status(502).send("vnc err"); });
  req.pipe(proxyReq);
});

const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/vnc/websockify")) return socket.destroy();
  const backend = net.connect(6080, "127.0.0.1", () => {
    const backendPath = req.url.replace(/^\/vnc/, "");
    const headers = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`).join("\r\n");
    backend.write(`${req.method} ${backendPath} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head?.length) backend.write(head);
    backend.pipe(socket); socket.pipe(backend);
  });
  backend.on("error", () => socket.destroy());
  socket.on("error", () => backend.destroy());
  socket.on("close", () => backend.destroy());
});

const port = process.env.PORT || config.server.port || 3000;
const host = process.env.PORT ? "0.0.0.0" : (config.server.host || "127.0.0.1");
server.listen(port, host, () => {
  console.log(`[ixl-server] http://${host}:${port}`);
  console.log(`[ixl-server] VNC at /vnc/vnc.html`);
});