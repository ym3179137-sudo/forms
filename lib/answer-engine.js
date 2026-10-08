import axios from "axios";
import https from "https";
import http from "http";
import { getSecret } from "./keys.js";

const CANDIDATE_PROMPT = `You are an IXL answer researcher. Return the CORRECT answer for the question, using whatever reasoning is needed.

Rules:
- Read the question twice. If an image is attached, read it carefully. Superscripts and subscripts matter (10^2 = 100, not 102). Negative signs matter.
- For science: use accurate facts, not common-sense guesses. If the question is about biology, chemistry, physics, earth science, or anatomy, reason from the actual principles.
- For reading comprehension: find the passage's central claim, not a supporting detail.
- For math: apply correct order of operations, then re-check by substituting back.
- Return ONLY valid JSON, no prose, no markdown.

Schema:
- multiple_choice: {"type":"multiple_choice","answer_index":<0-based int>,"confidence":<0-1>}
- fill_in: {"type":"fill_in","value":"<string>","confidence":<0-1>}
- drag_drop: {"type":"drag_drop","placements":[{"tile":"<text>","target":"<text>"}],"confidence":<0-1>}
- visual: {"type":"visual","answer_index":<int or null>,"value":"<string or null>","confidence":<0-1>}

Confidence 1.0 = certain. 0.7 = pretty sure. 0.4 = guessing.`;

const VERIFIER_PROMPT = `You are an IXL answer verifier. You will be given a question and one or more candidate answers. Your job is to decide the correct final answer.

Steps:
1. Read the question carefully (image if attached).
2. Read each candidate answer.
3. Independently solve the question WITHOUT looking at the candidates first.
4. Compare your independent answer to the candidates.
5. If one candidate matches your independent answer → return it with confidence 0.95.
6. If no candidate matches → return your independent answer with confidence 0.8 and note the disagreement.
7. If the question is ambiguous → return the most likely answer with confidence 0.6.

Return ONLY valid JSON matching the requested schema. No prose.`;

const httpsAgent = new https.Agent({ keepAlive: true });
const httpAgent = new http.Agent({ keepAlive: true });

const REQUEST_TIMEOUT_MS = 20000;
const TOTAL_BUDGET_MS = 30000;   // hard 30-second cap

function buildProviders(geminiKey, groqKey, openrouterKey) {
    return [
        { name: "gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: geminiKey, jsonMode: false, models: ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"] },
        { name: "groq", baseURL: "https://api.groq.com/openai/v1", apiKey: groqKey, jsonMode: true, models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"] },
        { name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: openrouterKey, jsonMode: true, models: ["openrouter/free"] }
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
        httpAgent, httpsAgent,
        validateStatus: (s) => s >= 200 && s < 500
    });
    if (res.status >= 400) throw new Error(`http ${res.status}: ${JSON.stringify(res.data).slice(0, 130)}`);
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
    const temperature = cfg.temperature ?? 0.2;
    const maxTokens = cfg.maxTokens ?? 800;

    const candidates = [];
    let attempts = 0;

    // ─── round 1: ask up to 3 different models ─────────────
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
                    const a = await callOne(provider, model, CANDIDATE_PROMPT, userContent, temperature, maxTokens, withJson);
                    const norm = normalizeAnswer(a);
                    candidates.push({ source: `${provider.name}/${model}`, answer: norm });
                    console.log(`[research] candidate ${candidates.length} from ${provider.name}/${model} conf=${norm.confidence}`);
                    break; // don't try same model twice
                } catch (err) {
                    console.warn(`[research] ✗ ${provider.name}/${model} ${withJson ? "(json)" : "(plain)"} ${err.message.slice(0, 80)}`);
                }
            }
        }
    }

    if (candidates.length === 0) {
        throw new Error(`no candidates after ${attempts} attempts / ${Date.now() - t0}ms`);
    }

    // ─── early exit: unanimous answer with high confidence ─
    if (candidates.length >= 2) {
        const keys = candidates.map(c => JSON.stringify(stripMeta(c.answer)));
        const allSame = keys.every(k => k === keys[0]);
        const avgConf = candidates.reduce((s, c) => s + (c.answer.confidence || 0), 0) / candidates.length;
        if (allSame && avgConf >= 0.9) {
            console.log(`[research] unanimous (${candidates.length} agree), ${Date.now() - t0}ms`);
            const winner = { ...candidates[0].answer, confidence: Math.min(1, avgConf + 0.05) };
            return winner;
        }
    }

    // ─── round 2: verifier model picks the winner ──────────
    const verifierUserContent = buildVerifierContent(textBlock, candidates);

    for (const provider of providers) {
        if (!provider.apiKey || /PUT_|your_/i.test(provider.apiKey)) continue;
        const useJsonMode = provider.jsonMode !== false;

        for (const model of provider.models) {
            if (Date.now() - t0 > TOTAL_BUDGET_MS) throw new Error(`budget exceeded in verification / ${Date.now() - t0}ms`);
            attempts++;
            try {
                const v = await callOne(provider, model, VERIFIER_PROMPT, verifierUserContent, 0.1, maxTokens, useJsonMode);
                const norm = normalizeAnswer(v);
                console.log(`[research] verifier picked via ${provider.name}/${model} conf=${norm.confidence} / total ${Date.now() - t0}ms`);
                return norm;
            } catch (err) {
                console.warn(`[research] verifier ✗ ${provider.name}/${model} ${err.message.slice(0, 80)}`);
            }
        }
    }

    // fallback: highest-confidence candidate
    candidates.sort((a, b) => (b.answer.confidence || 0) - (a.answer.confidence || 0));
    console.warn(`[research] verifier exhausted, using highest-confidence candidate`);
    return candidates[0].answer;
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
    const list = candidates.map((c, i) => `Candidate ${i + 1} (from ${c.source}, conf ${c.answer.confidence}): ${JSON.stringify(stripMeta(c.answer))}`).join("\n");
    return `${textBlock}\n\n---\nCandidates to verify:\n${list}\n\nReturn the final answer as JSON matching the schema.`;
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
    const { confidence, flags, source, ...rest } = a || {};
    return rest;
}

function safeParseJSON(raw) {
    if (!raw) throw new Error("empty model response");
    let s = String(raw).trim();
    s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    try { return JSON.parse(s); }
    catch (e) {
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
    return out;
}