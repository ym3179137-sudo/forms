import { chromium } from "playwright";

export async function createSession() {
    const browser = await chromium.launch({
        headless: false,
        args: [
            "--start-maximized",
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled"
        ]
    });

    const context = browser.contexts()[0] || await browser.newContext({
        viewport: { width: 1366, height: 768 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    });
    const page = await context.newPage();

    return {
        page,
        browser,
        sessionId: "local-chromium",
        client: { release: async () => { await browser.close().catch(() => { }); } },
        liveViewUrl: null,
        startedAt: Date.now()
    };
}