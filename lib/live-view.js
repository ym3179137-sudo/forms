const MIN_FRAME_INTERVAL_MS = 66;
const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;
const JPEG_QUALITY = 55;
const SCREENSHOT_FALLBACK_FPS = 8;   // if screencast fails, screenshot this often
const WATCHDOG_MS = 3000;            // no frame in 3s → fallback

export async function attachLiveView(page, onFrame) {
    const context = page.context();
    const cdp = await context.newCDPSession(page);

    let stopped = false;
    let lastSend = 0;
    let screencastFrameCount = 0;
    let fallbackTimer = null;
    let watchdogTimer = null;
    let usingFallback = false;

    // bring the page forward so xvfb composites it
    try { await page.bringToFront(); } catch (_) { }

    cdp.on("Page.screencastFrame", async (ev) => {
        if (stopped) return;
        screencastFrameCount++;
        const now = Date.now();

        if (now - lastSend >= MIN_FRAME_INTERVAL_MS) {
            lastSend = now;
            try { onFrame(ev.data); } catch (_) { }
        }

        try {
            await cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId });
        } catch (_) { }
    });

    try {
        await cdp.send("Page.startScreencast", {
            format: "jpeg",
            quality: JPEG_QUALITY,
            maxWidth: FRAME_WIDTH,
            maxHeight: FRAME_HEIGHT,
            everyNthFrame: 1
        });
        console.log("[live-view] screencast started");
    } catch (err) {
        console.warn("[live-view] screencast start failed:", err.message);
        startFallback();
    }

    // watchdog: if no frames in WATCHDOG_MS, switch to screenshot loop
    watchdogTimer = setTimeout(() => {
        if (stopped) return;
        if (screencastFrameCount === 0) {
            console.warn("[live-view] no screencast frames in 3s — switching to screenshot fallback");
            startFallback();
        }
    }, WATCHDOG_MS);

    async function startFallback() {
        if (usingFallback || stopped) return;
        usingFallback = true;
        try { await cdp.send("Page.stopScreencast"); } catch (_) { }

        const interval = Math.round(1000 / SCREENSHOT_FALLBACK_FPS);
        fallbackTimer = setInterval(async () => {
            if (stopped) { clearInterval(fallbackTimer); return; }
            try {
                const buf = await page.screenshot({
                    type: "jpeg",
                    quality: JPEG_QUALITY,
                    clip: { x: 0, y: 0, width: FRAME_WIDTH, height: FRAME_HEIGHT }
                });
                onFrame(buf.toString("base64"));
            } catch (err) {
                // swallow
            }
        }, interval);
        console.log(`[live-view] fallback running at ${SCREENSHOT_FALLBACK_FPS}fps`);
    }

    async function goBack() { try { await page.goBack({ timeout: 5000 }); } catch (_) { } }
    async function goForward() { try { await page.goForward({ timeout: 5000 }); } catch (_) { } }
    async function reload() { try { await page.reload({ timeout: 10000 }); } catch (_) { } }
    async function navigate(url) {
        if (!url) return;
        if (!/^https?:\/\//i.test(url)) url = "https://" + url;
        try { await page.goto(url, { waitUntil: "commit", timeout: 30000 }); } catch (_) { }
    }
    async function currentUrl() { try { return page.url(); } catch (_) { return ""; } }
    async function resize(width, height) {
        try { await page.setViewportSize({ width, height }); } catch (_) { }
    }

    return {
        cdp,
        goBack, goForward, reload, navigate, currentUrl, resize,
        stop: async () => {
            stopped = true;
            if (watchdogTimer) clearTimeout(watchdogTimer);
            if (fallbackTimer) clearInterval(fallbackTimer);
            try { await cdp.send("Page.stopScreencast"); } catch (_) { }
            try { await cdp.detach(); } catch (_) { }
            console.log("[live-view] stopped");
        }
    };
}