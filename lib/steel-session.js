import { chromium } from "playwright";

export async function createSession() {
    const browser = await chromium.launch({
        headless: false,
        args: ["--start-maximized"]
    });

    const context = browser.contexts()[0] || await browser.newContext({ viewport: null });
    const page = await context.newPage();

    return {
        page,
        browser,
        sessionId: "local-chromium",
        client: {
            release: async () => { await browser.close().catch(() => { }); }
        },
        liveViewUrl: null,
        startedAt: Date.now()
    };
}