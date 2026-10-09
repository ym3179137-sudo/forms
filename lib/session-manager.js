import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import net from "net";
import { chromium } from "playwright";
import {
    BROWSERS,
    BROWSER_FILL_ORDER,
    pickNextBrowser,
    browserFallbackOrder,
    usageByBrowser,
    totalCapacity
} from "./browsers.js";

const IDLE_TIMEOUT_MS = 20 * 60 * 1000;
const STARTUP_TIMEOUT_MS = 20 * 1000;
const PROFILE_ROOT = process.env.PROFILE_ROOT || "/data/profiles";

const DISPLAY_BASE = 100;
const VNC_PORT_BASE = 5901;
const WS_PORT_BASE = 6081;
const DEBUG_PORT_BASE = 9223;

const sessions = new Map();
const userToSession = new Map();
const queue = [];
let nextSlotIndex = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const WARM_PREFS = {
    chrome: {
        "profile.default_content_setting_values.notifications": 2,
        "profile.default_content_setting_values.geolocation": 2,
        "credentials_enable_service": false,
        "profile.password_manager_enabled": false,
        "profile.exit_type": "Normal",
        "profile.exited_cleanly": true,
        "browser.check_default_browser": false,
        "browser.suppress_first_run_bubble": true
    },
    brave: {
        "brave.shields.stats.badges": false,
        "brave.rewards.enabled": false,
        "brave.wallet.enabled": false,
        "brave.new_tab_page.show_brave_stats": false,
        "browser.suppress_first_run_bubble": true,
        "profile.exit_type": "Normal",
        "profile.exited_cleanly": true
    },
    edge: {
        "browser.suppress_first_run_bubble": true,
        "edge_firstrun_completed": true,
        "profile.exit_type": "Normal",
        "profile.exited_cleanly": true,
        "browser.check_default_browser": false
    }
};

function seedWarmPrefs(browserId, profileDir) {
    try {
        const prefs = WARM_PREFS[browserId];
        if (!prefs) return;
        const prefDir = path.join(profileDir, "Default");
        fs.mkdirSync(prefDir, { recursive: true });
        const prefFile = path.join(prefDir, "Preferences");
        if (fs.existsSync(prefFile)) return;
        fs.writeFileSync(prefFile, JSON.stringify(prefs));
    } catch (_) { }
}

function allocSlot() {
    const used = new Set(Array.from(sessions.values()).map(s => s.slot));
    for (let i = 0; i < 64; i++) {
        const slot = (nextSlotIndex + i) % 64;
        if (!used.has(slot)) {
            nextSlotIndex = slot + 1;
            return slot;
        }
    }
    throw new Error("no slot available");
}

function sessionPorts(slot) {
    return {
        display: DISPLAY_BASE + slot,
        vncPort: VNC_PORT_BASE + slot,
        wsPort: WS_PORT_BASE + slot,
        debugPort: DEBUG_PORT_BASE + slot
    };
}

async function waitForPort(port, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const open = await new Promise((resolve) => {
            const s = net.createConnection({ host: "127.0.0.1", port });
            let done = false;
            const finish = (v) => { if (!done) { done = true; try { s.destroy(); } catch (_) { } resolve(v); } };
            s.once("connect", () => finish(true));
            s.once("error", () => finish(false));
            setTimeout(() => finish(false), 250);
        });
        if (open) return true;
        await sleep(100);
    }
    return false;
}

async function browserReady(debugPort) {
    try {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(1500) });
        return res.ok;
    } catch (_) {
        return false;
    }
}

