import fs from "fs";
import { chromium } from "playwright";

let cdpBrowser = null;
let scriptContent = "";
let watching = false;
let installedContexts = new WeakSet();

export async function ensureInjected(scriptPath) {
    try {
        scriptContent = fs.readFileSync(scriptPath, "utf8");
    } catch (e) {
        console.error("[inject] cannot read script:", e.message);
        return false;
    }

    if (!watching) {
        watching = true;
        watchLoop();
    }
    return true;
}

async function connect() {
    if (cdpBrowser) {
        try {
            // still alive?
            await cdpBrowser.contexts();
            return cdpBrowser;
        } catch (_) {
            cdpBrowser = null;
        }
    }
    try {
        cdpBrowser = await chromium.connectOverCDP("http://127.0.0.1:9222");
        console.log("[inject] connected to chrome CDP");
        return cdpBrowser;
    } catch (err) {
        return null;
    }
}

async function watchLoop() {
    for (; ;) {
        try {
            const browser = await connect();
            if (!browser) {
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            const contexts = browser.contexts();
            for (const context of contexts) {
                // install script on future pages (idempotent-ish — Playwright allows repeated calls but let's mark)
                try {
                    await context.addInitScript({ content: scriptContent });
                } catch (_) { }

                // also inject into currently-open pages
                const pages = context.pages();
                for (const p of pages) {
                    try {
                        const url = p.url();
                        if (!url || url.startsWith("chrome://") || url.startsWith("devtools://")) continue;

                        // check if already injected
                        const already = await p.evaluate(() => !!window.__ixl_panel_injected__).catch(() => false);
                        if (already) continue;

                        await p.evaluate((code) => {
                            try { new Function(code)(); } catch (e) { console.error("[inject-eval]", e.message); }
                        }, scriptContent).catch(() => { });
                        console.log("[inject] injected into page:", url.slice(0, 60));
                    } catch (_) { }
                }
            }
        } catch (err) {
            console.error("[inject] loop error:", err.message);
            cdpBrowser = null;
        }
        await new Promise(r => setTimeout(r, 3000));
    }
}