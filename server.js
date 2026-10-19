import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import net from "net";
import { chromium } from "playwright";
import { BROWSERS, BROWSER_FILL_ORDER, pickNextBrowser, browserFallbackOrder, usageByBrowser, totalCapacity } from "./browsers.js";

const IDLE_TIMEOUT_MS = 20 * 60 * 1000;
const STARTUP_TIMEOUT_MS = 20 * 1000;
const PROFILE_ROOT = process.env.PROFILE_ROOT || "/data/profiles";

const DISPLAY_BASE = 100;
const VNC_PORT_BASE = 5901;
const WS_PORT_BASE = 6081;
const DEBUG_PORT_BASE = 9223;

const sessions = new Map();
const userAppToSession = new Map();
const queue = [];
let nextSlotIndex = 0;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const WARM_PREFS = {
    chrome: {
        "profile.default_content_setting_values.notifications": 2,
        "profile.default_content_setting_values.geolocation": 2,
        "credentials_enable_service": false,
        "profile.password_manager_enabled": false,
        "profile.exit_type": "Crashed",
        "profile.exited_cleanly": false,
        "browser.check_default_browser": false,
        "browser.suppress_first_run_bubble": true
    }
};

function seedWarmPrefs(browserId, profileDir) {
    try {
        const prefs = WARM_PREFS[browserId];
        if (!prefs) return;
        const prefDir = path.join(profileDir, "Default");
        fs.mkdirSync(prefDir, { recursive: true });
        const prefFile = path.join(prefDir, "Preferences");
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

function appIdForUrl(url) {
    if (/ixl\.com/.test(url)) return "ixl";
    if (/blooket\.com/.test(url)) return "blooket";
    if (/wayground\.com|quizizz\.com/.test(url)) return "wayground";
    if (/kahoot\.(it|com)/.test(url)) return "kahoot";
    if (/docs\.google\.com\/forms|forms\.gle/.test(url)) return "forms";
    return "unblock";
}

const CHEAT_SCRIPTS = {
    ixl:        { match: /ixl\.com/,                     file: path.join(process.cwd(), "chromium-ext", "content.js") },
    blooket:    { match: /blooket\.com/,                 file: path.join(process.cwd(), "chromium-ext", "blooket.js") },
    wayground:  { match: /wayground\.com|quizizz\.com/, file: path.join(process.cwd(), "chromium-ext", "wayground.js") },
    kahoot:     { match: /kahoot\.(it|com)/,             file: path.join(process.cwd(), "chromium-ext", "kahoot.js") },
    forms:      { match: /docs\.google\.com\/forms|forms\.gle/, file: path.join(process.cwd(), "chromium-ext", "forms.js") }
};

async function setupLazyInjection(debugPort) {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const contexts = browser.contexts();
    if (!contexts.length) return;
    const context = contexts[0];

    const injectedPages = new WeakSet();

    async function injectForPage(page) {
        if (injectedPages.has(page) || page.isClosed()) return;
        const url = page.url();
        if (!url || url.startsWith("chrome://") || url.startsWith("about:")) return;

        for (const [appId, config] of Object.entries(CHEAT_SCRIPTS)) {
            if (!config.match.test(url)) continue;
            try {
                const scriptContent = fs.readFileSync(config.file, "utf8");
                await page.evaluate((code) => {
                    try { new Function(code)(); } catch (e) { console.error("[cheat-error]", e); }
                }, scriptContent);
                console.log(`[inject] ✅ ${appId} on ${url.slice(0, 50)}`);
            } catch (err) {
                console.warn(`[inject] ${appId} failed: ${err.message}`);
            }
        }
        injectedPages.add(page);
    }

    context.on("page", (page) => {
        page.on("framenavigated", async (frame) => {
            if (frame === page.mainFrame()) {
                injectedPages.delete(page);
                await sleep(1000);
                await injectForPage(page).catch(() => {});
            }
        });
    });

    for (const page of context.pages()) {
        await injectForPage(page).catch(() => {});
    }

    await browser.close();
}

export async function startSession(username, { url = "https://www.ixl.com/", preferredBrowser = null, token = "" } = {}) {
    const appId = appIdForUrl(url);
    const key = `${username}:${appId}`;

    if (userAppToSession.has(key)) {
        const existing = sessions.get(userAppToSession.get(key));
        if (existing && await browserReady(existing.ports.debugPort)) return existing;
        if (existing) await killSession(existing.sessionId);
    }

    const currentSessions = Array.from(sessions.values());
    let targetBrowser = null;
    if (preferredBrowser && BROWSERS[preferredBrowser]?.enabled) {
        const counts = usageByBrowser(currentSessions);
        if (counts[preferredBrowser] < BROWSERS[preferredBrowser].maxSessions) targetBrowser = preferredBrowser;
    }
    if (!targetBrowser) targetBrowser = pickNextBrowser(currentSessions);

    if (!targetBrowser) return await joinQueue(username, url, preferredBrowser, token, appId);
    return await spawnSession(username, url, targetBrowser, token, appId);
}

function joinQueue(username, url, preferredBrowser, token, appId) {
    return new Promise((resolve, reject) => {
        const key = `${username}:${appId}`;
        const existing = queue.find(q => `${q.username}:${q.appId}` === key);
        if (existing) { existing.resolve = resolve; existing.reject = reject; return; }
        queue.push({ username, url, preferredBrowser, token, appId, resolve, reject, enqueuedAt: Date.now() });
    });
}

async function spawnSession(username, url, preferredBrowser = null, token = "", appId = "unblock") {
    const order = browserFallbackOrder(preferredBrowser);
    let lastErr = null;

    for (const browserId of order) {
        const b = BROWSERS[browserId];
        if (!b || !b.enabled) continue;
        const currentSessions = Array.from(sessions.values());
        const counts = usageByBrowser(currentSessions);
        if (counts[browserId] >= b.maxSessions) continue;
        try {
            return await spawnWithBrowser(username, url, browserId, token, appId);
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr || new Error("all browsers failed");
}

async function spawnWithBrowser(username, url, browserId, token = "", appId = "unblock") {
    const config = BROWSERS[browserId];
    const slot = allocSlot();
    const ports = sessionPorts(slot);
    const sessionId = `s_${browserId[0]}_${slot}_${Date.now()}`;
    
    const profileDir = path.join(PROFILE_ROOT, browserId, username, appId);
    fs.mkdirSync(profileDir, { recursive: true });
    seedWarmPrefs(browserId, profileDir);

    let spawnUrl = url;
    if (token) {
        const sep = url.includes("?") ? "&" : "?";
        spawnUrl = `${url}${sep}ixl_solver_token=${encodeURIComponent(token)}`;
    }

    const xvfb = spawn("Xvfb", [`:${ports.display}`, "-screen", "0", "1280x720x24", "-ac", "+extension", "GLX", "+render", "-noreset", "-nolisten", "tcp", "-nolisten", "unix", "+iglx", "-dpi", "96"], { stdio: "ignore" });
    const x11vnc = spawn("x11vnc", ["-display", `:${ports.display}`, "-nopw", "-forever", "-shared", "-rfbport", String(ports.vncPort), "-xkb", "-noxrecord", "-noxfixes", "-noxdamage", "-wait", "5", "-defer", "5", "-threads", "-ping", "5", "-quiet", "-norc", "-repeat", "-nowf"], { stdio: "ignore" });
    const websockify = spawn("websockify", ["--web", "/usr/share/novnc", String(ports.wsPort), `localhost:${ports.vncPort}`], { stdio: "ignore" });

    const xlock = `/tmp/.X${ports.display}-lock`;
    let xvfbReady = false;
    for (let i = 0; i < 80; i++) {
        if (fs.existsSync(xlock)) { xvfbReady = true; break; }
        await sleep(100);
    }
    if (!xvfbReady) throw new Error("Xvfb failed");

    const [vncOK, wsOK] = await Promise.all([
        waitForPort(ports.vncPort, STARTUP_TIMEOUT_MS),
        waitForPort(ports.wsPort, 8000)
    ]);
    if (!vncOK || !wsOK) throw new Error("VNC failed");

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

    if (!debugReady) throw new Error(`${browserId} failed to start`);

    try { await setupLazyInjection(ports.debugPort); } catch (err) {}

    const session = {
        sessionId, username, browser: browserId, slot, ports, profileDir,
        createdAt: Date.now(), lastActivity: Date.now(),
        procs: { xvfb, x11vnc, websockify, browser },
        debugUrl: `http://127.0.0.1:${ports.debugPort}`, token, appId, dead: false
    };

    browser.on("exit", async (code) => {
        if (session.dead) return;
        session.dead = true;
        await killSession(sessionId, true);
    });

    sessions.set(sessionId, session);
    userAppToSession.set(`${username}:${appId}`, sessionId);
    return session;
}

function spawnChromiumFamily(bin, profileDir, ports, url, label) {
    const args = [
        "--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled",
        "--disable-gpu", "--disable-software-rasterizer", "--disable-background-networking",
        "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding", "--disable-hang-monitor", "--disable-prompt-on-repost",
        "--disable-features=IsolateOrigins,site-per-process,Translate,BackForwardCache,ChromeWhatsNewUI,ChromeVariations,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion,PasswordManagerOnboarding,AutofillServerCommunication,OptimizationGuideModelDownloading",
        "--disable-sync", "--disable-default-apps", "--disable-component-update",
        "--disable-client-side-phishing-detection", "--disable-infobars", "--no-first-run",
        "--no-default-browser-check", "--no-pings", "--password-store=basic", "--use-mock-keychain",
        "--disable-session-crashed-bubble", "--hide-crash-restore-bubble", "--disable-breakpad",
        "--disable-crash-reporter", "--disable-domain-reliability", "--disable-ipc-flooding-protection",
        "--enable-features=NetworkServiceInProcess2", "--enable-features=UseOzonePlatform",
        "--ozone-platform=x11", "--enable-quic", "--renderer-process-limit=1",
        "--disable-site-isolation-trials", "--disk-cache-size=536870912", "--media-cache-size=134217728",
        "--aggressive-cache-discard", "--restore-last-session=false",
        `--remote-debugging-port=${ports.debugPort}`, "--remote-debugging-address=127.0.0.1",
        "--remote-allow-origins=*", `--app=${url}`, "--window-position=0,0", "--window-size=1280,720",
        `--user-data-dir=${profileDir}`
    ];
    if (label === "brave") args.push("--disable-features=BraveRewards,BraveAds,BraveWallet,BraveShields,BraveNews");
    if (label === "edge") args.push("--edge-skip-compat-layer-relaunch", "--disable-features=msEdgeSidebarV2,msEdgeShoppingAssistant");

    return spawn(bin, args, { env: { ...process.env, DISPLAY: `:${ports.display}` }, stdio: "ignore" });
}

function spawnFirefox(bin, profileDir, ports, url) {
    const userJs = path.join(profileDir, "user.js");
    fs.writeFileSync(userJs, `
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.page", 0);
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.sessionstore.max_tabs_undo", 0);
user_pref("toolkit.telemetry.enabled", false);
user_pref("network.http.max-connections", 900);
user_pref("dom.ipc.processCount", 1);
user_pref("fission.autostart", false);
user_pref("gfx.webrender.all", true);
user_pref("layers.acceleration.force-enabled", true);
`);
    return spawn(bin, ["--no-remote", "--new-instance", "-profile", profileDir, "-width", "1280", "-height", "720", "--remote-debugging-port", String(ports.debugPort), "-setDefaultBrowser", "never", url], {
        env: { ...process.env, DISPLAY: `:${ports.display}` }, stdio: "ignore"
    });
}

export function touchSession(username, appId) {
    const s = getSession(username, appId);
    if (s) s.lastActivity = Date.now();
}

export async function killSession(sessionId, quiet = false) {
    const s = sessions.get(sessionId);
    if (!s) return;
    for (const name of ["browser", "websockify", "x11vnc", "xvfb"]) {
        const p = s.procs[name];
        if (p && !p.killed) {
            try { p.kill("SIGTERM"); } catch (_) { }
            setTimeout(() => { try { p.kill("SIGKILL"); } catch (_) { } }, 1200);
        }
    }
    sessions.delete(sessionId);
    for (const [k, v] of userAppToSession) {
        if (v === sessionId) userAppToSession.delete(k);
    }

    if (queue.length > 0) {
        const next = queue.shift();
        spawnSession(next.username, next.url, next.preferredBrowser, next.token, next.appId)
            .then(session => next.resolve(session))
            .catch(err => next.reject(err));
    }
}

export function getSession(username, appId) {
    const id = userAppToSession.get(`${username}:${appId}`);
    return id ? sessions.get(id) : null;
}

export function getQueueInfo(username, appId) {
    const key = `${username}:${appId}`;
    const idx = queue.findIndex(q => `${q.username}:${q.appId}` === key);
    const counts = usageByBrowser(Array.from(sessions.values()));
    return {
        inQueue: idx !== -1, position: idx === -1 ? null : idx + 1,
        totalActive: sessions.size, maxActive: totalCapacity(), queued: queue.length,
        usageByBrowser: counts
    };
}

export function stats() {
    return {
        active: sessions.size, max: totalCapacity(), queued: queue.length,
        sessions: Array.from(sessions.values()).map(s => ({
            sessionId: s.sessionId, username: s.username, browser: s.browser, appId: s.appId, slot: s.slot
        }))
    };
}