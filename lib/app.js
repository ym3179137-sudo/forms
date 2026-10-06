// ─── helpers ───────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }
function on(id, evt, fn) { const e = el(id); if (e) e.addEventListener(evt, fn); }

// ─── state ─────────────────────────────────────────────────────
let socket = null;
let currentSessionId = null;
let token = localStorage.getItem("ixl_token") || "";
let username = localStorage.getItem("ixl_user") || "";

let canvas = null;
let ctx = null;
let currentFrameSize = { width: 1920, height: 1080 };
let lastClickTime = 0;
let clickCount = 0;
const imageCache = new Image();

// ─── view status ───────────────────────────────────────────────
function setViewStatus(s) {
    const v = el("viewer-status");
    if (v) v.textContent = s;
}

// ─── canvas attach ─────────────────────────────────────────────
function attachCanvas() {
    canvas = el("viewer");
    if (!canvas) { console.warn("[viewer] no canvas"); return; }
    ctx = canvas.getContext("2d");
    canvas.tabIndex = 0;

    // mouse
    canvas.addEventListener("mousedown", (e) => { canvas.focus(); sendMouse(e, "down"); e.preventDefault(); });
    canvas.addEventListener("mouseup", (e) => { sendMouse(e, "up"); e.preventDefault(); });
    canvas.addEventListener("mousemove", (e) => { sendMouse(e, "move"); });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    // wheel
    canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        const { x, y } = scaleCoords(e);
        sendMsg({ type: "input", payload: { type: "wheel", x, y, deltaX: e.deltaX, deltaY: e.deltaY } });
    }, { passive: false });

    // keys — capture everything so ctrl+c / ctrl+v / ctrl+m work as if in the canvas
    canvas.addEventListener("keydown", (e) => {
        // fullscreen toggle
        if (e.ctrlKey && (e.key === "m" || e.key === "M")) {
            e.preventDefault();
            toggleFullscreen();
            return;
        }
        if (e.key === "F11") {
            e.preventDefault();
            toggleFullscreen();
            return;
        }
        // ctrl+a/c/v/x/z/y — forward all; browser clipboard works via paste event below
        e.preventDefault();
        sendKey("down", e);
    });
    canvas.addEventListener("keyup", (e) => { e.preventDefault(); sendKey("up", e); });

    // paste — the browser handles ctrl+v natively and fires this
    canvas.addEventListener("paste", (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData("text");
        if (text) sendMsg({ type: "input", payload: { type: "paste", text } });
    });

    canvas.addEventListener("copy", (e) => {
        // best-effort: send ctrl+c to the page so it copies server-side, then the user
        // presses ctrl+v back to us which we forward to the page as paste
        // (real clipboard sync across boundaries is complex; this gets text selection working)
    });
}

// ─── frame render ──────────────────────────────────────────────
function renderFrame(base64) {
    if (!canvas || !ctx) return;
    imageCache.onload = () => {
        if (canvas.width !== imageCache.width || canvas.height !== imageCache.height) {
            canvas.width = imageCache.width;
            canvas.height = imageCache.height;
            currentFrameSize = { width: imageCache.width, height: imageCache.height };
        }
        ctx.drawImage(imageCache, 0, 0);
    };
    imageCache.src = "data:image/jpeg;base64," + base64;
}

// ─── coord scaling ─────────────────────────────────────────────
function scaleCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (currentFrameSize.width / rect.width);
    const y = (e.clientY - rect.top) * (currentFrameSize.height / rect.height);
    return { x, y };
}

// ─── senders ───────────────────────────────────────────────────
function sendMsg(obj) {
    if (!socket || socket.readyState !== 1) return;
    socket.send(JSON.stringify(obj));
}

function sendMouse(e, action) {
    const { x, y } = scaleCoords(e);
    let cc = 1;
    if (action === "down") {
        const now = Date.now();
        clickCount = (now - lastClickTime < 400) ? clickCount + 1 : 1;
        lastClickTime = now;
        cc = clickCount;
    } else cc = clickCount;
    const buttonName = e.button === 0 ? "left" : e.button === 1 ? "middle" : e.button === 2 ? "right" : "none";
    sendMsg({
        type: "input", payload: {
            type: "mouse", action, x, y,
            button: action === "move" ? "none" : buttonName,
            buttons: e.buttons, clickCount: cc
        }
    });
}

function sendKey(action, e) {
    const modifiers =
        (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
    const text = (action === "down" && e.key && e.key.length === 1) ? e.key : "";
    sendMsg({
        type: "input", payload: {
            type: "key", action, key: e.key, code: e.code, text,
            keyCode: e.keyCode, modifiers
        }
    });
}

// ─── fullscreen ────────────────────────────────────────────────
function toggleFullscreen() {
    const wrap = el("viewer-wrap");
    const target = wrap || document.documentElement;
    if (!document.fullscreenElement) target.requestFullscreen().catch(() => { });
    else document.exitFullscreen().catch(() => { });
    setTimeout(() => canvas && canvas.focus(), 200);
}

// ─── login ─────────────────────────────────────────────────────
async function tryLogin(u, p) {
    const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "login failed");
    return data;
}

