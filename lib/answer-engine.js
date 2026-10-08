import axios from "axios";
import https from "https";
import http from "http";
import { getSecret } from "./keys.js";

const RESEARCH_PROMPT = `You are a RESEARCH assistant that finds the correct IXL answer. You do NOT guess.

For every question:
1. CLASSIFY: FACT / COMPUTE / COMPREHENSION / GRAMMAR / VISUAL.
2. Solve it. If math, verify by substituting back. If reading, cite the supporting sentence.
3. Return ONLY valid JSON, no prose.

Schema:
- multiple_choice: {"type":"multiple_choice","answer_index":<0-based int>,"confidence":<0-1>,"reasoning":"<1 sentence>"}
- fill_in: {"type":"fill_in","value":"<string>","confidence":<0-1>,"reasoning":"<1 sentence>"}
- drag_drop: {"type":"drag_drop","placements":[{"tile":"<text>","target":"<text>"}],"confidence":<0-1>,"reasoning":"<1 sentence>"}
- visual: {"type":"visual","answer_index":<int or null>,"value":"<string or null>","confidence":<0-1>,"reasoning":"<1 sentence>"}

Confidence: 0.95 certain, 0.85 very confident, 0.7 pretty sure, 0.5 guessing.
Never refuse. Never add prose outside the JSON.`;

const VERIFIER_PROMPT = `You are an IXL answer verifier. Given a question and candidates, decide the correct final answer.
Independently solve first, then compare. Return ONLY valid JSON matching the schema.
If no candidate matches your independent answer, return YOUR answer with confidence 0.85.`;

const httpsAgent = new https.Agent({ keepAlive: true });
const httpAgent = new http.Agent({ keepAlive: true });

const REQUEST_TIMEOUT_MS = 20000;
const TOTAL_BUDGET_MS = 30000;
const MIN_CONFIDENCE_TO_SHIP = 0.5;

function buildProviders(geminiKey, groqKey, openrouterKey) {
    return [
        {
            name: "gemini",
            baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
            apiKey: geminiKey,
            jsonMode: false,
            models: ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"]
        },
        {
            name: "groq",
            baseURL: "https://api.groq.com/openai/v1",
            apiKey: groqKey,
            jsonMode: true,
            models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"]
        },
        {
            name: "openrouter",
            baseURL: "https://openrouter.ai/api/v1",
            apiKey: openrouterKey,
            jsonMode: true,
            models: ["openrouter/free"]
        }
    ];
}

async function callOne(provider, model, systemPrompt, userContent, temperature, maxTokens, useJsonMode) {
    const url = provider.baseURL.replace(/\/$/, "") + "/chat/completions";
    const body = {
        model,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent }
        ],
        temperature,
        max_tokens: maxTokens
    };
    if (useJsonMode) body.response_format = { type: "json_object" };

    const res = await axios.post(url, body, {
        headers: { "Authorization": "Bearer " + provider.apiKey, "Content-Type": "application/json" },
        timeout: REQUEST_TIMEOUT_MS,
        httpAgent,
        httpsAgent,
        validateStatus: (s) => s >= 200 && s < 500
    });

    if (res.status >= 400) {
        throw new Error(`http ${res.status}: ${JSON.stringify(res.data).slice(0, 130)}`);
    }
    const raw = res.data?.choices?.[0]?.message?.content;
    return safeParseJSON(raw);
}