// ─── per-session injection ──────────────────────────────
async function setupInjection(debugPort) {
    const files = {
        ixl: "/app/chromium-ext/content.js",
        forms: "/app/chromium-ext/forms.js",
        wayground: "/app/chromium-ext/wayground.js",
        blooket: "/app/chromium-ext/blooket.js",
        blooketBypass: "/app/chromium-ext/blooket-bypass.js"
    };
    const scripts = {};
    for (const [k, p] of Object.entries(files)) {
        try { scripts[k] = fs.readFileSync(p, "utf8"); }
        catch (_) { scripts[k] = ""; }
    }

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    try {
        const contexts = browser.contexts();
        if (!contexts.length) return;
        const context = contexts[0];

        const forward = async (route, apiPath, timeout) => {
            const req = route.request();
            if (req.method() === "OPTIONS") {
                return route.fulfill({
                    status: 204,
                    headers: {
                        "access-control-allow-origin": "*",
                        "access-control-allow-headers": "content-type, x-ixl-token",
                        "access-control-allow-methods": "POST, OPTIONS"
                    }
                });
            }
            const body = req.postData() || "{}";
            const tk = req.headers()["x-ixl-token"] || "";
            try {
                const axios = (await import("axios")).default;
                const res = await axios.post("http://127.0.0.1:3000" + apiPath, body, {
                    headers: { "content-type": "application/json", "x-ixl-token": tk },
                    validateStatus: () => true,
                    timeout
                });
                await route.fulfill({
                    status: res.status,
                    headers: { "content-type": "application/json" },
                    body: typeof res.data === "string" ? res.data : JSON.stringify(res.data)
                });
            } catch (err) {
                await route.fulfill({
                    status: 500,
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ error: err.message })
                });
            }
        };

        await context.route("**/api/solve", (r) => forward(r, "/api/solve", 32000));
        await context.route("**/api/solve-form", (r) => forward(r, "/api/solve-form", 45000));
        await context.route("**/api/feedback", (r) => forward(r, "/api/feedback", 10000));

        if (scripts.ixl) await context.addInitScript({ content: scripts.ixl });
        if (scripts.forms) await context.addInitScript({ content: scripts.forms });
        if (scripts.wayground) await context.addInitScript({ content: scripts.wayground });
        if (scripts.blooket) await context.addInitScript({ content: scripts.blooket });
        if (scripts.blooketBypass) await context.addInitScript({ content: scripts.blooketBypass });

        // ⚡ force-reload any pages already open so the init scripts actually run on them
        const pages = context.pages();
        for (const p of pages) {
            const u = p.url();
            if (!u || u.startsWith("chrome://") || u === "about:blank") continue;
            try { await p.reload({ waitUntil: "commit", timeout: 5000 }); }
            catch (_) { }
        }

        console.log(`[inject] hooks registered on port ${debugPort}`);
    } finally {
        try { await browser.close(); } catch (_) { }
    }
}

// ─── public API ─────────────────────────────────────────
export async function startSession(username, { url = "https://www.ixl.com/", preferredBrowser = null, token = "" } = {}) {
    if (userToSession.has(username)) {
        const existing = sessions.get(userToSession.get(username));
        if (existing && await browserReady(existing.ports.debugPort)) {
            return existing;
        }
        if (existing) await killSession(existing.sessionId);
    }

    const currentSessions = Array.from(sessions.values());

    let targetBrowser = null;
    if (preferredBrowser && BROWSERS[preferredBrowser]?.enabled) {
        const counts = usageByBrowser(currentSessions);
        if (counts[preferredBrowser] < BROWSERS[preferredBrowser].maxSessions) {
            targetBrowser = preferredBrowser;
        }
    }
    if (!targetBrowser) {
        targetBrowser = pickNextBrowser(currentSessions);
    }

    if (!targetBrowser) {
        return await joinQueue(username, url, preferredBrowser, token);
    }

    return await spawnSession(username, url, targetBrowser, token);
}

function joinQueue(username, url, preferredBrowser, token = "") {
    return new Promise((resolve, reject) => {
        const existing = queue.find(q => q.username === username);
        if (existing) { existing.resolve = resolve; existing.reject = reject; return; }
        queue.push({ username, url, preferredBrowser, token, resolve, reject, enqueuedAt: Date.now() });
    });
}

function queuePosition(username) {
    const idx = queue.findIndex(q => q.username === username);
    return idx === -1 ? null : idx + 1;
}

async function spawnSession(username, url, preferredBrowser = null, token = "") {
    const order = browserFallbackOrder(preferredBrowser);
    let lastErr = null;

    for (const browserId of order) {
        const b = BROWSERS[browserId];
        if (!b || !b.enabled) continue;

        const currentSessions = Array.from(sessions.values());
        const counts = usageByBrowser(currentSessions);
        if (counts[browserId] >= b.maxSessions) {
            console.log(`[session] ${browserId} at cap (${counts[browserId]}/${b.maxSessions}), trying next`);
            continue;
        }

        try {
            return await spawnWithBrowser(username, url, browserId, token);
        } catch (err) {
            lastErr = err;
            console.warn(`[session] ${browserId} failed for ${username}: ${err.message}`);
        }
    }
    throw lastErr || new Error("all browsers failed");
}