async function launch() {
    const errorBox = el("error-box");
    const bootMsg = el("boot-msg");
    const logEl = el("log");

    if (errorBox) errorBox.hidden = true;
    if (bootMsg) bootMsg.textContent = "launching browser session...";
    if (el("screen-login")) el("screen-login").hidden = true;
    if (el("screen-session")) el("screen-session").hidden = false;
    setViewStatus("connecting…");

    try {
        const res = await fetch("/api/start", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-IXL-Token": token },
            body: JSON.stringify({})
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: "failed" }));
            if (res.status === 401) {
                localStorage.removeItem("ixl_token");
                token = "";
                if (el("screen-session")) el("screen-session").hidden = true;
                if (el("screen-login")) el("screen-login").hidden = false;
                if (el("login-box")) el("login-box").hidden = false;
                if (bootMsg) bootMsg.textContent = "session expired. sign in again.";
                return;
            }
            throw new Error(err.error || res.statusText);
        }

        const data = await res.json();
        currentSessionId = data.sessionId;
        if (el("session-id")) el("session-id").textContent = currentSessionId;
        openSocket(currentSessionId);
        attachCanvas();
        setTimeout(() => canvas && canvas.focus(), 500);
    } catch (err) {
        if (el("screen-session")) el("screen-session").hidden = true;
        if (el("screen-login")) el("screen-login").hidden = false;
        if (errorBox) { errorBox.hidden = false; errorBox.textContent = "error: " + err.message; }
    }
}

// ─── websocket ─────────────────────────────────────────────────
function openSocket(sessionId) {
    if (socket) socket.close();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(
        proto + "://" + location.host + "/ws?sessionId=" + sessionId + "&token=" + encodeURIComponent(token)
    );
    socket.addEventListener("open", () => { if (el("status")) el("status").textContent = "connected"; });
    socket.addEventListener("message", (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
        handleEvent(msg);
    });
    socket.addEventListener("close", (ev) => {
        if (el("status")) el("status").textContent = "disconnected";
        setViewStatus("disconnected " + (ev.code || ""));
    });
}

function handleEvent(msg) {
    const statusEl = el("status");
    const logEl = el("log");
    switch (msg.type) {
        case "queued":
            if (statusEl) statusEl.textContent = `queued — position ${msg.position}`;
            break;
        case "hello":
            break;
        case "status":
            if (statusEl) statusEl.textContent = msg.message;
            break;
        case "log":
            break;
        case "frame":
            renderFrame(msg.data);
            setViewStatus("live");
            break;
        case "view-ready":
            setViewStatus("live");
            break;
        case "url": {
            const urlInput = el("nav-url");
            if (urlInput && document.activeElement !== urlInput) urlInput.value = msg.url || "";
            break;
        }
        case "solved":
            if (statusEl) statusEl.textContent = "solved " + msg.count;
            break;
        case "error":
            break;
        case "fatal":
            if (statusEl) statusEl.textContent = "session ended";
            break;
        case "ended":
            if (statusEl) statusEl.textContent = "ended";
            break;
    }
}

// ─── toolbar buttons ───────────────────────────────────────────
on("login-submit", "click", async () => {
    const u = el("user-input") ? el("user-input").value.trim() : "";
    const p = el("pass-input") ? el("pass-input").value : "";
    if (!u || !p) return;
    if (el("error-box")) el("error-box").hidden = true;
    if (el("boot-msg")) el("boot-msg").textContent = "signing in...";
    try {
        const data = await tryLogin(u, p);
        token = data.token;
        username = data.username;
        localStorage.setItem("ixl_token", token);
        localStorage.setItem("ixl_user", username);
        if (el("login-box")) el("login-box").hidden = true;
        launch();
    } catch (err) {
        if (el("error-box")) { el("error-box").hidden = false; el("error-box").textContent = err.message; }
        if (el("boot-msg")) el("boot-msg").textContent = "sign in to continue.";
    }
});

on("pass-input", "keydown", (e) => {
    if (e.key === "Enter") el("login-submit")?.click();
});

on("stop-btn", "click", async () => {
    if (!currentSessionId) return;
    await fetch("/api/stop/" + currentSessionId, {
        method: "POST",
        headers: { "X-IXL-Token": token }
    });
    if (el("status")) el("status").textContent = "stopping...";
});

on("back-btn", "click", () => {
    if (socket) { socket.close(); socket = null; }
    currentSessionId = null;
    if (el("screen-session")) el("screen-session").hidden = true;
    if (el("screen-login")) el("screen-login").hidden = false;
    if (el("login-box")) el("login-box").hidden = false;
    if (el("boot-msg")) el("boot-msg").textContent = "signed in as " + username + ".";
});

on("nav-back", "click", () => sendMsg({ type: "nav", action: "back" }));
on("nav-forward", "click", () => sendMsg({ type: "nav", action: "forward" }));
on("nav-reload", "click", () => sendMsg({ type: "nav", action: "reload" }));
on("nav-go", "click", () => {
    const u = el("nav-url")?.value || "";
    if (u) sendMsg({ type: "nav", action: "navigate", url: u });
    canvas && canvas.focus();
});
on("nav-url", "keydown", (e) => {
    if (e.key === "Enter") {
        const u = e.target.value || "";
        if (u) sendMsg({ type: "nav", action: "navigate", url: u });
        canvas && canvas.focus();
    }
});
on("fs-btn", "click", toggleFullscreen);

// ─── boot ──────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
    if (token) {
        if (el("login-box")) el("login-box").hidden = true;
        launch();
    }
});