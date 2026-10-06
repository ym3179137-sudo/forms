const FPS = 12;
const FRAME_WIDTH = 1366;
const FRAME_HEIGHT = 768;
const JPEG_QUALITY = 70;
const INTERVAL_MS = Math.round(1000 / FPS);

export async function attachLiveView(page, onFrame) {
    let stopped = false;
    let loopTimer = null;
    let busy = false;

    try { await page.bringToFront(); } catch (_) { }
    try { await page.setViewportSize({ width: FRAME_WIDTH, height: FRAME_HEIGHT }); } catch (_) { }

    async function loop() {
        if (stopped) return;
        if (busy) { loopTimer = setTimeout(loop, INTERVAL_MS); return; }
        busy = true;
        try {
            const buf = await page.screenshot({
                type: "jpeg",
                quality: JPEG_QUALITY,
                animations: "disabled",
                caret: "hide"
            });
            if (!stopped) onFrame(buf.toString("base64"));
        } catch (_) { }
        busy = false;
        if (!stopped) loopTimer = setTimeout(loop, INTERVAL_MS);
    }

    // start after first paint
    setTimeout(loop, 500);

    async function goBack() { try { await page.goBack({ timeout: 5000 }); } catch (_) { } }
    async function goForward() { try { await page.goForward({ timeout: 5000 }); } catch (_) { } }
    async function reload() { try { await page.reload({ timeout: 10000 }); } catch (_) { } }
    async function navigate(url) {
        if (!url) return;
        if (!/^https?:\/\//i.test(url)) url = "https://" + url;
        try { await page.goto(url, { waitUntil: "commit", timeout: 30000 }); } catch (_) { }
    }
    async function currentUrl() { try { return page.url(); } catch (_) { return ""; } }

    async function tryAutoLoginIxl(email, password) {
        try {
            const url = page.url();
            // detect ixl sign-in page
            const isSignin = /ixl\.com\/(signin|sign-in|login)/i.test(url) ||
                await page.evaluate(() => !!document.querySelector('input[type="email"], input[name="email"], input[name="username"]')).catch(() => false);
            if (!isSignin) return { ok: false, reason: "not on signin page" };

            // fill email
            const emailInput = await page.$('input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"]');
            if (emailInput) {
                await emailInput.click({ clickCount: 3 }).catch(() => { });
                await emailInput.type(email, { delay: 30 });
            }

            // click Next / Continue if it exists
            const nextBtn = await page.$('button[type="submit"], button:has-text("Next"), button:has-text("Continue"), button:has-text("Sign in")');
            if (nextBtn) { await nextBtn.click().catch(() => { }); await new Promise(r => setTimeout(r, 1500)); }

            // fill password
            const passInput = await page.$('input[type="password"], input[name="password"], input[autocomplete="current-password"]');
            if (passInput) {
                await passInput.click({ clickCount: 3 }).catch(() => { });
                await passInput.type(password, { delay: 30 });
            }

            // submit
            const submitBtn = await page.$('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")');
            if (submitBtn) { await submitBtn.click().catch(() => { }); }

            return { ok: true };
        } catch (err) {
            return { ok: false, reason: err.message };
        }
    }

    return {
        goBack, goForward, reload, navigate, currentUrl, tryAutoLoginIxl,
        stop: async () => {
            stopped = true;
            if (loopTimer) clearTimeout(loopTimer);
        }
    };
}