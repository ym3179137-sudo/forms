import "dotenv/config";
import fs from "fs";
import path from "path";
import http from "http";
import express from "express";
import axios from "axios";
import { fileURLToPath } from "url";
import { login, verify, signup, ssoLogin, getIxlCreds, saveIxlCreds, hashPassword } from "./lib/auth.js";
import { getAnswer } from "./lib/answer-engine.js";
import { lookupAnswer, saveAnswer, recordWrongAnswer } from "./lib/answer-cache.js";
import { ensureInjected } from "./lib/inject.js";
import { loadSecrets, getSecret } from "./lib/keys.js";
import {
  getOrCreateSession, getSession, getQueueInfo, killSession, stats as sessionStats, touchSession
} from "./lib/session-manager.js";
import { safeNavigate } from "./lib/navigate-safe.js";
import {
  getUser, isExpired, timeLeftMs, createUser, addTime, setExpiry, setRole,
  listUsers, deleteUser, setApps
} from "./lib/users.js";
import { APP_CATALOG, filterAppsForUser, userCanUseApp, detectAppFromUrl } from "./lib/apps.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));

const OWNER_USERNAME = process.env.OWNER_USERNAME || "yassinyassinfree";

const app = express();
app.use(express.json({ limit: "10mb" }));
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

const OPEN_PATHS = new Set([
  "/api/health", "/api/login", "/api/signup", "/api/sso", "/api/verify",
  "/api/solve", "/api/solve-form", "/api/feedback",
  "/enter"
]);

// ─── auth ───────────────────────────────────────────────
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

