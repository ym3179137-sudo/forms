import fs from "fs";
import { chromium } from "playwright";
import axios from "axios";

let cdpBrowser = null;
let scriptContent = "";
let watching = false;
let routedContexts = new WeakSet();

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
        try { await cdpBrowser.contexts(); return cdpBrowser; }
        catch (_) { cdpBrowser = null; }
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

async function setupRoutes(context) {
    if (routedContexts.has(context)) return;
    routedContexts.add(context);

    // intercept /api/solve — CSP-proof, forwards to local node server
    await context.route("**/api/solve*", async (route) => {
        const req = route.request();
        const body = req.postData() || "{}";
        const tk = req.headers()["x-ixl-token"] || "";
        try {
            const res = await axios.post("http://127.0.0.1:3000/api/solve", body, {
                headers: { "content-type": "application/json", "x-ixl-token": tk },
                validateStatus: () => true,
                timeout: 25000
            });
            await route.fulfill({
                status: res.status,
                headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
                body: typeof res.data === "string" ? res.data : JSON.stringify(res.data)
            });
            console.log(`[route] solve -> ${res.status}`);
        } catch (err) {
            console.error("[route] solve failed:", err.message);
            await route.fulfill({ status: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: err.message }) });
        }
    });

    // intercept /api/feedback
    await context.route("**/api/feedback*", async (route) => {
        const req = route.request();
        const body = req.postData() || "{}";
        const tk = req.headers()["x-ixl-token"] || "";
        try {
            const res = await axios.post("http://127.0.0.1:3000/api/feedback", body, {
                headers: { "content-type": "application/json", "x-ixl-token": tk },
                validateStatus: () => true,
                timeout: 10000
            });
            await route.fulfill({
                status: res.status,
                headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
                body: JSON.stringify(res.data)
            });
        } catch (err) {
            await route.fulfill({ status: 500, body: JSON.stringify({ error: err.message }) });
        }
    });

    // OPTIONS preflight for both
    await context.route("**/api/solve", async (route) => {
        if (route.request().method() === "OPTIONS") {
            await route.fulfill({
                status: 204,
                headers: {
                    "access-control-allow-origin": "*",
                    "access-control-allow-headers": "content-type, x-ixl-token",
                    "access-control-allow-methods": "POST, OPTIONS"
                }
            });
        } else {
            route.fallback();
        }
    });

    console.log("[inject] API routes registered (CSP bypass)");
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
                try { await setupRoutes(context); } catch (e) { console.error("[inject] setupRoutes:", e.message); }

                // register init script once
                try {
                    const key = "__inited_" + Math.random();
                    if (!context.__ixlInitDone) {
                        context.__ixlInitDone = true;
                        await context.addInitScript({ content: scriptContent });
                        console.log("[inject] init script registered");
                    }
                } catch (err) {
                    console.error("[inject] addInitScript failed:", err.message);
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
                                try { window.__ixl_panel_injected__ = false; new Function(code)(); }
                                catch (e) { console.error("[inject-eval]", e.message); }
                            }, scriptContent).catch(() => { });
                            console.log("[inject] re-injected into", url.slice(0, 50));
                        } else {
                            await p.evaluate((code) => {
                                try { new Function(code)(); } catch (e) { console.error("[inject-eval]", e.message); }
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