async function spawnWithBrowser(username, url, browserId, token = "") {
    const config = BROWSERS[browserId];
    const slot = allocSlot();
    const ports = sessionPorts(slot);
    const sessionId = `s_${browserId[0]}_${slot}_${Date.now()}`;
    const profileDir = path.join(PROFILE_ROOT, browserId, username.replace(/[^a-z0-9_-]/gi, "_"));
    fs.mkdirSync(profileDir, { recursive: true });

    seedWarmPrefs(browserId, profileDir);

    // append token to URL so injected scripts can authenticate
    let spawnUrl = url;
    if (token) {
        const sep = url.includes("?") ? "&" : "?";
        spawnUrl = `${url}${sep}ixl_solver_token=${encodeURIComponent(token)}`;
    }

    console.log(`[session] start ${sessionId} user=${username} browser=${browserId} url=${spawnUrl.slice(0, 80)}`);

    const xvfb = spawn("Xvfb", [
        `:${ports.display}`,
        "-screen", "0", "1280x720x24",
        "-ac", "+extension", "GLX", "+render",
        "-noreset", "-nolisten", "tcp",
        "-nolisten", "unix",
        "+iglx",
        "-dpi", "96"
    ], { stdio: ["ignore", "ignore", "ignore"] });

    const x11vnc = spawn("x11vnc", [
        "-display", `:${ports.display}`,
        "-nopw", "-forever", "-shared",
        "-rfbport", String(ports.vncPort),
        "-xkb", "-noxrecord", "-noxfixes", "-noxdamage",
        "-wait", "5", "-defer", "5", "-threads", "-ping", "5",
        "-quiet",
        "-norc",
        "-repeat",
        "-nowf"
    ], { stdio: ["ignore", "ignore", "ignore"] });

    const websockify = spawn("websockify", [
        "--web", "/usr/share/novnc",
        String(ports.wsPort),
        `localhost:${ports.vncPort}`
    ], { stdio: ["ignore", "ignore", "ignore"] });

    const xlock = `/tmp/.X${ports.display}-lock`;
    let xvfbReady = false;
    for (let i = 0; i < 80; i++) {
        if (fs.existsSync(xlock)) { xvfbReady = true; break; }
        await sleep(100);
    }
    if (!xvfbReady) {
        for (const p of [xvfb, x11vnc, websockify]) { try { p.kill("SIGKILL"); } catch (_) { } }
        throw new Error("Xvfb failed");
    }

    const [vncOK, wsOK] = await Promise.all([
        waitForPort(ports.vncPort, STARTUP_TIMEOUT_MS),
        waitForPort(ports.wsPort, 8000)
    ]);
    if (!vncOK || !wsOK) {
        for (const p of [xvfb, x11vnc, websockify]) { try { p.kill("SIGKILL"); } catch (_) { } }
        throw new Error("x11vnc/websockify failed");
    }

    let browser;
    if (browserId === "firefox") {
        browser = spawnFirefox(config.bin, profileDir, ports, spawnUrl);
    } else {
        browser = spawnChromiumFamily(config.bin, profileDir, ports, spawnUrl, browserId);
    }

    let debugReady = false;
    for (let i = 0; i < 100; i++) {
        if (await browserReady(ports.debugPort)) { debugReady = true; break; }
        if (browser.exitCode !== null) break;
        await sleep(150);
    }

    if (!debugReady) {
        for (const p of [browser, websockify, x11vnc, xvfb]) {
            try { p.kill("SIGKILL"); } catch (_) { }
        }
        throw new Error(`${browserId} failed to start`);
    }

    // inject cheats + reload open pages
    try {
        await setupInjection(ports.debugPort);
    } catch (err) {
        console.warn(`[session] injection warn: ${err.message}`);
    }

    const session = {
        sessionId,
        username,
        browser: browserId,
        slot,
        ports,
        profileDir,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        procs: { xvfb, x11vnc, websockify, browser },
        debugUrl: `http://127.0.0.1:${ports.debugPort}`,
        token,
        dead: false
    };

    browser.on("exit", async (code) => {
        if (session.dead) return;
        session.dead = true;
        console.warn(`[session] ${browserId} died ${sessionId} code=${code}`);
        await killSession(sessionId, true);
        const stillThere = Date.now() - session.lastActivity < IDLE_TIMEOUT_MS;
        if (stillThere) {
            setTimeout(() => {
                spawnSession(username, url, browserId, token).catch(err => console.error(`[restart] ${err.message}`));
            }, 500);
        }
    });

    sessions.set(sessionId, session);
    userToSession.set(username, sessionId);
    const counts = usageByBrowser(Array.from(sessions.values()));
    console.log(`[session] ready ${sessionId} browser=${browserId} (${counts[browserId]}/${config.maxSessions} on ${browserId}, ${sessions.size}/${totalCapacity()} total)`);
    return session;
}

