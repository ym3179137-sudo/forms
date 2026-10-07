import fs from "fs";
import { chromium } from "playwright";

let injected = false;

export async function injectPanel(scriptPath, retries = 20) {
    if (injected) return true;

    let script;
    try {
        script = fs.readFileSync(scriptPath, "utf8");
    } catch (e) {
        console.error("[inject] cannot read script:", e.message);
        return false;
    }

    for (let i = 0; i < retries; i++) {
        try {
            const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
            const contexts = browser.contexts();
            if (!contexts.length) {
                await browser.close().catch(() => { });
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            const context = contexts[0];

            // install on every future page
            await context.addInitScript({ content: script });

            // also inject into pages already open
            const pages = context.pages();
            for (const p of pages) {
                try {
                    await p.evaluate((code) => {
                        try { new Function(code)(); } catch (e) { console.error("[eval]", e.message); }
                    }, script);
                } catch (_) { }
            }

            console.log(`[inject] panel installed on context + ${pages.length} page(s)`);
            injected = true;
            await browser.close().catch(() => { });
            return true;
        } catch (err) {
            console.log(`[inject] retry ${i + 1}/${retries}: ${err.message}`);
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    console.error("[inject] gave up");
    return false;
}