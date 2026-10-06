import "dotenv/config";
import { createSession } from "./lib/steel-session.js";
import { hardenPage } from "./lib/anti-detect.js";
import { parseQuestion } from "./lib/question-parser.js";
import { getAnswer } from "./lib/answer-engine.js";
import { applyAnswer, waitForNextQuestion } from "./lib/input-handler.js";
import { humanPause } from "./lib/humanize.js";
import { injectPanel, updatePanel, getAutoState } from "./lib/ui.js";
import { lookupAnswer, saveAnswer, recordWrongAnswer, stats } from "./lib/answer-cache.js";
import { readFeedback, dismissWrongFeedback, parseCorrectAnswerText, captureSignature } from "./lib/ixl-feedback.js";

export async function runSolver({ sessionId, config, creds, startUrl, username, shouldStop, onEvent, onBrowserReady }) {
    const emit = (msg) => {
        if (onEvent) onEvent({ sessionId, ...msg });
        console.log(`[solver ${sessionId}]`, msg.type, "-", msg.message || "");
    };

    let page = null;
    let sessionRef = null;
    let reinject = null;

    try {
        emit({ type: "status", message: "launching chromium..." });
        sessionRef = await createSession({ username });
        page = sessionRef.page;
        emit({ type: "status", message: "browser ready" });

        if (onBrowserReady) {
            try { await onBrowserReady({ page }); }
            catch (e) { console.error("[solver] onBrowserReady:", e.message); }
        }

        await hardenPage(page);

        const target = startUrl || "https://www.ixl.com/";
        emit({ type: "status", message: "navigating to " + target });

        try { await page.goto(target, { waitUntil: "commit", timeout: 45000 }); }
        catch (err) { emit({ type: "log", message: "goto warning: " + err.message }); }

        await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => { });
        await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => { });

        await injectPanel(page, config.panel).catch(() => { });
        emit({ type: "status", message: "panel injected. log into IXL, then click Start Auto." });

        stats().then(s => emit({ type: "log", message: `cache: ${s.verified}/${s.total} verified, ${s.hits} hits` })).catch(() => { });

        reinject = setInterval(() => injectPanel(page, config.panel).catch(() => { }), 4000);

        let solved = 0;
        let failures = 0;
        let cacheHits = 0;

        while (true) {
            if (shouldStop && shouldStop()) { emit({ type: "status", message: "stopped" }); break; }

            try {
                const auto = await getAutoState(page);
                if (!auto) { await humanPause(1000, 1500); continue; }

                await updatePanel(page, "parsing question");
                const question = await parseQuestion(page);

                if (!question || question.type === "unknown") {
                    await new Promise(r => setTimeout(r, 600));
                    continue;
                }
                if (!question.stem || question.stem.trim().length < 5) {
                    await new Promise(r => setTimeout(r, 400));
                    continue;
                }

                const sigBefore = await captureSignature(page);
                let answer = null;
                let fromCache = false;

                await updatePanel(page, "checking cache");
                const cached = await lookupAnswer(question);
                if (cached) {
                    answer = cached; fromCache = true;
                    emit({ type: "log", message: "⚡ cache hit" });
                } else {
                    await updatePanel(page, `thinking (${question.type})`);
                    answer = await getAnswer(question, config, creds);
                    emit({ type: "log", message: `AI: ${JSON.stringify(answer).slice(0, 100)}` });
                }

                await applyAnswer(page, question, answer, config.behavior);

                await updatePanel(page, "verifying");
                const feedback = await readFeedback(page, sigBefore);
                let verified = false;

                if (feedback.correct === true) {
                    verified = true;
                    emit({ type: "log", message: fromCache ? "✓ cache correct" : "✓ verified" });
                    if (!fromCache) await saveAnswer(question, answer, true);
                    if (fromCache) cacheHits++;
                } else if (feedback.correct === false) {
                    emit({ type: "log", message: `✗ wrong: ${(feedback.correctAnswerText || "?").slice(0, 40)}` });
                    await recordWrongAnswer(question, answer);
                    const correctAns = parseCorrectAnswerText(feedback.correctAnswerText, question);
                    if (correctAns) await saveAnswer(question, correctAns, true);
                    await dismissWrongFeedback(page);
                }

                solved++;
                failures = 0;
                const logLine = `${fromCache ? "⚡" : "AI"} ${question.type} ${verified ? "✓" : "?"}`;
                await updatePanel(page, `solved ${solved}`, logLine);
                emit({ type: "solved", count: solved, message: logLine });

                await waitForNextQuestion(page);
                await humanPause(150, 300);
            } catch (err) {
                failures++;
                emit({ type: "error", message: `err (${failures}): ${err.message}` });
                if (/target.*closed|browser.*closed|page.*closed|context.*closed/i.test(err.message)) {
                    emit({ type: "status", message: "browser closed" });
                    break;
                }
                if (failures >= 8) {
                    emit({ type: "status", message: "too many errors — auto paused" });
                    await page.evaluate(() => { if (window.__ixlCtl) window.__ixlCtl.auto = false; }).catch(() => { });
                    failures = 0;
                }
                await humanPause(1500, 2500);
            }
        }
    } catch (err) {
        console.error(`[solver ${sessionId}] fatal:`, err.message);
        emit({ type: "fatal", message: err.message });
    } finally {
        if (reinject) clearInterval(reinject);
        if (sessionRef && sessionRef.client && sessionRef.client.release) {
            try { await sessionRef.client.release(); } catch (_) { }
        }
        console.log(`[solver ${sessionId}] cleanup done`);
    }
}