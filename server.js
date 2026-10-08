import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import express from "express";
import axios from "axios";
import { fileURLToPath } from "url";
import { chromium } from "playwright";
import { login, verify, getIxlCreds, saveIxlCreds } from "./lib/auth.js";
import { getAnswer } from "./lib/answer-engine.js";
import { lookupAnswer, saveAnswer, recordWrongAnswer } from "./lib/answer-cache.js";
import { ensureInjected } from "./lib/inject.js";
import { loadSecrets, getSecret } from "./lib/keys.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use("/api", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-IXL-Token");
  res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, "public")));

process.on("uncaughtException", (err) => console.error("[uncaught]", err.message));
process.on("unhandledRejection", (err) => console.error("[unhandled]", err?.message || err));

const OPEN_PATHS = new Set(["/api/health", "/api/login", "/api/solve", "/api/solve-form", "/api/feedback", "/api/navigate"]);
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
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/solve", async (req, res) => {
  try {
    const q = req.body || {};
    if (!q.stem || q.stem.length < 3) return res.status(400).json({ error: "no stem" });
    const cached = await lookupAnswer(q).catch(() => null);
    if (cached) return res.json({ ...cached, source: "cache" });
    const answer = await getAnswer(q, config);
    res.json({ ...answer, source: answer.source || "ai" });
  } catch (err) {
    console.error("[solve]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/solve-form", async (req, res) => {
  try {
    const { questions } = req.body || {};
    if (!Array.isArray(questions) || !questions.length) return res.status(400).json({ error: "no questions" });

    const lines = ["You solve a Google Form. Return ONLY valid JSON.", "Schema: {\"answers\":[{\"index\":n,\"type\":\"...\",\"answer_index\":n,\"answer_indices\":[n],\"value\":\"...\",\"confidence\":0-1}]}", ""];
    for (const q of questions) {
      lines.push(`--- index ${q.index} (${q.type}) ---`);
      lines.push(q.title);
      (q.options || []).forEach((o, i) => lines.push(`  ${i}: ${o}`));
    }

    const geminiKey = await getSecret("GEMINI_API_KEY");
    const groqKey = await getSecret("GROQ_API_KEY");
    const openrouterKey = await getSecret("OPENROUTER_API_KEY");

    const providers = [
      { name: "gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: geminiKey, jsonMode: false, models: ["gemini-flash-latest", "gemini-2.5-flash"] },
      { name: "groq", baseURL: "https://api.groq.com/openai/v1", apiKey: groqKey, jsonMode: true, models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"] },
      { name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: openrouterKey, jsonMode: true, models: ["openrouter/free"] }
    ];

    const sys = "You solve Google Forms. Use the exact schema. Never refuse. JSON only.";
    let lastErr;
    for (const p of providers) {
      if (!p.apiKey || /PUT_|your_/i.test(p.apiKey)) continue;
      for (const model of p.models) {
        for (const withJson of [p.jsonMode, false]) {
          try {
            const body = { model, messages: [{ role: "system", content: sys }, { role: "user", content: lines.join("\n") }], temperature: 0.15, max_tokens: 4000 };
            if (withJson) body.response_format = { type: "json_object" };
            const r = await axios.post(p.baseURL.replace(/\/$/, "") + "/chat/completions", body, {
              headers: { Authorization: "Bearer " + p.apiKey, "Content-Type": "application/json" },
              timeout: 40000, validateStatus: s => s < 500
            });
            if (r.status >= 400) throw new Error(`http ${r.status}`);
            let s = (r.data?.choices?.[0]?.message?.content || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
            const a = s.indexOf("{"), b = s.lastIndexOf("}");
            if (a >= 0 && b > a) s = s.slice(a, b + 1);
            const parsed = JSON.parse(s);
            return res.json({ answers: Array.isArray(parsed) ? parsed : (parsed.answers || []) });
          } catch (err) { lastErr = err; }
        }
      }
    }
    res.status(500).json({ error: lastErr?.message || "all failed" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/feedback", async (req, res) => {
  try {
    const { question, correct, correctAnswerText, appliedAnswer } = req.body || {};
    if (!question) return res.status(400).json({ error: "no question" });
    if (correct === true && appliedAnswer) {
      await saveAnswer(question, appliedAnswer, true).catch(() => { });
    } else if (correct === false) {
      await recordWrongAnswer(question, appliedAnswer || question).catch(() => { });
      if (correctAnswerText) {
        const parsed = parseCorrectAnswerText(correctAnswerText, question);
        if (parsed) await saveAnswer(question, parsed, true).catch(() => { });
      }
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function parseCorrectAnswerText(text, question) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return null;
  if (question.type === "multiple_choice") {
    const opts = question.options || [];
    let idx = opts.findIndex(o => o.trim() === cleaned);
    if (idx >= 0) return { type: "multiple_choice", answer_index: idx };
    const lc = cleaned.toLowerCase();
    idx = opts.findIndex(o => o.trim().toLowerCase() === lc);
    if (idx >= 0) return { type: "multiple_choice", answer_index: idx };
    return null;
  }
  if (question.type === "fill_in") return { type: "fill_in", value: cleaned };
  return null;
}

app.post("/api/navigate", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: "no url" });
    console.log(`[navigate] → ${url}`);
    const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
    const contexts = browser.contexts();
    if (!contexts.length) { await browser.close().catch(() => { }); return res.status(503).json({ error: "no context" }); }
    const context = contexts[0];
    const pages = context.pages();
    const page = pages[0] || await context.newPage();
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }); } catch (_) { }
    await browser.close().catch(() => { });
    res.json({ ok: true });
  } catch (err) {
    console.error("[navigate]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/vnc/package.json", (req, res) => res.json({ name: "novnc", version: "1.5.0" }));

app.use("/vnc", (req, res) => {
  const targetPath = req.url === "/" ? "/vnc.html" : req.url;
  const opts = { method: req.method, host: "127.0.0.1", port: 6080, path: targetPath, headers: { ...req.headers, host: "127.0.0.1:6080" } };
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
  const backendPath = req.url.replace(/^\/vnc/, "") || "/websockify";
  const headers = { ...req.headers, host: "127.0.0.1:6080" };
  delete headers["content-length"];
  const proxyReq = http.request({ host: "127.0.0.1", port: 6080, method: "GET", path: backendPath, headers });
  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\n");
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      socket.write(`${k}: ${Array.isArray(v) ? v.join(", ") : v}\r\n`);
    }
    socket.write("\r\n");
    if (proxyHead && proxyHead.length) socket.write(proxyHead);
    if (head && head.length) proxySocket.write(head);
    proxySocket.pipe(socket); socket.pipe(proxySocket);
    proxySocket.on("error", () => { try { socket.destroy(); } catch (_) { } });
    socket.on("error", () => { try { proxySocket.destroy(); } catch (_) { } });
    socket.on("close", () => { try { proxySocket.destroy(); } catch (_) { } });
  });
  proxyReq.on("error", () => { try { socket.destroy(); } catch (_) { } });
  proxyReq.end();
});

const port = process.env.PORT || config.server.port || 3000;
const host = process.env.PORT ? "0.0.0.0" : (config.server.host || "127.0.0.1");

server.listen(port, host, async () => {
  console.log(`[ixl-server] http://${host}:${port}`);
  try { await loadSecrets(); console.log("[ixl-server] secrets loaded"); } catch (_) { }
  try { await ensureInjected(); console.log("[ixl-server] inject started"); } catch (err) { console.error("[ixl-server] inject:", err.message); }
});