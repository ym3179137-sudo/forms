import axios from "axios";
import https from "https";
import http from "http";
import { getSecret } from "./keys.js";

const RESEARCH_PROMPT = `You are a careful IXL answer researcher. Your job: given a question, produce the CORRECT answer with high confidence, and flag anything uncertain.

Steps you MUST follow in this order:
1. Read the question carefully.
2. If an IMAGE is attached (math symbols, graphs, diagrams), read it twice. Superscripts and subscripts matter (10^2 = 100, not 102). Negative signs matter.
3. Identify what the question is really asking (order of operations? main idea? chemical formula? verb conjugation?).
4. Compute or reason to the answer.
5. VERIFY: re-check the answer one more time before returning. If the second pass disagrees, prefer the more careful pass and note it.
6. If you are NOT 100% certain, set confidence below 0.75 and put a short note in "flags" describing what's uncertain.

Return ONLY valid JSON, no prose, no markdown fences.

Output schemas:
- multiple_choice: {"type":"multiple_choice","answer_index":<0-based int>,"confidence":<0-1>,"flags":["<optional note>"]}
- fill_in: {"type":"fill_in","value":"<string>","confidence":<0-1>,"flags":[...]}
- drag_drop: {"type":"drag_drop","placements":[{"tile":"<text>","target":"<text>"}],"confidence":<0-1>,"flags":[...]}
- visual: {"type":"visual","answer_index":<int or null>,"value":"<string or null>","confidence":<0-1>,"flags":[...]}

Rules:
- Always return valid JSON.
- Confidence 1.0 = you are certain. 0.9 = very confident. 0.7 = pretty sure. 0.5 = guessing.
- Flags array is empty [] when certain, otherwise short strings like "unclear superscript" or "multiple plausible answers".
- Never refuse. Never add prose outside the JSON.`;

const httpsAgent = new https.Agent({ keepAlive: true });
const httpAgent = new http.Agent({ keepAlive: true });

const REQUEST_TIMEOUT_MS = 15000;
const TOTAL_BUDGET_MS = 22000;

export async function getAnswer(question, cfg) {
    const t0 = Date.now();
    const textBlock = buildTextBlock(question);

    const geminiKey = await getSecret("GEMINI_API_KEY");
    const groqKey = await getSecret("GROQ_API_KEY");
    const openrouterKey = await getSecret("OPENROUTER_API_KEY");

    const providers = [
        { name: "gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: geminiKey, jsonMode: false, vision: true, models: ["gemini-flash-latest", "gemini-flash-lite-latest"] },
        { name: "groq", baseURL: "https://api.groq.com/openai/v1", apiKey: groqKey, jsonMode: true, vision: false, models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"] },
        { name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: openrouterKey, jsonMode: true, vision: true, models: ["openrouter/free"] }
    ];

    const temperature = cfg.temperature ?? 0.2;
    const maxTokens = cfg.maxTokens ?? 800;

    let lastErr;
    let attempts = 0;

    for (const provider of providers) {
        if (!provider.apiKey || /PUT_|your_/i.test(provider.apiKey)) continue;
        const url = provider.baseURL.replace(/\/$/, "") + "/chat/completions";
        const useJsonMode = provider.jsonMode !== false;

        for (const model of provider.models) {
            const attemptModes = [
                { withJson: useJsonMode, tag: "json" },
                { withJson: false, tag: "plain" }
            ];

            for (const att of attemptModes) {
                if (Date.now() - t0 > TOTAL_BUDGET_MS) {
                    throw new Error(`budget exceeded after ${attempts} attempts (${Date.now() - t0}ms)`);
                }
                attempts++;

                try {
                    const body = {
                        model,
                        messages: [
                            { role: "system", content: RESEARCH_PROMPT },
                            { role: "user", content: buildUserContent(question, textBlock) }
                        ],
                        temperature,
                        max_tokens: maxTokens
                    };
                    if (att.withJson) body.response_format = { type: "json_object" };

                    const res = await axios.post(url, body, {
                        headers: { "Authorization": "Bearer " + provider.apiKey, "Content-Type": "application/json" },
                        timeout: REQUEST_TIMEOUT_MS,
                        httpAgent, httpsAgent,
                        validateStatus: (s) => s >= 200 && s < 500
                    });

                    if (res.status >= 400) {
                        const detail = JSON.stringify(res.data).slice(0, 130);
                        throw new Error(`http ${res.status}: ${detail}`);
                    }

                    const raw = res.data?.choices?.[0]?.message?.content;
                    const parsed = safeParseJSON(raw);
                    const ms = Date.now() - t0;

                    const conf = typeof parsed.confidence === "number" ? parsed.confidence : 0.5;
                    const flags = Array.isArray(parsed.flags) ? parsed.flags : [];
                    console.log(`[answer-engine] ✓ ${provider.name}/${model} (${att.tag}) ${ms}ms conf=${conf}${flags.length ? " flags=" + flags.join(",") : ""}`);

                    // if confidence is very low, try one more provider before returning
                    if (conf < 0.4 && attempts < 6) {
                        console.warn(`[answer-engine] low confidence ${conf}, trying next provider`);
                        lastErr = new Error(`low confidence ${conf}`);
                        continue;
                    }

                    return parsed;
                } catch (err) {
                    lastErr = err;
                    const status = err.response?.status || "";
                    console.warn(`[answer-engine] ✗ ${provider.name}/${model} (${att.tag}) ${status} ${(err.message || "").slice(0, 80)}`);
                }
            }
        }
    }

    throw new Error(`all providers failed after ${attempts} attempts / ${Date.now() - t0}ms. last: ${lastErr?.message || "unknown"}`);
}

function buildUserContent(question, textBlock) {
    // if a screenshot is present, send vision messages
    if (question.needsVision && question.screenshotBase64) {
        return [
            { type: "text", text: textBlock },
            { type: "image_url", image_url: { url: "data:image/png;base64," + question.screenshotBase64 } }
        ];
    }
    return textBlock;
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
    parts.push("Return ONLY valid JSON matching the schema. Include confidence and flags.");
    return parts.join("\n");
}

function safeParseJSON(raw) {
    if (!raw) throw new Error("empty model response");
    let s = String(raw).trim();
    s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    try { return normalizeAnswer(JSON.parse(s)); }
    catch (e) {
        const m = s.match(/\{[\s\S]*\}/);
        if (!m) throw e;
        return normalizeAnswer(JSON.parse(m[0]));
    }
}

function normalizeAnswer(obj) {
    if (!obj || typeof obj !== "object") return obj;
    let out = null;
    if (obj.type) out = obj;
    else for (const key of ["multiple_choice", "fill_in", "drag_drop", "visual"]) {
        if (obj[key]) { out = { type: key, ...obj[key] }; break; }
    }
    if (!out) return obj;
    if (typeof out.confidence !== "number") out.confidence = 0.7;
    if (!Array.isArray(out.flags)) out.flags = [];
    return out;
}