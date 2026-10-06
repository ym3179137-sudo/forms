import { chromium } from "playwright";
import fs from "fs";

const PROFILE_ROOT = "/tmp/ixl-profiles";

export async function createSession({ username } = {}) {
    const user = (username || "anon").replace(/[^a-zA-Z0-9_-]/g, "_");
    const profileDir = `${PROFILE_ROOT}/${user}`;

    try { fs.mkdirSync(profileDir, { recursive: true }); } catch (_) { }

    const context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        viewport: { width: 1280, height: 720 },
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
            "--window-size=1280,720",
            "--window-position=0,0",
            "--start-maximized",
            "--use-gl=swiftshader",
            "--enable-webgl",
            "--ignore-gpu-blocklist",
            "--disable-features=IsolateOrigins,site-per-process"
        ],
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        locale: "en-US"
    });

    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();
    await page.setViewportSize({ width: 1280, height: 720 }).catch(() => { });

    return {
        page,
        browser: context,
        sessionId: "profile-" + user,
        client: { release: async () => { try { await context.close(); } catch (_) { } } },
        liveViewUrl: null,
        startedAt: Date.now()
    };
}