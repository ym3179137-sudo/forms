import fs from "fs";
import { chromium } from "playwright";
import axios from "axios";

let cdpBrowser = null;
let scripts = {};
let watching = false;
const routedContexts = new WeakSet();

export async function ensureInjected() {
    const files = {
        ixl: "/app/chromium-ext/content.js",
        forms: "/app/chromium-ext/forms.js",
        wayground: "/app/chromium-ext/wayground.js",
        blooket: "/app/chromium-ext/blooket.js"
    };
    for (const [k, p] of Object.entries(files)) {
        try {
            scripts[k] = fs.readFileSync(p, "utf8");
            console.log(`[inject] ${k}: ${scripts[k].length} bytes`);
        } catch (e) {
            console.error(`[inject] cannot read ${k}:`, e.message);
            scripts[k] = "";
        }
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
        console.log(`[inject] connect failed: ${err.message.slice(0, 120)}`);
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
            console.error(`[route] ${path} failed:`, err.message.slice(0, 100));
            await route.fulfill({ status: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: err.message }) });
        }
    };

    await context.route("**/api/solve", (route) => forward(route, "/api/solve", 32000));
    await context.route("**/api/solve-form", (route) => forward(route, "/api/solve-form", 45000));
    await context.route("**/api/feedback", (route) => forward(route, "/api/feedback", 10000));

    console.log("[inject] API routes registered");
}

async function patchPageCSP(page) {
    try {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Page.setBypassCSP", { enabled: true });
    } catch (_) { }
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
            for (const context of contexts) {
                try { await setupRoutes(context); } catch (e) { console.error("[inject] routes:", e.message); }

                if (!context.__initDone) {
                    context.__initDone = true;
                    try {
                        if (scripts.ixl) await context.addInitScript({ content: scripts.ixl });
                        if (scripts.forms) await context.addInitScript({ content: scripts.forms });
                        if (scripts.wayground) await context.addInitScript({ content: scripts.wayground });
                        if (scripts.blooket) await context.addInitScript({ content: scripts.blooket });
                        console.log("[inject] init scripts registered");
                    } catch (err) {
                        console.error("[inject] addInitScript failed:", err.message);
                    }
                }

                const pages = context.pages();
                for (const p of pages) {
                    try {
                        const url = p.url();
                        if (!url || url.startsWith("chrome://") || url.startsWith("devtools://") || url.startsWith("about:")) continue;

                        if (!p.__cspBypassed) { p.__cspBypassed = true; await patchPageCSP(p); }

                        const onIxl = /ixl\.com/.test(url);
                        const onForms = /docs\.google\.com\/forms|forms\.gle/.test(url);
                        const onWayground = /quizizz\.com|wayground\.com/.test(url);
                        const onBlooket = /blooket\.com/.test(url);

                        const inject = async (script, panelId, flagName) => {
                            if (!script) return;
                            const has = await p.evaluate((id) => !!document.getElementById(id), panelId).catch(() => false);
                            if (has) return;
                            await p.evaluate((code, flag) => {
                                try {
                                    window[flag] = false;
                                    new Function(code)();
                                } catch (e) { console.error("[inject-eval]", e.message); }
                            }, script, flagName).catch(() => { });
                            console.log(`[inject] ${flagName} → ${url.slice(0, 50)}`);
                        };

                        if (onIxl) await inject(scripts.ixl, "__ixl_panel", "__ixl_panel_injected__");
                        else if (onForms) await inject(scripts.forms, "__gforms_panel", "__ixl_forms_injected__");
                        else if (onWayground) await inject(scripts.wayground, "__wg_panel", "__wayground_injected__");
                        else if (onBlooket) await inject(scripts.blooket, "__bk_panel", "__blooket_injected__");
                    } catch (err) {
                        console.error("[inject] page error:", err.message.slice(0, 100));
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