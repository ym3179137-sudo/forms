import axios from "axios";
import https from "https";
import http from "http";

const SYSTEM_PROMPT = `You solve IXL questions across ALL subjects: Math, Language Arts, Science, Social Studies, Spanish, and any world language.

Approach:
- Reading comprehension / ELA: read the PASSAGE carefully, then answer what the QUESTION asks.
- Math: apply the correct order of operations. Superscripts matter (10^2 = 100, not 102). Negative signs matter.
- Science: pick the scientifically correct answer, not the "common sense" one.
- Social Studies: use accurate history / geography / civics knowledge.
- Spanish: answer in the requested language. Watch gender/agreement.

Return ONLY valid JSON, no prose, no fences.

Schemas:
- multiple_choice: {"type":"multiple_choice","answer_index":<0-based int>,"confidence":<0-1>}
- multi_select:   {"type":"multi_select","answer_indices":[<int>...],"confidence":<0-1>}
- fill_in:        {"type":"fill_in","value":"<string>"}
- dropdown:       {"type":"dropdown","values":["<answer for dropdown 1>", "<answer for dropdown 2>"]}
- matching:       {"type":"matching","pairs":[{"left":"<text>","right":"<text>"}]}
- sorting:        {"type":"sorting","order":["<first>","<second>",...]}
- drag_drop:      {"type":"drag_drop","placements":[{"tile":"<text>","target":"<text>"}]}
- visual:         {"type":"visual","answer_index":<int or null>,"value":"<string or null>"}

Choose the most likely correct answer. Return valid JSON only.`;

const httpsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: true });
const httpAgent = new http.Agent({ keepAlive: true });

const REQUEST_TIMEOUT_MS = 12000;
const TOTAL_BUDGET_MS = 20000;

export async function getAnswer(question, cfg, creds = {}) {
    const t0 = Date.now();
    const textBlock = buildTextBlock(question);
    const hasImage = !!(question.needsVision && question.screenshotBase64);

    let providers = Array.isArray(cfg.providers)
        ? [...cfg.providers]
        : [{ name: "openrouter", baseURL: cfg.baseURL, apiKeyEnv: "OPENROUTER_API_KEY", models: cfg.textModels || [], jsonMode: true, supportsVision: true }];

    // text-only questions → groq first (fastest). vision questions → gemini first (only one with vision).
    if (!hasImage) {
        providers.sort((a, b) => {
            const aTextOnly = a.supportsVision ? 1 : 0;
            const bTextOnly = b.supportsVision ? 1 : 0;
            return aTextOnly - bTextOnly;
        });
    }

    const messagesVision = hasImage ? [
        { role: "system", content: SYSTEM_PROMPT },
        {
            role: "user", content: [
                { type: "text", text: textBlock },
                { type: "image_url", image_url: { url: "data:image/png;base64," + question.screenshotBase64 } }
            ]
        }
    ] : null;

    const messagesText = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: textBlock }
    ];

    const temperature = cfg.temperature ?? 0.2;
    const maxTokens = cfg.maxTokens ?? 800;

    let lastErr;
    let attemptsMade = 0;

    for (const provider of providers) {
        const apiKey = process.env[provider.apiKeyEnv];
        if (!apiKey || /your_|placeholder/i.test(apiKey)) continue;

        const url = provider.baseURL.replace(/\/$/, "") + "/chat/completions";
        const useJsonMode = provider.jsonMode !== false;
        const supportsVision = provider.supportsVision !== false;

        for (const model of provider.models) {
            const attempts = [];

            if (hasImage && supportsVision) {
                attempts.push({ messages: messagesVision, withJson: useJsonMode, tag: useJsonMode ? "vision" : "vision-text" });
                if (useJsonMode) attempts.push({ messages: messagesVision, withJson: false, tag: "vision-nojson" });
            }

            attempts.push({ messages: messagesText, withJson: useJsonMode, tag: useJsonMode ? "text" : "text-only" });
            if (useJsonMode) attempts.push({ messages: messagesText, withJson: false, tag: "text-nojson" });

            for (const attempt of attempts) {
                if (Date.now() - t0 > TOTAL_BUDGET_MS) {
                    throw new Error(`budget exceeded at ${Date.now() - t0}ms after ${attemptsMade} attempts`);
                }
                attemptsMade++;

                try {
                    const body = { model, messages: attempt.messages, temperature, max_tokens: maxTokens };
                    if (attempt.withJson) body.response_format = { type: "json_object" };

                    const t1 = Date.now();
                    const res = await axios.post(url, body, {
                        headers: {
                            "Authorization": "Bearer " + apiKey,
                            "Content-Type": "application/json",
                            "HTTP-Referer": "http://localhost",
                            "X-Title": "ixl-solver"
                        },
                        timeout: REQUEST_TIMEOUT_MS,
                        httpAgent,
                        httpsAgent,
                        maxRedirects: 3,
                        validateStatus: (s) => s >= 200 && s < 500
                    });

                    if (res.status >= 400) {
                        const detail = typeof res.data === "object"
                            ? JSON.stringify(res.data).slice(0, 130)
                            : String(res.data).slice(0, 130);
                        throw new Error(`http ${res.status}: ${detail}`);
                    }

                    const raw = res.data?.choices?.[0]?.message?.content;
                    const ms = Date.now() - t1;
                    const total = Date.now() - t0;
                    console.log(`[answer-engine] ✓ ${provider.name}/${model} (${attempt.tag}) ${ms}ms / total ${total}ms`);
                    return safeParseJSON(raw);

                } catch (err) {
                    lastErr = err;
                    const status = err.response?.status || "";
                    const msg = err.message || "";
                    console.warn(`[answer-engine] ✗ ${provider.name}/${model} (${attempt.tag}) ${status} ${msg.slice(0, 80)}`);
                    continue;
                }
            }
        }
    }

    throw new Error(`all providers failed after ${attemptsMade} attempts / ${Date.now() - t0}ms. last: ${lastErr?.message || "unknown"}`);
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
    if (q.dropdowns && q.dropdowns.length) {
        parts.push("Dropdowns (in order, values you can choose from):");
        q.dropdowns.forEach((d, i) => parts.push("  dropdown " + i + ": [" + d.options.join(" | ") + "]"));
    }
    if (q.matchLeft && q.matchLeft.length) {
        parts.push("Left column: " + JSON.stringify(q.matchLeft));
        parts.push("Right column: " + JSON.stringify(q.matchRight));
        parts.push("Return pairs as {left, right} matching each left to the correct right.");
    }
    if (q.draggables && q.draggables.length) {
        parts.push("Draggable tiles: " + JSON.stringify(q.draggables));
        parts.push("Drop zones: " + JSON.stringify(q.dropZones));
    }
    parts.push("Return the JSON answer.");
    return parts.join("\n");
}

function safeParseJSON(raw) {
    if (!raw) throw new Error("empty model response");
    let s = String(raw).trim();
    s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) s = s.slice(a, b + 1);

    try {
        return normalizeAnswer(JSON.parse(s));
    } catch (e) {
        const m = s.match(/\{[\s\S]*\}/);
        if (!m) throw e;
        return normalizeAnswer(JSON.parse(m[0]));
    }
}

function normalizeAnswer(obj) {
    if (obj && obj.type) return obj;
    for (const key of ["multiple_choice", "multi_select", "fill_in", "dropdown", "matching", "sorting", "drag_drop", "visual"]) {
        if (obj[key]) return { type: key, ...obj[key] };
    }
    return obj;
}