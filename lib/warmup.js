import { chromium } from "playwright";

const WARMUP_HOSTS = [
    "https://fonts.googleapis.com",
    "https://cdn.jsdelivr.net",
    "https://ajax.googleapis.com",
    "https://www.gstatic.com",
    "https://cdnjs.cloudflare.com",
    "https://unpkg.com",
    "https://www.google.com"
];

export async function warmup() {
    try {
        const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
        const context = browser.contexts()[0];
        if (!context) return;
        const page = await context.newPage();
        for (const host of WARMUP_HOSTS) {
            try {
                await page.goto(host, { waitUntil: "commit", timeout: 5000 });
            } catch (_) { }
        }
        await page.close();
        console.log("[warmup] CDN cache primed");
    } catch (err) {
        console.warn("[warmup] skipped:", err.message);
    }
}