import axios from "axios";
import https from "https";
import http from "http";
import { getSecret } from "./keys.js";

const SYSTEM_PROMPT = `You solve IXL questions across ALL subjects: Math, Language Arts, Science, Social Studies, Spanish.

Approach:
- Reading comprehension / ELA: read the PASSAGE carefully, then answer what the QUESTION asks.
- Math: apply the correct order of operations. Superscripts matter (10^2 = 100, not 102). Negative signs matter.
- Science: pick the scientifically correct answer.
- Social Studies: use accurate history / geography / civics.
- Spanish: answer in the requested language. Watch gender/agreement.

Return ONLY valid JSON, no prose, no fences.

Schemas:
- multiple_choice: {"type":"multiple_choice","answer_index":<0-based int>,"confidence":<0-1>}
- fill_in: {"type":"fill_in","value":"<string>"}
- visual: {"type":"visual","answer_index":<int or null>,"value":"<string or null>"}

Pick the most likely correct answer. Return valid JSON only.`;

const httpsAgent = new https.Agent({ keepAlive: true });
const httpAgent = new http.Agent({ keepAlive: true });

const REQUEST_TIMEOUT_MS = 15000;
const TOTAL_BUDGET_MS = 45000;

export async function getAnswer(question, cfg) {
    const t0 = Date.now();
    const textBlock = buildTextBlock(question);

    const geminiKey = await getSecret("GEMINI_API_KEY");
    const groqKey = await getSecret("GROQ_API_KEY");
    const openrouterKey = await getSecret("OPENROUTER_API_KEY");

    // Groq first — it's reliably fast. Gemini as backup.
    const providers = [
        { name: "groq", baseURL: "https://api.groq.com/openai/v1", apiKey: groqKey, jsonMode: true, models: ["openai/gpt-oss-20b", "llama-3.1-8b-instant", "openai/gpt-oss-120b"] },
        { name: "gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: geminiKey, jsonMode: false, models: ["gemini-flash-latest", "gemini-flash-lite-latest"] },
        { name: "openrouter", baseURL: "https://openrouter.ai/api/v1", apiKey: openrouterKey, jsonMode: true, models: ["openrouter/free"] }
    ];

    const temperature = cfg.temperature ?? 0.2;
    const maxTokens = cfg.maxTokens ?? 800;

    let lastErr;
    let attempts = 0;

    for (const provider of providers) {
        if (!provider.apiKey || /PUT_|your_/i.test(provider.apiKey)) {
            console.log(`[answer-engine] skip ${provider.name} (no key)`);
            continue;
        }
        const url = provider.baseURL.replace(/\/$/, "") + "/chat/completions";
        const useJsonMode = provider.jsonMode !== false;

        for (const model of provider.models) {
            const attemptsList = useJsonMode
                ? [{ withJson: true, tag: "json" }, { withJson: false, tag: "plain" }]
                : [{ withJson: false, tag: "plain" }];

            for (const att of attemptsList) {
                if (Date.now() - t0 > TOTAL_BUDGET_MS) {
                    throw new Error(`budget exceeded after ${attempts} attempts / ${Date.now() - t0}ms`);
                }
                attempts++;
                const tAttempt = Date.now();

                try {
                    const body = {
                        model,
                        messages: [
                            { role: "system", content: SYSTEM_PROMPT },
                            { role: "user", content: textBlock }
                        ],
                        temperature,
                        max_tokens: maxTokens
                    };
                    if (att.withJson) body.response_format = { type: "json_object" };

                    const res = await axios.post(url, body, {
                        headers: {
                            "Authorization": "Bearer " + provider.apiKey,
                            "Content-Type": "application/json"
                        },
                        timeout: REQUEST_TIMEOUT_MS,
                        httpAgent,
                        httpsAgent,
                        validateStatus: (s) => s >= 200 && s < 500
                    });

                    const ms = Date.now() - tAttempt;

                    if (res.status >= 400) {
                        const detail = JSON.stringify(res.data).slice(0, 130);
                        throw new Error(`http ${res.status}: ${detail}`);
                    }

                    const raw = res.data?.choices?.[0]?.message?.content;
                    console.log(`[answer-engine] ✓ ${provider.name}/${model} (${att.tag}) ${ms}ms / total ${Date.now() - t0}ms`);
                    return safeParseJSON(raw);
                } catch (err) {
                    lastErr = err;
                    const status = err.response?.status || "";
                    const ms = Date.now() - tAttempt;
                    const detail = err.response
                        ? JSON.stringify(err.response.data).slice(0, 80)
                        : (err.message || "").slice(0, 80);
                    console.warn(`[answer-engine] ✗ ${provider.name}/${model} (${att.tag}) ${status} ${ms}ms ${detail}`);
                }
            }
        }
    }

    throw new Error(`all providers failed after ${attempts} attempts / ${Date.now() - t0}ms. last: ${lastErr?.message || "unknown"}`);
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
    parts.push("Return the JSON answer.");
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
    if (obj && obj.type) return obj;
    for (const key of ["multiple_choice", "fill_in", "visual"]) {
        if (obj[key]) return { type: key, ...obj[key] };
    }
    return obj;
}