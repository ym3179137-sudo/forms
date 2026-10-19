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
  startSession, getSession, getQueueInfo, killSession, stats as sessionStats, touchSession
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
app.set("trust proxy", 1);
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

// ─── rate limiting ──────────────────────────────────────
const rateLimits = new Map();
function rateLimit(windowMs, maxRequests) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    let entry = rateLimits.get(ip);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      rateLimits.set(ip, entry);
    }
    entry.count++;
    if (entry.count > maxRequests) {
      return res.status(429).json({ error: "too many requests" });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimits) if (now > v.resetAt) rateLimits.delete(k);
}, 60000);

// ─── SSRF guard ─────────────────────────────────────────
function isSafeUrl(raw) {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") return false;
    if (/^127\./.test(host)) return false;
    if (/^10\./.test(host)) return false;
    if (/^192\.168\./.test(host)) return false;
    if (/^169\.254\./.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (/^(fc|fd|fe80)/i.test(host)) return false;
    return true;
  } catch { return false; }
}

const OPEN_PATHS = new Set([
  "/api/health", "/api/login", "/api/signup", "/api/sso", "/api/verify",
  "/api/feedback", "/enter"
]);

// ─── auth ───────────────────────────────────────────────
// Direct login is DISABLED. All logins go through CyberVault's SSO.
app.post("/api/login", rateLimit(60 * 1000, 10), async (req, res) => {
  return res.status(410).json({ error: "Direct login disabled. Sign in via CyberVault." });
});

app.post("/api/signup", rateLimit(60 * 1000, 10), async (req, res) => {
  return res.status(410).json({ error: "Sign up at CyberVault, not here." });
});

