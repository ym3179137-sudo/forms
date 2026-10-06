import "dotenv/config";
import { createSession } from "./lib/steel-session.js";
import { hardenPage } from "./lib/anti-detect.js";
import { parseQuestion } from "./lib/question-parser.js";
import { getAnswer } from "./lib/answer-engine.js";
import { applyAnswer, waitForNextQuestion } from "./lib/input-handler.js";
import { humanPause, humanDelay } from "./lib/humanize.js";
import { injectPanel, updatePanel, getAutoState } from "./lib/ui.js";
import { lookupAnswer, saveAnswer, recordWrongAnswer, stats } from "./lib/answer-cache.js";
import { readFeedback, dismissWrongFeedback, parseCorrectAnswerText, captureSignature } from "./lib/ixl-feedback.js";

export async function runSolver({ sessionId, config, creds, startUrl, shouldStop, onEvent, onBrowserReady }) {
    const emit = (msg) => {
        if (onEvent) onEvent({ sessionId, ...msg });
        console.log(`[solver ${sessionId}]`, msg.type, "-", msg.message || "");
    };

    emit({ type: "status", message: "launching local browser..." });
    const { page, liveViewUrl, sessionId: steelSessionId } = await createSession();
    emit({ type: "status", message: "browser ready", liveViewUrl, steelSessionId });

    // hand the page object to the server so it can attach a live view
    if (onBrowserReady) {
        try { onBrowserReady({ page }); } catch (e) { console.warn("[solver] onBrowserReady failed:", e.message); }
    }

    await hardenPage(page);

    const target = startUrl || "https://www.ixl.com/";
    emit({ type: "status", message: "navigating to " + target });

    try {
        await page.goto(target, { waitUntil: "commit", timeout: 45000 });
    } catch (err) {
        emit({ type: "log", message: "goto warning: " + err.message });
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => { });
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => { });

    await injectPanel(page, config.panel);
    emit({ type: "status", message: "panel injected. log into IXL, then click Start Auto." });

    // show cache stats on boot
    stats()
        .then(s => emit({ type: "log", message: `cache: ${s.verified}/${s.total} verified, ${s.hits} hits` }))
        .catch(() => { });

    const reinject = setInterval(() => injectPanel(page, config.panel).catch(() => { }), 3000);

    let solved = 0;
    let failures = 0;
    let cacheHits = 0;

    try {
        while (true) {
            if (shouldStop && shouldStop()) {
                emit({ type: "status", message: "stopped by request" });
                break;
            }

            try {
                const auto = await getAutoState(page);
                if (!auto) {
                    await humanPause(1000, 1800);
                    continue;
                }

                await updatePanel(page, "parsing question");

                const question = await parseQuestion(page);

                if (!question || question.type === "unknown") {
                    await updatePanel(page, "no parseable question yet");
                    emit({ type: "log", message: "no parseable question — waiting" });
                    await new Promise(r => setTimeout(r, 600));
                    continue;
                }

                if (!question.stem || question.stem.trim().length < 5) {
                    emit({ type: "log", message: "empty stem — skipping cycle" });
                    await new Promise(r => setTimeout(r, 400));
                    continue;
                }

                // snapshot for feedback comparison
                const sigBefore = await captureSignature(page);

                // ── 1. cache lookup ──────────────────────────────────────
                let answer = null;
                let fromCache = false;

                await updatePanel(page, "checking cache");
                const cached = await lookupAnswer(question);

                if (cached) {
                    answer = cached;
                    fromCache = true;
                    emit({ type: "log", message: `⚡ CACHE HIT — ${JSON.stringify(cached).slice(0, 80)}` });
                } else {
                    await updatePanel(page, `thinking (${question.type})`);
                    emit({ type: "log", message: `q[${question.type}] stem="${(question.stem || "").slice(0, 60)}"` });
                    answer = await getAnswer(question, config, creds);
                    emit({ type: "log", message: `AI: ${JSON.stringify(answer).slice(0, 100)}` });
                }

                // ── 2. apply answer ──────────────────────────────────────
                await applyAnswer(page, question, answer, config.behavior);

                // ── 3. read IXL feedback ─────────────────────────────────
                await updatePanel(page, "verifying");
                const feedback = await readFeedback(page, sigBefore);
                let verified = false;

                if (feedback.correct === true) {
                    verified = true;
                    emit({ type: "log", message: fromCache ? "✓ cache answer correct" : "✓ verified correct" });
                    if (!fromCache) await saveAnswer(question, answer, true);
                    if (fromCache) cacheHits++;
                } else if (feedback.correct === false) {
                    emit({ type: "log", message: `✗ wrong. IXL says: "${feedback.correctAnswerText || "?"}"` });
                    await recordWrongAnswer(question, answer);

                    const correctAns = parseCorrectAnswerText(feedback.correctAnswerText, question);
                    if (correctAns) {
                        emit({ type: "log", message: `saving correct: ${JSON.stringify(correctAns)}` });
                        await saveAnswer(question, correctAns, true);
                    } else {
                        emit({ type: "log", message: `couldn't parse IXL's correct-answer text — not caching` });
                    }
                    await dismissWrongFeedback(page);
                } else {
                    emit({ type: "log", message: "feedback unknown — not caching" });
                }

                solved++;
                failures = 0;
                const logLine = `${fromCache ? "⚡" : "AI"} ${question.type} ${verified ? "✓" : "?"} (${cacheHits} hits)`;
                await updatePanel(page, `solved ${solved}`, logLine);
                emit({ type: "solved", count: solved, message: logLine });

                await waitForNextQuestion(page);
                await humanPause(150, 300);

            } catch (err) {
                failures++;
                emit({ type: "error", message: `err (${failures}): ${err.message}` });
                await updatePanel(page, "err: " + err.message.slice(0, 40), "x " + err.message.slice(0, 60));

                if (/target.*closed|session.*closed|browser.*closed|page.*closed/i.test(err.message)) {
                    emit({ type: "status", message: "browser closed. stopping." });
                    break;
                }

                if (failures >= 8) {
                    emit({ type: "status", message: "too many errors — auto paused" });
                    await page.evaluate(() => { if (window.__ixlCtl) window.__ixlCtl.auto = false; }).catch(() => { });
                    failures = 0;
                }
                await humanPause(1500, 3000);
            }
        }
    } finally {
        clearInterval(reinject);
    }
}