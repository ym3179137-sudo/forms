import fs from "fs";
import { chromium } from "playwright";
import axios from "axios";

let cdpBrowser = null;
let scriptContent = "";
let watching = false;
const routedContexts = new WeakSet();

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

    const forward = async (route, path, timeout) => {
        const req = route.request();
        if (req.method() === "OPTIONS") {
            return route.fulfill({
                status: 204,
                headers: {
                    "access-control-allow-origin": "*",
                    "access-control-allow-headers": "content-type, x-ixl-token",
                    "access-control-allow-methods": "POST, OPTIONS"
                }
            });
        }
        const body = req.postData() || "{}";
        const tk = req.headers()["x-ixl-token"] || "";
        try {
            const res = await axios.post("http://127.0.0.1:3000" + path, body, {
                headers: { "content-type": "application/json", "x-ixl-token": tk },
                validateStatus: () => true,
                timeout
            });
            await route.fulfill({
                status: res.status,
                headers: { "content-type": "application/json" },
                body: typeof res.data === "string" ? res.data : JSON.stringify(res.data)
            });
            console.log(`[route] ${path} -> ${res.status}`);
        } catch (err) {
            console.error(`[route] ${path} failed:`, err.message);
            await route.fulfill({
                status: 500,
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ error: err.message })
            });
        }
    };

    await context.route("**/api/solve", (route) => forward(route, "/api/solve", 25000));
    await context.route("**/api/feedback", (route) => forward(route, "/api/feedback", 10000));

    console.log("[inject] API routes registered (same-origin)");
}

async function patchPageCSP(page) {
    try {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Page.setBypassCSP", { enabled: true });
        console.log("[inject] CSP bypass applied to", (page.url() || "").slice(0, 40));
    } catch (err) {
        console.error("[inject] setBypassCSP failed:", err.message.slice(0, 80));
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
                try { await setupRoutes(context); } catch (e) { console.error("[inject] setupRoutes:", e.message); }

                if (!context.__ixlInitDone) {
                    context.__ixlInitDone = true;
                    try {
                        await context.addInitScript({ content: scriptContent });
                        console.log("[inject] init script registered");
                    } catch (err) {
                        console.error("[inject] addInitScript failed:", err.message);
                    }
                }

                const pages = context.pages();
                for (const p of pages) {
                    try {
                        const url = p.url();
                        if (!url || url.startsWith("chrome://") || url.startsWith("devtools://") || url.startsWith("about:")) continue;

                        if (!p.__cspBypassed) {
                            p.__cspBypassed = true;
                            await patchPageCSP(p);
                        }

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