app.post("/api/signup", async (req, res) => {
  try {
    const { username, password, email } = req.body || {};
    const result = await signup(username, password, email);
    if (!result.ok) return res.status(400).json({ error: result.error });
    console.log(`[auth] signup ${username}`);
    res.json({ token: result.token, username: result.username });
  } catch (err) {
    console.error("[signup]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/enter", async (req, res) => {
  try {
    const { t, s, redirect } = req.query;
    if (!t || !s) return res.status(400).send("missing sso params");
    const result = await ssoLogin(t, s);
    if (!result.ok) return res.status(401).send("sso failed: " + result.error);
    console.log(`[auth] sso ${result.username} site=${result.site}`);
    const target = redirect || "/";
    const sep = target.includes("#") ? "&" : "#";
    res.redirect(`${target}${sep}sso_token=${encodeURIComponent(result.token)}&sso_user=${encodeURIComponent(result.username)}&sso_site=${encodeURIComponent(result.site || "ixl")}`);
  } catch (err) {
    console.error("[sso]", err.message);
    res.status(500).send("sso error: " + err.message);
  }
});

app.get("/api/sso", async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  res.redirect("/enter?" + qs);
});

app.get("/api/health", (req, res) => res.json({ ok: true, ...sessionStats() }));

// ─── auth gate ──────────────────────────────────────────
app.use(async (req, res, next) => {
  if (OPEN_PATHS.has(req.path)) return next();
  if (req.path.startsWith("/session/")) return next();
  if (req.method === "GET" && !req.path.startsWith("/api/")) return next();
  if (req.path === "/") return next();

  const token = req.headers["x-ixl-token"] || req.query.token;
  const payload = await verify(token).catch(() => null);
  if (!payload) return res.status(401).json({ error: "not logged in" });

  const user = await getUser(payload.u);
  if (!user) return res.status(401).json({ error: "user not found" });

  if (isExpired(user)) {
    return res.status(402).json({
      error: "time_expired",
      message: "Your time has ended. Contact the owner to add more time.",
      username: user.username,
      expiresAt: user.expiresAt
    });
  }

  req.ixlUser = user.username;
  req.ixlUserRecord = user;
  req.ixlIsOwner = user.role === "owner" || user.username === OWNER_USERNAME;
  req.ixlTimeLeftMs = timeLeftMs(user);
  req.ixlToken = token;
  next();
});

// ─── self info ──────────────────────────────────────────
app.get("/api/me", async (req, res) => {
  res.json({
    username: req.ixlUser,
    expiresAt: req.ixlUserRecord.expiresAt,
    timeLeftMs: req.ixlTimeLeftMs,
    role: req.ixlUserRecord.role,
    isOwner: req.ixlIsOwner,
    apps: req.ixlUserRecord.apps
  });
});

app.get("/api/my-apps", async (req, res) => {
  const allowed = filterAppsForUser(req.ixlUserRecord);
  res.json({ apps: allowed });
});

// ─── owner: users CRUD ──────────────────────────────────
function requireOwner(req, res, next) {
  if (!req.ixlIsOwner) return res.status(403).json({ error: "owner only" });
  next();
}

app.get("/api/users", requireOwner, async (req, res) => {
  try {
    const users = await listUsers();
    res.json({ users });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/users", requireOwner, async (req, res) => {
  try {
    const { username, password, email, hours, role, apps } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username and password required" });
    const hashed = await hashPassword(password);
    const user = await createUser(username, hashed, email || "", role || "user", hours || 24, apps || ["ixl"]);
    res.json({ ok: true, user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/users/:username/add-time", requireOwner, async (req, res) => {
  try {
    const { hours, note } = req.body || {};
    if (!hours || hours <= 0) return res.status(400).json({ error: "invalid hours" });
    const user = await addTime(req.params.username, hours, note || "");
    res.json({ ok: true, user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/users/:username/set-expiry", requireOwner, async (req, res) => {
  try {
    const { expiresAt } = req.body || {};
    if (!expiresAt) return res.status(400).json({ error: "expiresAt required" });
    const user = await setExpiry(req.params.username, expiresAt);
    res.json({ ok: true, user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/users/:username/role", requireOwner, async (req, res) => {
  try {
    const { role } = req.body || {};
    if (!["user", "admin", "owner"].includes(role)) return res.status(400).json({ error: "bad role" });
    const user = await setRole(req.params.username, role);
    res.json({ ok: true, user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/users/:username/apps", requireOwner, async (req, res) => {
  try {
    const { apps } = req.body || {};
    if (!Array.isArray(apps)) return res.status(400).json({ error: "apps must be array" });
    const user = await setApps(req.params.username, apps);
    res.json({ ok: true, user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/users/:username", requireOwner, async (req, res) => {
  try {
    await deleteUser(req.params.username);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ixl creds ──────────────────────────────────────────
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

// ─── solve ──────────────────────────────────────────────
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

// ─── dataset export ─────────────────────────────────────
app.post("/api/export-dataset", requireOwner, async (req, res) => {
  try {
    const { exportDataset } = await import("./lib/dataset-export.js");
    const result = await exportDataset();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
// HUMANIZE — rewrite AI text to sound human
// ═══════════════════════════════════════════════════════
app.post("/api/humanize", async (req, res) => {
  try {
    const { text, tone, intensity } = req.body || {};
    if (!text || text.length < 20) {
      return res.status(400).json({ error: "text too short" });
    }

    const toneMap = {
      casual: "casual, like you're texting a friend or posting on Reddit",
      professional: "professional but human — like a competent person writing an email, not a corporate press release",
      academic: "academic but human — like a grad student explaining their work to a peer, not a textbook",
      neutral: "neutral, natural, like a thoughtful blog post by an actual person"
    };
    const toneDesc = toneMap[tone] || toneMap.neutral;

    const intensityMap = {
      light: "Light touch. Only fix the obvious robotic patterns.",
      medium: "Medium rewrite. Change sentence structure meaningfully while keeping ideas intact.",
      heavy: "Heavy rewrite. Rework most sentences. Add human rhythm even if it means restructuring paragraphs."
    };
    const intensityDesc = intensityMap[intensity] || intensityMap.medium;

    const sys = `You rewrite AI-generated text so it reads like a real human wrote it. This is not paraphrasing — it's re-humanizing.

RULES:
1. Keep the meaning exactly the same. Do not add facts, opinions, or examples.
2. Match this tone: ${toneDesc}
3. ${intensityDesc}

BANNED words/phrases — never use these:
"delve", "navigating", "landscape", "tapestry", "testament", "furthermore", "moreover",
"in conclusion", "it's important to note", "it's worth noting", "in today's world",
"in the realm of", "when it comes to", "at the end of the day", "let's dive in",
"let's unpack", "more than just", "not just", "pave the way", "stands as", "serves as",
"plays a crucial role", "plays a vital role", "a myriad of", "a plethora of",
"leverage", "robust", "seamless", "cutting-edge", "game-changer", "unlock the potential",
"embark on", "uncover", "shed light on", "shed light", "pave the way for".

BANNED patterns:
- Sentences that all start the same way
- Every paragraph being exactly 3-5 sentences
- Perfect parallel structure across lists
- "Not only X, but also Y" constructions
- Em-dashes used as rhythmic pauses (— every other sentence)
- Perfectly balanced "on one hand... on the other hand"
- Any sentence that ends with a neat summary clause

REQUIRED patterns (do these):
- Mix very short sentences (2-4 words) with longer ones (25-40 words). Aim for high variance.
- Use contractions: don't, it's, you're, we've, can't, won't, that's.
- Start some sentences with And, But, So, Or — real people do this.
- Use casual connectors: "the thing is", "honestly", "look", "here's the deal", "truth is", "anyway", "so yeah", "at least", "though"
- Include a hedge or two: "kind of", "sort of", "I think", "probably", "maybe", "roughly"
- Let one sentence run on a bit longer than it should, with a comma splice or a trailing "which is..."
- Use "you" and "I" where it fits naturally. First-person is human.
- Break one "rule" once — start a sentence with a lowercase word if it feels right, or use a fragment. Real writers do.
- Vary paragraph length. One paragraph can be a single sentence.

OUTPUT: Return ONLY the rewritten text. No preamble, no explanation, no quotes around it.`;

    const geminiKey = await getSecret("GEMINI_API_KEY");
    const groqKey = await getSecret("GROQ_API_KEY");
    const openrouterKey = await getSecret("OPENROUTER_API_KEY");

    const providers = [
      { name: "gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: geminiKey, models: ["gemini-2.5-flash", "gemini-flash-latest"] },
      { name: "groq", baseURL: "https://api.groq.com/openai/v1", apiKey: groqKey, models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"] },
      { name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: openrouterKey, models: ["openrouter/free"] }
    ];

    let lastErr = null;
    for (const p of providers) {
      if (!p.apiKey || /PUT_|your_/i.test(p.apiKey)) continue;
      for (const model of p.models) {
        try {
          const r = await axios.post(p.baseURL.replace(/\/$/, "") + "/chat/completions", {
            model,
            messages: [
              { role: "system", content: sys },
              { role: "user", content: text }
            ],
            temperature: 0.95,
            top_p: 0.95,
            max_tokens: 4000
          }, {
            headers: { Authorization: "Bearer " + p.apiKey, "Content-Type": "application/json" },
            timeout: 45000,
            validateStatus: s => s < 500
          });
          if (r.status >= 400) throw new Error(`http ${r.status}`);
          const out = (r.data?.choices?.[0]?.message?.content || "").trim();
          if (!out) throw new Error("empty response");
          let cleaned = out.replace(/^["']([\s\S]*)["']$/, "$1").trim();
          return res.json({
            text: cleaned,
            source: `${p.name}/${model}`,
            tone: tone || "neutral",
            intensity: intensity || "medium"
          });
        } catch (err) {
          lastErr = err;
          console.warn(`[humanize] ${p.name}/${model} failed: ${err.message}`);
        }
      }
    }
    res.status(500).json({ error: lastErr?.message || "all providers failed" });
  } catch (err) {
    console.error("[humanize]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
// AI-LIKELIHOOD CHECKER — heuristic score 0-100
// ═══════════════════════════════════════════════════════
app.post("/api/ai-check", async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || text.length < 20) return res.status(400).json({ error: "text too short" });

    const signals = [];
    let score = 0;

    const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
    const words = text.trim().split(/\s+/);
    const wordCount = words.length;
    const sentenceCount = sentences.length;

    // 1. Burstiness — variance in sentence length
    const lens = sentences.map(s => s.split(/\s+/).length);
    const avgLen = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
    const variance = lens.reduce((acc, l) => acc + Math.pow(l - avgLen, 2), 0) / (lens.length || 1);
    const stdev = Math.sqrt(variance);
    const burstiness = stdev / (avgLen || 1);
    if (burstiness < 0.4) { score += 20; signals.push(`Low burstiness (${burstiness.toFixed(2)}) — sentences are too uniform in length`); }
    else if (burstiness < 0.55) { score += 10; signals.push(`Moderate burstiness (${burstiness.toFixed(2)}) — could use more variation`); }
    else { signals.push(`Good burstiness (${burstiness.toFixed(2)}) — sentence length varies naturally`); }

    // 2. Banned phrases
    const banned = [
      "delve", "navigating", "landscape", "tapestry", "testament", "furthermore",
      "moreover", "in conclusion", "it's important to note", "it's worth noting",
      "in today's world", "in the realm of", "when it comes to", "let's dive",
      "more than just", "not just", "pave the way", "stands as", "serves as",
      "a myriad of", "a plethora of", "leverage", "robust", "seamless",
      "cutting-edge", "game-changer", "unlock the potential", "embark on",
      "uncover", "shed light on"
    ];
    const lowerText = text.toLowerCase();
    const foundBanned = banned.filter(b => lowerText.includes(b));
    if (foundBanned.length > 0) {
      score += Math.min(30, foundBanned.length * 8);
      signals.push(`Contains ${foundBanned.length} AI-tell phrase(s): ${foundBanned.slice(0, 5).join(", ")}`);
    } else {
      signals.push("No obvious AI-tell phrases detected");
    }

    // 3. Contractions
    const contractionCount = (lowerText.match(/\b\w+'(s|t|re|ve|ll|d|m)\b/g) || []).length;
    const contractionRate = contractionCount / (wordCount || 1);
    if (contractionRate < 0.01) { score += 15; signals.push("Very few contractions — human writing almost always has some"); }
    else if (contractionRate < 0.02) { score += 5; signals.push("Some contractions, could use more"); }
    else { signals.push("Good contraction usage"); }

    // 4. First/second person pronouns
    const youWe = (lowerText.match(/\b(i|i'm|i've|i'll|you|you're|we|we're|we've|my|our|your)\b/g) || []).length;
    const youWeRate = youWe / (wordCount || 1);
    if (youWeRate < 0.005) { score += 10; signals.push("No first/second person — feels distant and report-like"); }
    else { signals.push("Uses first/second person — feels personal"); }

    // 5. Casual connectors
    const casual = ["honestly", "look,", "the thing is", "here's the deal", "truth is", "anyway", "so yeah", "at least", "though", "kind of", "sort of", "pretty much", "a bit"];
    const casualCount = casual.filter(c => lowerText.includes(c)).length;
    if (casualCount === 0) { score += 10; signals.push("No casual connectors — sounds like a manual"); }
    else { signals.push(`Found ${casualCount} casual connector(s)`); }

    // 6. Sentence starting variety
    const starts = sentences.map(s => s.trim().split(/\s+/)[0]?.toLowerCase() || "").filter(Boolean);
    const uniqueStarts = new Set(starts).size;
    const startVariety = uniqueStarts / (starts.length || 1);
    if (startVariety < 0.6) { score += 10; signals.push(`Sentences start too similarly (${uniqueStarts}/${starts.length} unique)`); }
    else { signals.push("Good variety in sentence openings"); }

    if (wordCount < 40) signals.push("Text is short — heuristics are less reliable under 40 words");

    score = Math.max(0, Math.min(100, score));

    let verdict = "Likely human";
    if (score >= 60) verdict = "Likely AI-generated";
    else if (score >= 35) verdict = "Mixed signals — could pass as human but risky";
    else if (score >= 20) verdict = "Probably human";

    res.json({
      score,
      verdict,
      signals,
      meta: {
        wordCount,
        sentenceCount,
        avgLen: avgLen.toFixed(1),
        burstiness: burstiness.toFixed(2)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
// SESSION start / status / end
// ═══════════════════════════════════════════════════════
app.post("/api/session/start", async (req, res) => {
  try {
    const user = req.ixlUser;
    if (!user) return res.status(401).json({ error: "not logged in" });
    const { url } = req.body || {};
    const userToken = req.ixlToken || "";

    if (url) {
      const appId = detectAppFromUrl(url);
      if (appId) {
        if (!userCanUseApp(req.ixlUserRecord, appId)) {
          return res.status(403).json({ error: "app_not_allowed", app: appId });
        }
      } else {
        if (!userCanUseApp(req.ixlUserRecord, "unblock")) {
          return res.status(403).json({ error: "unblock_not_allowed" });
        }
      }
    }

    const existing = getSession(user);
    if (existing) {
      touchSession(user);
      if (url && existing.browser !== "firefox") {
        try {
          await safeNavigate(existing.debugUrl, url, existing.browser);
          console.log(`[session/start] navigated existing ${user} → ${url}`);
        } catch (err) {
          console.warn(`[session/start] navigate existing: ${err.message}`);
        }
      }
      return res.json({
        ok: true, ready: true,
        wsPath: `/session/ws/${user}`,
        sessionId: existing.sessionId
      });
    }

    const info = getQueueInfo(user);
    if (info.inQueue) {
      return res.json({
        ok: true, ready: false,
        position: info.position,
        totalActive: info.totalActive,
        maxActive: info.maxActive,
        queued: info.queued
      });
    }

    const promise = getOrCreateSession(user, {
      url: url || "https://www.ixl.com/",
      token: userToken
    });
    const result = await Promise.race([
      promise.then(s => ({ ready: true, sessionId: s.sessionId })),
      new Promise(r => setTimeout(() => r({ ready: false, pending: true }), 500))
    ]);

    if (result.ready) {
      touchSession(user);
      return res.json({ ok: true, ready: true, wsPath: `/session/ws/${user}`, sessionId: result.sessionId });
    }

    promise.catch(() => { });
    const info2 = getQueueInfo(user);
    res.json({
      ok: true, ready: false,
      position: info2.position,
      totalActive: info2.totalActive,
      maxActive: info2.maxActive,
      queued: info2.queued
    });
  } catch (err) {
    console.error("[session/start]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/session/status", async (req, res) => {
  try {
    const user = req.ixlUser;
    if (!user) return res.status(401).json({ error: "not logged in" });
    const s = getSession(user);
    if (s) {
      touchSession(user);
      return res.json({ ok: true, ready: true, sessionId: s.sessionId, wsPath: `/session/ws/${user}` });
    }
    const info = getQueueInfo(user);
    res.json({
      ok: true, ready: false,
      position: info.position,
      totalActive: info.totalActive,
      maxActive: info.maxActive,
      queued: info.queued
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/session/end", async (req, res) => {
  try {
    const user = req.ixlUser;
    const s = getSession(user);
    if (s) await killSession(s.sessionId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── navigate inside own session ────────────────────────
app.post("/api/navigate", async (req, res) => {
  const t0 = Date.now();
  try {
    const user = req.ixlUser;
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: "no url" });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "only http/https allowed" });

    const appId = detectAppFromUrl(url);
    if (appId) {
      if (!userCanUseApp(req.ixlUserRecord, appId)) {
        return res.status(403).json({ error: "app_not_allowed", app: appId });
      }
    } else {
      if (!userCanUseApp(req.ixlUserRecord, "unblock")) {
        return res.status(403).json({ error: "unblock_not_allowed" });
      }
    }

    const s = getSession(user);
    if (!s) return res.status(409).json({ error: "no active session" });

    touchSession(user);

    if (s.browser === "firefox") {
      return res.status(200).json({
        ok: true,
        unsupported: true,
        reason: "firefox_manual",
        message: "Firefox sessions navigate manually — open the URL in the VNC window."
      });
    }

    await safeNavigate(s.debugUrl, url, s.browser);
    console.log(`[navigate] ${user} → ${url} (${Date.now() - t0}ms)`);
    res.json({ ok: true, dispatched: Date.now() - t0 });
  } catch (err) {
    console.error("[navigate]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── noVNC package.json intercept ───────────────────────
app.get("/session/vnc/:user/package.json", (req, res) => {
  res.json({ name: "novnc", version: "1.5.0" });
});

// ─── VNC HTTP proxy ─────────────────────────────────────
app.get("/session/vnc/:user/*", async (req, res) => {
  const username = req.params.user;
  const s = getSession(username);
  if (!s) return res.status(404).send("no session");
  touchSession(username);

  const subPath = "/" + (req.params[0] || "");
  const opts = {
    method: req.method,
    host: "127.0.0.1",
    port: s.ports.wsPort,
    path: subPath || "/vnc.html",
    headers: { ...req.headers, host: `127.0.0.1:${s.ports.wsPort}` }
  };
  const proxyReq = http.request(opts, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on("error", () => { if (!res.headersSent) res.status(502).send("vnc err"); });
  req.pipe(proxyReq);
});

// ─── VNC websocket proxy ────────────────────────────────
const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  const m = req.url.match(/^\/session\/ws\/([^/?]+)/);
  if (!m) return socket.destroy();
  const username = decodeURIComponent(m[1]);
  const s = getSession(username);
  if (!s) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    return socket.destroy();
  }
  touchSession(username);

  const backendPath = "/websockify";
  const headers = { ...req.headers, host: `127.0.0.1:${s.ports.wsPort}` };
  delete headers["content-length"];

  const proxyReq = http.request({
    host: "127.0.0.1",
    port: s.ports.wsPort,
    method: "GET",
    path: backendPath,
    headers
  });

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

// ─── legacy VNC paths ───────────────────────────────────
app.get("/vnc/*", (req, res) => res.status(410).send("use /session/*"));
app.get("/vnc", (req, res) => res.status(410).send("use /session/*"));

// ─── boot ───────────────────────────────────────────────
const port = process.env.PORT || config.server.port || 3000;
const host = process.env.PORT ? "0.0.0.0" : (config.server.host || "127.0.0.1");

server.listen(port, host, async () => {
  console.log(`[ixl-server] http://${host}:${port}`);
  console.log(`[ixl-server] capacity: ${sessionStats().max} sessions`);
  try { await loadSecrets(); console.log("[ixl-server] secrets loaded"); } catch (_) { }
  try { await ensureInjected(); console.log("[ixl-server] inject started"); } catch (err) { console.error("[ixl-server] inject:", err.message); }
});