function spawnChromiumFamily(bin, profileDir, ports, url, label) {
    const args = [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-hang-monitor",
        "--disable-prompt-on-repost",
        "--disable-features=IsolateOrigins,site-per-process,Translate,BackForwardCache,ChromeWhatsNewUI,ChromeVariations,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion,PasswordManagerOnboarding,AutofillServerCommunication,OptimizationGuideModelDownloading",
        "--disable-sync",
        "--disable-default-apps",
        "--disable-component-update",
        "--disable-client-side-phishing-detection",
        "--disable-infobars",
        "--no-first-run",
        "--no-default-browser-check",
        "--no-pings",
        "--password-store=basic",
        "--use-mock-keychain",
        "--disable-session-crashed-bubble",
        "--hide-crash-restore-bubble",
        "--disable-breakpad",
        "--disable-crash-reporter",
        "--disable-domain-reliability",
        "--disable-ipc-flooding-protection",
        "--enable-features=NetworkServiceInProcess2",
        "--enable-features=UseOzonePlatform",
        "--ozone-platform=x11",
        "--enable-quic",
        "--renderer-process-limit=1",
        "--disable-site-isolation-trials",
        "--disk-cache-size=536870912",
        "--media-cache-size=134217728",
        "--aggressive-cache-discard",
        `--remote-debugging-port=${ports.debugPort}`,
        "--remote-debugging-address=127.0.0.1",
        "--remote-allow-origins=*",
        `--app=${url}`,
        "--window-position=0,0",
        "--window-size=1280,720",
        `--user-data-dir=${profileDir}`
    ];

    if (label === "brave") {
        args.push("--disable-features=BraveRewards,BraveAds,BraveWallet,BraveShields,BraveNews");
    }
    if (label === "edge") {
        args.push("--edge-skip-compat-layer-relaunch", "--disable-features=msEdgeSidebarV2,msEdgeShoppingAssistant");
    }

    return spawn(bin, args, {
        env: { ...process.env, DISPLAY: `:${ports.display}` },
        stdio: ["ignore", "ignore", "ignore"]
    });
}

