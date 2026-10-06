const FPS = 10;
const INTERVAL_MS = Math.round(1000 / FPS);
const JPEG_QUALITY = 65;

export async function attachLiveView(page, onFrame) {
    let stopped = false;
    let loopTimer = null;
    let busy = false;
    let frameOk = 0;
    let frameErr = 0;

    console.log("[live-view] attaching...");

    try { await page.bringToFront(); } catch (_) { }

    async function loop() {
        if (stopped) return;
        if (busy) { loopTimer = setTimeout(loop, INTERVAL_MS); return; }
        busy = true;

        try {
            const buf = await page.screenshot({ type: "jpeg", quality: JPEG_QUALITY, fullPage: false });
            if (!stopped && buf && buf.length > 0) {
                onFrame(buf.toString("base64"));
                frameOk++;
                if (frameOk === 1) console.log("[live-view] first frame ok");
            }
        } catch (err) {
            frameErr++;
            if (frameErr <= 3 || frameErr % 50 === 0) {
                console.error(`[live-view] screenshot error #${frameErr}:`, err.message);
            }
        }
        busy = false;
        if (!stopped) loopTimer = setTimeout(loop, INTERVAL_MS);
    }

    setTimeout(loop, 300);

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
            const onSignin = await page.evaluate(() => {
                return !!document.querySelector('input[type="email"], input[name="email"], input[name="username"], input[type="password"]');
            }).catch(() => false);
            if (!onSignin) return { ok: false, reason: "not on a login page" };

            const emailEl = await page.$('input[type="email"], input[name="email"], input[name="username"], input[autocomplete="username"]');
            if (emailEl) {
                await emailEl.click({ clickCount: 3 }).catch(() => { });
                await emailEl.type(email, { delay: 25 });
            }

            const nextBtn = await page.$('button[type="submit"], button:has-text("Next"), button:has-text("Continue")');
            if (nextBtn) { await nextBtn.click().catch(() => { }); await new Promise(r => setTimeout(r, 1500)); }

            const passEl = await page.$('input[type="password"], input[name="password"], input[autocomplete="current-password"]');
            if (passEl) {
                await passEl.click({ clickCount: 3 }).catch(() => { });
                await passEl.type(password, { delay: 25 });
            }

            const subBtn = await page.$('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")');
            if (subBtn) { await subBtn.click().catch(() => { }); }

            return { ok: true };
        } catch (err) {
            return { ok: false, reason: err.message };
        }
    }

    return {
        page,
        cdp: null,
        goBack, goForward, reload, navigate, currentUrl, tryAutoLoginIxl,
        stop: async () => {
            stopped = true;
            if (loopTimer) clearTimeout(loopTimer);
            console.log(`[live-view] stopped (ok=${frameOk}, err=${frameErr})`);
        }
    };
}