import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import net from "net";
import express from "express";
import { fileURLToPath } from "url";
import { login, verify, getIxlCreds, saveIxlCreds } from "./lib/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const OPEN_PATHS = new Set(["/api/health", "/api/login"]);
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

app.get("/api/ixl-creds", async (req, res) => {
  try {
    const creds = await getIxlCreds(req.ixlUser);
    if (!creds) return res.json({ email: "", password: "", has: false });
    res.json({ email: creds.email, password: creds.password, has: !!(creds.email && creds.password) });
  } catch (_) {
    res.json({ email: "", password: "", has: false });
  }
});

app.post("/api/ixl-creds", async (req, res) => {
  const { email, password } = req.body || {};
  const ok = await saveIxlCreds(req.ixlUser, email || "", password || "");
  res.json({ ok });
});

app.get("/vnc/package.json", (req, res) => {
  res.json({ name: "novnc", version: "1.5.0" });
});

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
    if (!res.headersSent) res.status(502).send("vnc proxy error");
  });
  req.pipe(proxyReq);
});

const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/vnc/websockify")) { socket.destroy(); return; }
  const backend = net.connect(6080, "127.0.0.1", () => {
    const backendPath = req.url.replace(/^\/vnc/, "");
    const headers = Object.entries(req.headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
      .join("\r\n");
    backend.write(`${req.method} ${backendPath} HTTP/1.1\r\n${headers}\r\n\r\n`);
    if (head && head.length) backend.write(head);
    backend.pipe(socket);
    socket.pipe(backend);
  });
  backend.on("error", () => { try { socket.destroy(); } catch (_) { } });
  socket.on("error", () => { try { backend.destroy(); } catch (_) { } });
  socket.on("close", () => { try { backend.destroy(); } catch (_) { } });
});

const port = process.env.PORT || config.server.port || 3000;
const host = process.env.PORT ? "0.0.0.0" : (config.server.host || "127.0.0.1");

server.listen(port, host, () => {
  console.log(`[ixl-server] http://${host}:${port}`);
  console.log(`[ixl-server] VNC embedded at /vnc/vnc.html`);
});