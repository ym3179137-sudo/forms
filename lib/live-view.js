const MIN_FRAME_INTERVAL_MS = 66;  // max ~15fps
const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;
const JPEG_QUALITY = 55;

export async function attachLiveView(page, onFrame) {
    const context = page.context();
    const cdp = await context.newCDPSession(page);

    let stopped = false;
    let lastSend = 0;

    cdp.on("Page.screencastFrame", async (ev) => {
        if (stopped) return;
        const now = Date.now();

        if (now - lastSend >= MIN_FRAME_INTERVAL_MS) {
            lastSend = now;
            try { onFrame(ev.data); } catch (_) { }
        }

        try {
            await cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId });
        } catch (_) { }
    });

    await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: JPEG_QUALITY,
        maxWidth: FRAME_WIDTH,
        maxHeight: FRAME_HEIGHT,
        everyNthFrame: 1
    });

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
            try { await cdp.send("Page.stopScreencast"); } catch (_) { }
            try { await cdp.detach(); } catch (_) { }
        }
    };
}