// Streams chromium's viewport to the browser as JPEG frames via CDP screencast.

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
        quality: 55,
        maxWidth: 1366,
        maxHeight: 768,
        everyNthFrame: 1
    });

    return {
        cdp,
        stop: async () => {
            stopped = true;
            try { await cdp.send("Page.stopScreencast"); } catch (_) { }
            try { await cdp.detach(); } catch (_) { }
        }
    };
}