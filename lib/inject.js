import fs from "fs";
import { chromium } from "playwright";

let cdpBrowser = null;
let scriptContent = "";
let watching = false;
const initedContexts = new WeakSet();

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
        try { await cdpBrowser.contexts(); return cdpBrowser; }
        catch (_) { cdpBrowser = null; }
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
                // register init script ONLY once per context
                if (!initedContexts.has(context)) {
                    initedContexts.add(context);
                    try {
                        await context.addInitScript({ content: scriptContent });
                        console.log("[inject] init script registered on context");
                    } catch (err) {
                        console.error("[inject] addInitScript failed:", err.message);
                        initedContexts.delete(context);
                    }
                }

                // inject into any currently-open pages that don't have the panel
                const pages = context.pages();
                for (const p of pages) {
                    try {
                        const url = p.url();
                        if (!url || url.startsWith("chrome://") || url.startsWith("devtools://") || url.startsWith("about:")) continue;

                        const already = await p.evaluate(() => !!window.__ixl_panel_injected__).catch(() => false);
                        if (already) {
                            // verify the panel element is still in the DOM
                            const panelExists = await p.evaluate(() => !!document.getElementById("__ixl_panel")).catch(() => false);
                            if (panelExists) continue;
                            // panel was removed by IXL — re-inject just the panel (not full init)
                            await p.evaluate((code) => {
                                try {
                                    // reset flag so the script can run again
                                    window.__ixl_panel_injected__ = false;
                                    new Function(code)();
                                } catch (e) { console.error("[inject-eval]", e.message); }
                            }, scriptContent).catch(() => { });
                            console.log("[inject] re-injected into", url.slice(0, 60));
                        } else {
                            await p.evaluate((code) => {
                                try { new Function(code)(); } catch (e) { console.error("[inject-eval]", e.message); }
                            }, scriptContent).catch(() => { });
                            console.log("[inject] injected into", url.slice(0, 60));
                        }
                    } catch (_) { }
                }
            }
        } catch (err) {
            console.error("[inject] loop error:", err.message);
            cdpBrowser = null;
        }
        await new Promise(r => setTimeout(r, 2500));
    }
}