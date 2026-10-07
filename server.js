import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import express from "express";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "url";
import { login, verify } from "./lib/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const OPEN_PATHS = new Set(["/api/health", "/api/login"]);
app.use((req, res, next) => {
  if (OPEN_PATHS.has(req.path)) return next();
  if (req.path.startsWith("/vnc")) return next(); // noVNC needs unauthenticated access for its own assets
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

// proxy to internal noVNC/websockify on :6080
app.use("/vnc", (req, res) => {
  const target = "http://127.0.0.1:6080" + req.url;
  const opts = {
    method: req.method,
    headers: { ...req.headers, host: "127.0.0.1:6080" }
  };
  const proxyReq = http.request(target, opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (err) => {
    console.error("[vnc proxy]", err.message);
    res.status(502).send("vnc proxy error");
  });
  req.pipe(proxyReq);
});

const server = http.createServer(app);

// upgrade websocket /vnc/websockify → ws://127.0.0.1:6080/websockify
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/vnc/websockify")) {
    const targetUrl = "ws://127.0.0.1:6080/websockify";
    const http = require("http");
    // websockify needs the raw TCP bridge; use a raw net socket
    const net = require("net");
    const backend = net.connect(5900 + 0, "127.0.0.1", () => {
      // actually websockify listens on 6080 for websockets
    });
    socket.destroy(); // handled below by simpler approach
    return;
  }
  socket.destroy();
});

// simpler: just proxy the upgrade to websockify
import net from "net";
server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/vnc/websockify")) {
    const backend = net.connect(6080, "127.0.0.1", () => {
      // forward the raw http upgrade onto websockify
      const headers = Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`)
        .join("\r\n");
      backend.write(`${req.method} ${req.url.replace(/^\/vnc/, "")} HTTP/1.1\r\n${headers}\r\n\r\n`);
      backend.pipe(socket);
      socket.pipe(backend);
    });
    backend.on("error", () => socket.destroy());
    socket.on("error", () => backend.destroy());
    return;
  }
  socket.destroy();
});

const port = process.env.PORT || config.server.port || 3000;
const host = process.env.PORT ? "0.0.0.0" : (config.server.host || "127.0.0.1");

server.listen(port, host, () => {
  console.log(`[ixl-server] http://${host}:${port}`);
  console.log(`[ixl-server] VNC embedded at /vnc/vnc.html`);
});