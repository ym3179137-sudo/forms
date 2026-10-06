export async function attachLiveView(page, onFrame) {
    const context = page.context();
    const cdp = await context.newCDPSession(page);

    let stopped = false;

    cdp.on("Page.screencastFrame", async (ev) => {
        if (stopped) return;
        try { onFrame(ev.data, ev.metadata); } catch (_) { }
        try { await cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }); } catch (_) { }
    });

    await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: 75,
        maxWidth: 1920,
        maxHeight: 1080,
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
        try {
            await page.setViewportSize({ width, height });
        } catch (_) { }
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