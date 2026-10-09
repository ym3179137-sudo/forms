import { chromium, firefox } from "playwright";

const NAV_TIMEOUT = 20000;
const CONNECT_TIMEOUT = 4000;
const CONN_TTL_MS = 60 * 1000;

const connCache = new Map();

async function getBrowser(debugUrl, browserId) {
    if (browserId === "firefox") {
        return { browser: null, fresh: true, unsupported: true };
    }

    const cached = connCache.get(debugUrl);
    if (cached && Date.now() - cached.at < CONN_TTL_MS) {
        try {
            await cached.browser.contexts();
            return { browser: cached.browser, fresh: false, unsupported: false };
        } catch (_) {
            connCache.delete(debugUrl);
        }
    }

    const browser = await Promise.race([
        chromium.connectOverCDP(debugUrl),
        new Promise((_, reject) => setTimeout(() => reject(new Error("connect timeout")), CONNECT_TIMEOUT))
    ]);

    connCache.set(debugUrl, { browser, at: Date.now() });
    return { browser, fresh: true, unsupported: false };
}

export async function safeNavigate(debugUrl, url, browserId = "chrome", { retries = 1 } = {}) {
    if (browserId === "firefox") {
        return { ok: false, unsupported: true, reason: "firefox_no_cdp" };
    }

    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await navigateOnce(debugUrl, url, browserId);
        } catch (err) {
            lastErr = err;
            connCache.delete(debugUrl);
            if (attempt < retries) await new Promise(r => setTimeout(r, 400));
        }
    }
    throw lastErr || new Error("navigate failed");
}

async function navigateOnce(debugUrl, url, browserId) {
    const { browser, fresh } = await getBrowser(debugUrl, browserId);

    try {
        const contexts = browser.contexts();
        if (!contexts.length) throw new Error("no context");

        const context = contexts[0];
        const pages = context.pages();
        let page = pages.find(p => !p.isClosed());

        if (!page) page = await context.newPage();

        if (fresh) {
            try { await page.evaluate(() => 1); } catch (_) {
                try { await page.close(); } catch (_) { }
                page = await context.newPage();
            }
        }

        page.goto(url, { waitUntil: "commit", timeout: NAV_TIMEOUT })
            .catch(err => console.warn(`[nav] goto warn: ${err.message.slice(0, 80)}`));

        return { ok: true };
    } catch (err) {
        connCache.delete(debugUrl);
        throw err;
    }
}

setInterval(() => {
    const now = Date.now();
    for (const [url, entry] of connCache) {
        if (now - entry.at > CONN_TTL_MS) {
            try { entry.browser.close(); } catch (_) { }
            connCache.delete(url);
        }
    }
}, 30000);