app.get("/enter", async (req, res) => {
  try {
    const { t, s, redirect } = req.query;
    if (!t || !s) return res.status(400).send("missing sso params");
    const result = await ssoLogin(t, s);
    if (!result.ok) {
      console.log(`[sso] rejected: ${result.error}`);
      return res.status(401).send("sso failed: " + result.error);
    }
    console.log(`[sso] login ${result.username} (site=${result.site})`);
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

app.get("/api/verify", async (req, res) => {
  try {
    const token = req.headers["x-ixl-token"] || req.query.token;
    const payload = await verify(token);
    if (!payload) return res.status(401).json({ valid: false });
    res.json({ valid: true, username: payload.u });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ─── solve (Wayground blocked) ──────────────────────────
app.post("/api/solve", rateLimit(60 * 1000, 60), async (req, res) => {
  try {
    const referer = (req.headers["referer"] || "").toString();
    if (/wayground\.com|quizizz\.com/i.test(referer)) {
      return res.status(403).json({ error: "solver_disabled_for_this_site" });
    }
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

app.post("/api/solve-form", rateLimit(60 * 1000, 30), async (req, res) => {
  try {
    const referer = (req.headers["referer"] || "").toString();
    if (/wayground\.com|quizizz\.com/i.test(referer)) {
      return res.status(403).json({ error: "solver_disabled_for_this_site" });
    }
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

// ─── humanize ───────────────────────────────────────────
app.post("/api/humanize", rateLimit(60 * 1000, 20), async (req, res) => {
  try {
    const { text, tone, intensity } = req.body || {};
    if (!text || text.length < 20) {
      return res.status(400).json({ error: "text too short" });
    }

    const toneMap = {
      casual: "casual — like you're texting a friend or posting on Reddit",
      professional: "professional but human — like a competent person writing an email, not a corporate press release",
      academic: "academic but human — like a grad student explaining their work to a peer, not a textbook",
      neutral: "neutral, natural — like a thoughtful blog post by an actual person"
    };
    const toneDesc = toneMap[tone] || toneMap.neutral;

    const intensityMap = {
      light: "Light touch. Only fix the obvious robotic patterns.",
      medium: "Medium rewrite. Change sentence structure meaningfully while keeping ideas intact.",
      heavy: "Heavy rewrite. Rework most sentences. Add human rhythm even if it means restructuring paragraphs."
    };
    const intensityDesc = intensityMap[intensity] || intensityMap.medium;

    const sys = `You rewrite AI-generated text so it reads like a real human wrote it. Not paraphrasing — re-humanizing.

RULES:
1. Keep the meaning exactly the same. Do not add facts or opinions.
2. Match this tone: ${toneDesc}
3. ${intensityDesc}

BANNED words/phrases — never use:
"delve", "navigating", "landscape", "tapestry", "testament", "furthermore", "moreover",
"in conclusion", "it's important to note", "it's worth noting", "in today's world",
"in the realm of", "when it comes to", "at the end of the day", "let's dive in",
"let's unpack", "more than just", "not just", "pave the way", "stands as", "serves as",
"plays a crucial role", "plays a vital role", "a myriad of", "a plethora of",
"leverage", "robust", "seamless", "cutting-edge", "game-changer", "unlock the potential",
"embark on", "uncover", "shed light on", "pave the way for".

BANNED patterns:
- All sentences starting the same way
- Every paragraph being exactly 3-5 sentences
- Perfect parallel structure across lists
- "Not only X, but also Y"
- Em-dashes used as rhythmic pauses
- Balanced "on one hand / on the other hand"
- Sentences ending with neat summary clauses

REQUIRED patterns:
- Mix very short sentences (2-4 words) with longer ones (25-40 words). High variance is the point.
- Use contractions: don't, it's, you're, we've, can't, won't, that's.
- Start some sentences with And, But, So, Or — real people do this.
- Use casual connectors: "the thing is", "honestly", "look", "here's the deal", "truth is", "anyway", "so yeah", "at least", "though".
- Include a hedge or two: "kind of", "sort of", "I think", "probably", "maybe", "roughly".
- Let one sentence run on longer than it should, with a trailing "which is..." or a comma splice.
- Use "you" and "I" where it fits.
- Break one rule once — start a sentence lowercase, or use a fragment.
- Vary paragraph length. One paragraph can be a single sentence.

OUTPUT: Return ONLY the rewritten text. No preamble. No explanation. No quotes around it.`;

    const geminiKey = await getSecret("GEMINI_API_KEY");
    const groqKey = await getSecret("GROQ_API_KEY");
    const openrouterKey = await getSecret("OPENROUTER_API_KEY");

    const providers = [
      { name: "gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: geminiKey, models: ["gemini-2.5-flash", "gemini-flash-latest"] },
      { name: "groq", baseURL: "https://api.groq.com/openai/v1", apiKey: groqKey, models: ["openai/gpt-oss-120b", "openai/gpt-oss-20b"] },
      { name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: openrouterKey, models: ["openrouter/free"] }
    ];

    let rawOut = "";
    let usedProvider = "";
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
          rawOut = out.replace(/^["']([\s\S]*)["']$/, "$1").trim();
          usedProvider = `${p.name}/${model}`;
          break;
        } catch (err) {
          lastErr = err;
          console.warn(`[humanize] ${p.name}/${model} failed: ${err.message}`);
        }
      }
      if (rawOut) break;
    }

    if (!rawOut) {
      return res.status(500).json({ error: lastErr?.message || "all providers failed" });
    }

    const { text: finalText, stats } = postProcessHumanize(rawOut, intensity || "medium");

    res.json({
      text: finalText,
      source: usedProvider,
      tone: tone || "neutral",
      intensity: intensity || "medium",
      stats
    });
  } catch (err) {
    console.error("[humanize]", err.message);
    res.status(500).json({ error: err.message });
  }
});

function postProcessHumanize(input, intensity) {
  let t = String(input || "").trim();

  const bannedRegexes = [
    /\bfurthermore,?\s+/gi,
    /\bmoreover,?\s+/gi,
    /\bin conclusion,?\s+/gi,
    /\bit'?s important to note that\s+/gi,
    /\bit'?s worth noting that\s+/gi,
    /\bin today'?s world,?\s+/gi,
    /\bwhen it comes to\s+/gi,
    /\bat the end of the day,?\s+/gi,
    /\blet'?s dive in[.,]?\s*/gi,
    /\blet'?s unpack\s+/gi,
    /\bmore than just\s+/gi,
    /\bnot only\s+([^,]+),\s+but also\s+/gi,
    /\bpave[sd]? the way\s+/gi,
    /\bstands as\s+/gi,
    /\bserves as\s+/gi,
    /\bplays a (crucial|vital|key) role in\s+/gi,
    /\ba myriad of\s+/gi,
    /\ba plethora of\s+/gi,
    /\bleverage\b/gi,
    /\bseamless(ly)?\b/gi,
    /\bcutting-edge\b/gi,
    /\bgame-?changer\b/gi,
    /\bunlock the potential\s+/gi,
    /\bembark on\s+/gi,
    /\bshed light on\s+/gi,
    /\bdelve[sd]? into\s+/gi,
    /\bnavigating the\s+/gi
  ];
  for (const re of bannedRegexes) {
    t = t.replace(re, (m) => {
      if (/not only/i.test(m)) return "And ";
      return "";
    });
  }

  t = t.replace(/\s+/g, " ").replace(/\s+([.,!?;:])/g, "$1").trim();

  let sentences = t.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);

  function stats(arr) {
    if (!arr.length) return { mean: 0, stdev: 0, ratio: 0 };
    const lens = arr.map(s => s.split(/\s+/).length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((acc, l) => acc + Math.pow(l - mean, 2), 0) / lens.length;
    const stdev = Math.sqrt(variance);
    return { mean, stdev, ratio: stdev / (mean || 1) };
  }

  let s = stats(sentences);
  const targetRatio = intensity === "heavy" ? 0.85 : intensity === "medium" ? 0.7 : 0.55;
  let safety = 0;

  while (s.ratio < targetRatio && safety < 20 && sentences.length > 3) {
    safety++;
    const lens = sentences.map(x => x.split(/\s+/).length);
    const maxIdx = lens.indexOf(Math.max(...lens));
    const minIdx = lens.indexOf(Math.min(...lens));

    if (lens[maxIdx] > 20) {
      const longSentence = sentences[maxIdx];
      const splitAt = findSplitPoint(longSentence);
      if (splitAt > 0) {
        const a = longSentence.slice(0, splitAt).trim().replace(/[,;]\s*$/, "") + ".";
        const b = longSentence.slice(splitAt).trim().replace(/^[,;]\s*/, "");
        if (b.length > 5) {
          sentences.splice(maxIdx, 1, a, b);
          s = stats(sentences);
          continue;
        }
      }
    }

    if (lens[minIdx] < 8 && minIdx < sentences.length - 1) {
      const merged = sentences[minIdx].replace(/[.!?]\s*$/, "") + ", and " + sentences[minIdx + 1].replace(/^[A-Z]/, (c) => c.toLowerCase());
      sentences.splice(minIdx, 2, merged);
      s = stats(sentences);
      continue;
    }

    break;
  }

  const connectors = ["Honestly, ", "Look, ", "The thing is, ", "Truth is, ", "Anyway, "];
  let hasConnector = /\b(honestly|look,|the thing is|truth is|anyway)\b/i.test(sentences.join(" "));
  if (!hasConnector && sentences.length >= 4) {
    const idx = Math.min(2, sentences.length - 1);
    const c = connectors[Math.floor(Math.random() * connectors.length)];
    sentences[idx] = c + sentences[idx].replace(/^[A-Z]/, (ch) => ch.toLowerCase());
  }

  const hedges = ["kind of", "sort of", "probably", "maybe", "I think", "roughly"];
  let hasHedge = /\b(kind of|sort of|probably|maybe|i think|roughly)\b/i.test(sentences.join(" "));
  if (!hasHedge && sentences.length >= 5) {
    const idx = Math.floor(sentences.length / 2);
    const h = hedges[Math.floor(Math.random() * hedges.length)];
    sentences[idx] = sentences[idx].replace(/^([A-Z][a-z]+) /, (m, w) => `${w} ${h} `);
  }

  let out = sentences.join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/([.!?])\s+([a-z])/g, (m, p, c) => `${p} ${c.toUpperCase()}`)
    .trim();

  const stillBanned = /\b(delve|navigat|landscape|tapestry|testament|furthermore|moreover|leverage|seamless|robust|cutting-edge)\b/i;
  if (stillBanned.test(out)) {
    out = out.replace(/\b(delve[sd]?|navigat(e|ing|ed)|landscape[s]?|tapestry|testament[s]?|furthermore|moreover|leverage[sd]?|seamless(ly)?|robust|cutting-edge)\b\s*/gi, "");
    out = out.replace(/\s+/g, " ").trim();
  }

  const finalStats = stats(out.split(/(?<=[.!?])\s+/).filter(x => x.trim().length > 0));
  const wordCount = out.split(/\s+/).length;
  const sentenceCount = out.split(/(?<=[.!?])\s+/).filter(x => x.trim().length > 0).length;

  return {
    text: out,
    stats: {
      wordCount,
      sentenceCount,
      avgLen: finalStats.mean.toFixed(1),
      burstiness: finalStats.ratio.toFixed(2)
    }
  };
}

function findSplitPoint(sentence) {
  const clean = sentence.trim();
  const words = clean.split(/\s+/);
  if (words.length < 14) return -1;
  const mid = Math.floor(clean.length / 2);

  const candidates = [
    { re: /,\s+(and|but|so|because|which|while)\s+/g, offset: 1 },
    { re: /;\s+/g, offset: 0 },
    { re: /,\s+/g, offset: 0 }
  ];

  let best = -1;
  let bestDist = Infinity;

  for (const c of candidates) {
    let m;
    c.re.lastIndex = 0;
    while ((m = c.re.exec(clean)) !== null) {
      const at = m.index + c.offset;
      if (at < 8 || at > clean.length - 8) continue;
      const dist = Math.abs(at - mid);
      if (dist < bestDist) { bestDist = dist; best = at; }
    }
  }
  if (best < 0) return -1;

  const before = clean.slice(0, best).trim();
  const after = clean.slice(best).trim().replace(/^[,;]\s*/, "");
  if (before.split(/\s+/).length < 5 || after.split(/\s+/).length < 5) return -1;
  return before.length;
}

// ─── AI-likelihood checker ──────────────────────────────
app.post("/api/ai-check", rateLimit(60 * 1000, 30), async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || text.length < 20) return res.status(400).json({ error: "text too short" });

    const signals = [];
    let score = 0;

    const sentences = text.split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
    const words = text.trim().split(/\s+/);
    const wordCount = words.length;
    const sentenceCount = sentences.length;

    const lens = sentences.map(s => s.split(/\s+/).length);
    const avgLen = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
    const variance = lens.reduce((acc, l) => acc + Math.pow(l - avgLen, 2), 0) / (lens.length || 1);
    const stdev = Math.sqrt(variance);
    const burstiness = stdev / (avgLen || 1);
    if (burstiness < 0.4) { score += 20; signals.push(`Low burstiness (${burstiness.toFixed(2)}) — sentences are too uniform in length`); }
    else if (burstiness < 0.55) { score += 10; signals.push(`Moderate burstiness (${burstiness.toFixed(2)}) — could use more variation`); }
    else { signals.push(`Good burstiness (${burstiness.toFixed(2)}) — sentence length varies naturally`); }

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

    const contractionCount = (lowerText.match(/\b\w+'(s|t|re|ve|ll|d|m)\b/g) || []).length;
    const contractionRate = contractionCount / (wordCount || 1);
    if (contractionRate < 0.01) { score += 15; signals.push("Very few contractions — human writing almost always has some"); }
    else if (contractionRate < 0.02) { score += 5; signals.push("Some contractions, could use more"); }
    else { signals.push("Good contraction usage"); }

    const youWe = (lowerText.match(/\b(i|i'm|i've|i'll|you|you're|we|we're|we've|my|our|your)\b/g) || []).length;
    const youWeRate = youWe / (wordCount || 1);
    if (youWeRate < 0.005) { score += 10; signals.push("No first/second person — feels distant and report-like"); }
    else { signals.push("Uses first/second person — feels personal"); }

    const casual = ["honestly", "look,", "the thing is", "here's the deal", "truth is", "anyway", "so yeah", "at least", "though", "kind of", "sort of", "pretty much", "a bit"];
    const casualCount = casual.filter(c => lowerText.includes(c)).length;
    if (casualCount === 0) { score += 10; signals.push("No casual connectors — sounds like a manual"); }
    else { signals.push(`Found ${casualCount} casual connector(s)`); }

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
      score, verdict, signals,
      meta: {
        wordCount, sentenceCount,
        avgLen: avgLen.toFixed(1),
        burstiness: burstiness.toFixed(2)
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
// SESSION endpoints — PER-APP isolated
// ═══════════════════════════════════════════════════════

app.post("/api/session/start", async (req, res) => {
  try {
    const user = req.ixlUser;
    if (!user) return res.status(401).json({ error: "not logged in" });
    const { url } = req.body || {};
    const userToken = req.ixlToken || "";

    const targetUrl = url || "https://www.ixl.com/";
    if (!isSafeUrl(targetUrl)) {
      return res.status(400).json({ error: "unsafe_url" });
    }

    const appId = detectAppFromUrl(targetUrl) || "unblock";

    if (appId !== "unblock") {
      if (!userCanUseApp(req.ixlUserRecord, appId)) {
        return res.status(403).json({ error: "app_not_allowed", app: appId });
      }
    } else {
      if (!userCanUseApp(req.ixlUserRecord, "unblock")) {
        return res.status(403).json({ error: "unblock_not_allowed" });
      }
    }

    const existing = getSession(user, appId);
    if (existing) {
      touchSession(user, appId);
      return res.json({
        ok: true, ready: true,
        wsPath: `/session/ws/${encodeURIComponent(user)}/${encodeURIComponent(appId)}`,
        sessionId: existing.sessionId,
        appId
      });
    }

    const info = getQueueInfo(user, appId);
    if (info.inQueue) {
      return res.json({
        ok: true, ready: false,
        position: info.position,
        totalActive: info.totalActive,
        maxActive: info.maxActive,
        queued: info.queued,
        appId
      });
    }

    const promise = startSession(user, { url: targetUrl, token: userToken, appId });
    const result = await Promise.race([
      promise.then(s => ({ ready: true, sessionId: s.sessionId })),
      new Promise(r => setTimeout(() => r({ ready: false, pending: true }), 500))
    ]);

    if (result.ready) {
      touchSession(user, appId);
      return res.json({
        ok: true, ready: true,
        wsPath: `/session/ws/${encodeURIComponent(user)}/${encodeURIComponent(appId)}`,
        sessionId: result.sessionId,
        appId
      });
    }

    promise.catch(() => { });
    const info2 = getQueueInfo(user, appId);
    res.json({
      ok: true, ready: false,
      position: info2.position,
      totalActive: info2.totalActive,
      maxActive: info2.maxActive,
      queued: info2.queued,
      appId
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

    const appId = req.query.appId || detectAppFromUrl(req.query.url || "") || "unblock";
    const s = getSession(user, appId);
    if (s) {
      touchSession(user, appId);
      return res.json({
        ok: true, ready: true,
        sessionId: s.sessionId,
        wsPath: `/session/ws/${encodeURIComponent(user)}/${encodeURIComponent(appId)}`,
        appId
      });
    }
    const info = getQueueInfo(user, appId);
    res.json({
      ok: true, ready: false,
      position: info.position,
      totalActive: info.totalActive,
      maxActive: info.maxActive,
      queued: info.queued,
      appId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/session/end", async (req, res) => {
  try {
    const user = req.ixlUser;
    const appId = (req.body && req.body.appId) || req.query.appId || "unblock";
    const s = getSession(user, appId);
    if (s) await killSession(s.sessionId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/navigate", async (req, res) => {
  const t0 = Date.now();
  try {
    const user = req.ixlUser;
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: "no url" });
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: "only http/https allowed" });
    if (!isSafeUrl(url)) return res.status(400).json({ error: "unsafe_url" });

    const appId = detectAppFromUrl(url) || "unblock";

    if (appId !== "unblock") {
      if (!userCanUseApp(req.ixlUserRecord, appId)) {
        return res.status(403).json({ error: "app_not_allowed", app: appId });
      }
    } else {
      if (!userCanUseApp(req.ixlUserRecord, "unblock")) {
        return res.status(403).json({ error: "unblock_not_allowed" });
      }
    }

    const s = getSession(user, appId);
    if (!s) return res.status(409).json({ error: "no active session", appId });

    touchSession(user, appId);

    if (s.browser === "firefox") {
      return res.status(200).json({
        ok: true,
        unsupported: true,
        reason: "firefox_manual",
        message: "Firefox sessions navigate manually — open the URL in the VNC window."
      });
    }

    await safeNavigate(s.debugUrl, url, s.browser);
    console.log(`[navigate] ${user}/${appId} → ${url} (${Date.now() - t0}ms)`);
    res.json({ ok: true, dispatched: Date.now() - t0 });
  } catch (err) {
    console.error("[navigate]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── noVNC package.json intercept ───────────────────────
app.get("/session/vnc/:user/:appId/package.json", (req, res) => {
  res.json({ name: "novnc", version: "1.5.0" });
});
app.get("/session/vnc/:user/package.json", (req, res) => {
  res.json({ name: "novnc", version: "1.5.0" });
});

// ─── helper: resolve session from URL params ────────────
function resolveSession(username, appId) {
  if (appId) return getSession(username, appId);
  // legacy: find any session for this user (first match)
  const allApps = ["ixl", "blooket", "wayground", "kahoot", "forms", "unblock"];
  for (const a of allApps) {
    const s = getSession(username, a);
    if (s) return s;
  }
  return null;
}

// ─── VNC HTTP proxy ─────────────────────────────────────
app.get("/session/vnc/:user/:appId/*", async (req, res) => {
  const username = req.params.user;
  const appId = req.params.appId;
  const s = resolveSession(username, appId);
  if (!s) return res.status(404).send("no session");
  touchSession(username, s.appId);

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

// Legacy: /session/vnc/:user/* without appId
app.get("/session/vnc/:user/*", async (req, res) => {
  const username = req.params.user;
  const s = resolveSession(username, null);
  if (!s) return res.status(404).send("no session");
  touchSession(username, s.appId);

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
  // Try /session/ws/:user/:appId first, fall back to /session/ws/:user
  let username = null;
  let appId = null;
  let m = req.url.match(/^\/session\/ws\/([^/?]+)\/([^/?]+)/);
  if (m) {
    username = decodeURIComponent(m[1]);
    appId = decodeURIComponent(m[2]);
  } else {
    m = req.url.match(/^\/session\/ws\/([^/?]+)/);
    if (m) username = decodeURIComponent(m[1]);
  }
  if (!username) return socket.destroy();

  const s = resolveSession(username, appId);
  if (!s) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    return socket.destroy();
  }
  touchSession(username, s.appId);

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