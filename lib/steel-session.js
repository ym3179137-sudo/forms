import { chromium } from "playwright";
import fs from "fs";

const PROFILE_ROOT = "/tmp/ixl-profiles";
const LAUNCH_TIMEOUT_MS = 90 * 1000;

function safeName(s) { return (s || "anon").replace(/[^a-zA-Z0-9_-]/g, "_"); }

async function launchBrowser(profileDir) {
    return await chromium.launchPersistentContext(profileDir, {
        headless: false,
        viewport: { width: 1366, height: 768 },
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
            "--use-gl=swiftshader",
            "--enable-webgl",
            "--ignore-gpu-blocklist",
            "--hide-scrollbars",
            "--mute-audio",
            "--disable-features=IsolateOrigins,site-per-process"
        ],
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        locale: "en-US"
    });
}

export async function createSession({ username } = {}) {
    const user = safeName(username);
    const profileDir = `${PROFILE_ROOT}/${user}`;
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch (_) { }

    console.log(`[browser] launching chromium for ${user}...`);
    let context;
    try {
        context = await Promise.race([
            launchBrowser(profileDir),
            new Promise((_, rej) => setTimeout(() => rej(new Error("chromium launch timeout (90s)")), LAUNCH_TIMEOUT_MS))
        ]);
    } catch (err) {
        console.error(`[browser] launch failed: ${err.message}`);
        try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) { }
        throw err;
    }

    console.log(`[browser] launched for ${user}`);

    const pages = context.pages();
    const page = pages.length > 0 ? pages[0] : await context.newPage();
    try { await page.setViewportSize({ width: 1366, height: 768 }); } catch (_) { }

    return {
        page,
        browser: context,
        sessionId: "profile-" + user,
        client: { release: async () => { try { await context.close(); } catch (_) { } } },
        liveViewUrl: null,
        startedAt: Date.now()
    };
}