function spawnFirefox(bin, profileDir, ports, url) {
    try {
        const userJs = path.join(profileDir, "user.js");
        if (!fs.existsSync(userJs)) {
            fs.writeFileSync(userJs, `
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.page", 0);
user_pref("toolkit.telemetry.enabled", false);
user_pref("toolkit.telemetry.unified", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("browser.newtabpage.activity-stream.feeds.telemetry", false);
user_pref("browser.newtabpage.activity-stream.telemetry", false);
user_pref("browser.ping-centre.telemetry", false);
user_pref("browser.tabs.crashReporting.sendReport", false);
user_pref("breakpad.reportURL", "");
user_pref("browser.crashReports.unsubmittedCheck.enabled", false);
user_pref("network.http.max-connections", 900);
user_pref("network.http.max-persistent-connections-per-server", 10);
user_pref("network.predictor.enabled", true);
user_pref("network.predictor.enable-prefetch", true);
user_pref("network.http.speculative-parallel-limit", 12);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("dom.ipc.processCount", 1);
user_pref("dom.ipc.processCount.webIsolated", 1);
user_pref("fission.autostart", false);
user_pref("gfx.webrender.all", true);
user_pref("layers.acceleration.force-enabled", true);
user_pref("nglayout.initialpaint.delay", 0);
user_pref("nglayout.initialpaint.delay_in_oopif", 0);
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.warnOnQuit", false);
user_pref("browser.newtabpage.enabled", false);
`);
        }
    } catch (_) { }

    return spawn(bin, [
        "--no-remote",
        "--new-instance",
        "-profile", profileDir,
        "-width", "1280",
        "-height", "720",
        "--remote-debugging-port", String(ports.debugPort),
        "-setDefaultBrowser", "never",
        url
    ], {
        env: {
            ...process.env,
            DISPLAY: `:${ports.display}`,
            MOZ_DISABLE_CONTENT_SANDBOX: "1",
            MOZ_DISABLE_GMP_SANDBOX: "1",
            MOZ_DISABLE_RDD_SANDBOX: "1",
            MOZ_DISABLE_SOCKET_PROCESS_SANDBOX: "1",
            MOZ_CRASHREPORTER_DISABLE: "1",
            MOZ_CRASHREPORTER: "0"
        },
        stdio: ["ignore", "ignore", "ignore"]
    });
}

export function touchSession(username) {
    const s = getSession(username);
    if (s) s.lastActivity = Date.now();
}

export async function killSession(sessionId, quiet = false) {
    const s = sessions.get(sessionId);
    if (!s) return;
    if (!quiet) console.log(`[session] kill ${sessionId} user=${s.username}`);
    for (const name of ["browser", "websockify", "x11vnc", "xvfb"]) {
        const p = s.procs[name];
        if (p && !p.killed) {
            try { p.kill("SIGTERM"); } catch (_) { }
            setTimeout(() => { try { p.kill("SIGKILL"); } catch (_) { } }, 1200);
        }
    }
    sessions.delete(sessionId);
    if (userToSession.get(s.username) === sessionId) userToSession.delete(s.username);

    if (queue.length > 0) {
        const next = queue.shift();
        spawnSession(next.username, next.url, next.preferredBrowser, next.token)
            .then(session => next.resolve(session))
            .catch(err => next.reject(err));
    }
}

async function reapIdleSessions() {
    const now = Date.now();
    for (const [id, s] of sessions) {
        if (now - s.lastActivity > IDLE_TIMEOUT_MS) {
            killSession(id);
        }
    }
}
setInterval(reapIdleSessions, 60 * 1000);

export async function getOrCreateSession(username, opts) {
    return await startSession(username, opts);
}

export function getSession(username) {
    const id = userToSession.get(username);
    return id ? sessions.get(id) : null;
}

export function getQueueInfo(username) {
    const pos = queuePosition(username);
    const counts = usageByBrowser(Array.from(sessions.values()));
    return {
        inQueue: pos !== null,
        position: pos,
        totalActive: sessions.size,
        maxActive: totalCapacity(),
        queued: queue.length,
        usageByBrowser: counts,
        capsByBrowser: Object.fromEntries(
            BROWSER_FILL_ORDER.map(id => [id, BROWSERS[id]?.maxSessions || 0])
        )
    };
}

export function stats() {
    const counts = usageByBrowser(Array.from(sessions.values()));
    const usedRAM = Array.from(sessions.values()).reduce((sum, s) => sum + (BROWSERS[s.browser]?.ramMB || 700), 0);
    return {
        active: sessions.size,
        max: totalCapacity(),
        queued: queue.length,
        usedRAMMB: usedRAM,
        usageByBrowser: counts,
        capsByBrowser: Object.fromEntries(
            BROWSER_FILL_ORDER.map(id => [id, BROWSERS[id]?.maxSessions || 0])
        ),
        sessions: Array.from(sessions.values()).map(s => ({
            sessionId: s.sessionId,
            username: s.username,
            browser: s.browser,
            slot: s.slot,
            lastActivity: s.lastActivity,
            createdAt: s.createdAt
        }))
    };
}

process.on("SIGTERM", async () => {
    for (const id of Array.from(sessions.keys())) killSession(id, true);
    await sleep(1500);
    process.exit(0);
});