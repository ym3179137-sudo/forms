import fs from "fs";
import { chromium } from "playwright";

let cdpBrowser = null;
let scriptContent = "";
let watching = false;
const initedContexts = new WeakSet();

export async function ensureInjected(scriptPath) {
    try {
        scriptContent = fs.readFileSync(scriptPath, "utf8");
        console.log(`[inject] loaded ${scriptContent.length} bytes from ${scriptPath}`);
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
        console.log(`[inject] connect attempt failed: ${err.message.slice(0, 120)}`);
        return null;
    }
}

async function watchLoop() {
    let attempts = 0;
    for (; ;) {
        attempts++;
        try {
            const browser = await connect();
            if (!browser) {
                if (attempts % 5 === 0) console.log(`[inject] still trying (attempt ${attempts})`);
                await new Promise(r => setTimeout(r, 2000));
                continue;
            }

            const contexts = browser.contexts();
            if (attempts % 5 === 0) console.log(`[inject] contexts: ${contexts.length}`);

            for (const context of contexts) {
                if (!initedContexts.has(context)) {
                    initedContexts.add(context);
                    try {
                        await context.addInitScript({ content: scriptContent });
                        console.log("[inject] init script registered");
                    } catch (err) {
                        console.error("[inject] addInitScript failed:", err.message);
                        initedContexts.delete(context);
                    }
                }

                const pages = context.pages();
                for (const p of pages) {
                    try {
                        const url = p.url();
                        if (!url || url.startsWith("chrome://") || url.startsWith("devtools://") || url.startsWith("about:")) continue;

                        const already = await p.evaluate(() => !!window.__ixl_panel_injected__).catch(() => false);

                        if (already) {
                            const panelExists = await p.evaluate(() => !!document.getElementById("__ixl_panel")).catch(() => false);
                            if (panelExists) continue;

                            await p.evaluate((code) => {
                                try {
                                    window.__ixl_panel_injected__ = false;
                                    new Function(code)();
                                } catch (e) {
                                    console.error("[inject-eval]", e.message);
                                }
                            }, scriptContent).catch(() => { });
                            console.log("[inject] re-injected into", url.slice(0, 50));
                        } else {
                            await p.evaluate((code) => {
                                try {
                                    new Function(code)();
                                } catch (e) {
                                    console.error("[inject-eval]", e.message);
                                }
                            }, scriptContent).catch(() => { });
                            console.log("[inject] injected into", url.slice(0, 50));
                        }
                    } catch (err) {
                        console.error("[inject] page injection failed:", err.message.slice(0, 100));
                    }
                }
            }
        } catch (err) {
            console.error("[inject] loop error:", err.message.slice(0, 150));
            cdpBrowser = null;
        }
        await new Promise(r => setTimeout(r, 2500));
    }
}