export async function getAnswer(question, cfg) {
    const t0 = Date.now();
    const textBlock = buildTextBlock(question);
    const userContent = buildUserContent(question, textBlock);

    const geminiKey = await getSecret("GEMINI_API_KEY");
    const groqKey = await getSecret("GROQ_API_KEY");
    const openrouterKey = await getSecret("OPENROUTER_API_KEY");

    const providers = buildProviders(geminiKey, groqKey, openrouterKey);
    const temperature = 0.1;
    const maxTokens = 800;

    const candidates = [];
    let attempts = 0;

    // ─── ROUND 1: ask up to 3 models independently ─────────
    outer:
    for (const provider of providers) {
        if (!provider.apiKey || /PUT_|your_/i.test(provider.apiKey)) continue;
        const useJsonMode = provider.jsonMode !== false;

        for (const model of provider.models) {
            if (Date.now() - t0 > TOTAL_BUDGET_MS * 0.6) break outer;
            if (candidates.length >= 3) break outer;

            for (const withJson of [useJsonMode, false]) {
                if (Date.now() - t0 > TOTAL_BUDGET_MS * 0.6) break outer;
                attempts++;
                try {
                    const a = await callOne(provider, model, RESEARCH_PROMPT, userContent, temperature, maxTokens, withJson);
                    const norm = normalizeAnswer(a);
                    candidates.push({ source: `${provider.name}/${model}`, answer: norm });
                    console.log(`[research] candidate ${candidates.length} ${provider.name}/${model} conf=${norm.confidence}`);
                    break; // don't try same model twice
                } catch (err) {
                    console.warn(`[research] ✗ ${provider.name}/${model}${withJson ? " (json)" : ""} ${err.message.slice(0, 80)}`);
                }
            }
        }
    }

    if (candidates.length === 0) {
        throw new Error(`no candidates after ${attempts} attempts / ${Date.now() - t0}ms`);
    }

    // ─── early exit: unanimous with high confidence ────────
    if (candidates.length >= 2) {
        const keys = candidates.map(c => JSON.stringify(stripMeta(c.answer)));
        const allSame = keys.every(k => k === keys[0]);
        const avgConf = candidates.reduce((s, c) => s + (c.answer.confidence || 0), 0) / candidates.length;
        if (allSame && avgConf >= 0.85) {
            console.log(`[research] ✓ unanimous conf=${avgConf.toFixed(2)} / ${Date.now() - t0}ms`);
            return { ...candidates[0].answer, confidence: Math.min(1, avgConf + 0.05), source: "unanimous" };
        }
    }

    // ─── ROUND 2: verifier decides ─────────────────────────
    const verifierContent = buildVerifierContent(textBlock, candidates);

    for (const provider of providers) {
        if (!provider.apiKey || /PUT_|your_/i.test(provider.apiKey)) continue;
        const useJsonMode = provider.jsonMode !== false;

        for (const model of provider.models) {
            if (Date.now() - t0 > TOTAL_BUDGET_MS) break;
            attempts++;
            try {
                const v = await callOne(provider, model, VERIFIER_PROMPT, verifierContent, 0.1, maxTokens, useJsonMode);
                const norm = normalizeAnswer(v);
                if (norm.confidence >= MIN_CONFIDENCE_TO_SHIP) {
                    console.log(`[research] ✓ verifier ${provider.name}/${model} conf=${norm.confidence} / ${Date.now() - t0}ms`);
                    return { ...norm, source: "verifier" };
                }
                console.warn(`[research] verifier low conf ${norm.confidence}, trying next`);
            } catch (err) {
                console.warn(`[research] verifier ✗ ${provider.name}/${model} ${err.message.slice(0, 80)}`);
            }
        }
    }

    // ─── fallback: highest-confidence candidate ────────────
    candidates.sort((a, b) => (b.answer.confidence || 0) - (a.answer.confidence || 0));
    console.warn(`[research] using best candidate conf=${candidates[0].answer.confidence}`);
    return { ...candidates[0].answer, source: "best-candidate" };
}

function buildUserContent(question, textBlock) {
    if (question.needsVision && question.screenshotBase64) {
        return [
            { type: "text", text: textBlock },
            { type: "image_url", image_url: { url: "data:image/png;base64," + question.screenshotBase64 } }
        ];
    }
    return textBlock;
}

function buildVerifierContent(textBlock, candidates) {
    const list = candidates
        .map((c, i) => `Candidate ${i + 1} (${c.source}, conf ${c.answer.confidence}): ${JSON.stringify(stripMeta(c.answer))}\n  reasoning: ${(c.answer.reasoning || "").slice(0, 120)}`)
        .join("\n");
    return `${textBlock}\n\n---\nCandidates:\n${list}\n\nIndependently solve, then return the final answer as JSON.`;
}

function buildTextBlock(q) {
    const parts = [];
    parts.push("Question type: " + q.type);
    if (q.stem) parts.push("Question:\n" + q.stem);
    if (q.options && q.options.length) {
        parts.push("Options (index: text):");
        q.options.forEach((o, i) => parts.push("  " + i + ": " + o));
    }
    if (q.inputs && q.inputs.length) {
        parts.push("Input fields:");
        q.inputs.forEach((inp, i) => parts.push("  " + i + ': placeholder="' + inp.placeholder + '" label="' + inp.ariaLabel + '"'));
    }
    if (q.draggables && q.draggables.length) {
        parts.push("Draggable tiles: " + JSON.stringify(q.draggables));
        parts.push("Drop zones: " + JSON.stringify(q.dropZones || []));
    }
    if (q.hasCanvas) parts.push("Note: question includes a canvas/graph.");
    parts.push("Return ONLY valid JSON.");
    return parts.join("\n");
}

function stripMeta(a) {
    const { confidence, flags, reasoning, source, ...rest } = a || {};
    return rest;
}

function safeParseJSON(raw) {
    if (!raw) throw new Error("empty model response");
    let s = String(raw).trim();
    s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    try {
        return JSON.parse(s);
    } catch (e) {
        const m = s.match(/\{[\s\S]*\}/);
        if (!m) throw e;
        return JSON.parse(m[0]);
    }
}

function normalizeAnswer(obj) {
    if (!obj || typeof obj !== "object") return obj;
    let out = null;
    if (obj.type) out = obj;
    else for (const key of ["multiple_choice", "fill_in", "drag_drop", "visual"]) {
        if (obj[key]) { out = { type: key, ...obj[key] }; break; }
    }
    if (!out) out = obj;
    if (typeof out.confidence !== "number") out.confidence = 0.7;
    if (!Array.isArray(out.flags)) out.flags = [];
    if (typeof out.reasoning !== "string") out.reasoning = "";
    return out;
}