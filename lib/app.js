import { initViewer, destroyViewer } from "/viewer.js";

function el(id) { return document.getElementById(id); }
function on(id, evt, fn) {
    const e = el(id);
    if (e) e.addEventListener(evt, fn);
    return e;
}

const loginScreen = el("screen-login");
const sessionScreen = el("screen-session");
const bootMsg = el("boot-msg");
const errorBox = el("error-box");
const statusEl = el("status");
const logEl = el("log");
const sessionIdEl = el("session-id");
const userInput = el("user-input");
const passInput = el("pass-input");
const loginBox = el("login-box");

let socket = null;
let currentSessionId = null;
let token = localStorage.getItem("ixl_token") || "";
let username = localStorage.getItem("ixl_user") || "";

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
    if (errorBox) errorBox.hidden = true;
    if (bootMsg) bootMsg.textContent = "launching browser session...";
    if (logEl) logEl.innerHTML = "";
    if (statusEl) statusEl.textContent = "queued...";
    if (sessionScreen) sessionScreen.hidden = false;
    if (loginScreen) loginScreen.hidden = true;

    try {
        const res = await fetch("/api/start", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-IXL-Token": token
            },
            body: JSON.stringify({})
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: "failed" }));
            if (res.status === 401) {
                localStorage.removeItem("ixl_token");
                token = "";
                if (sessionScreen) sessionScreen.hidden = true;
                if (loginScreen) loginScreen.hidden = false;
                if (loginBox) loginBox.hidden = false;
                if (bootMsg) bootMsg.textContent = "session expired. sign in again.";
                return;
            }
            throw new Error(err.error || res.statusText);
        }

        const data = await res.json();
        currentSessionId = data.sessionId;
        if (sessionIdEl) sessionIdEl.textContent = currentSessionId;
        openSocket(currentSessionId);

        // live view: attach now, browser will "no page yet" if not ready.
        // it reconnects automatically below.
        tryAttachViewer();
    } catch (err) {
        if (sessionScreen) sessionScreen.hidden = true;
        if (loginScreen) loginScreen.hidden = false;
        if (errorBox) {
            errorBox.hidden = false;
            errorBox.textContent = "error: " + err.message;
        }
    }
}

// viewer needs the server page to exist. it might take 2-5s.
// retry until we successfully connect, or give up after 30 tries.
let viewerTries = 0;
function tryAttachViewer() {
    if (!currentSessionId) return;
    viewerTries++;
    try {
        initViewer(currentSessionId, token);
        const v = el("viewer-status");
        // mark as tentatively connected; viewer.js will overwrite on real events
        if (v) v.textContent = "connecting…";
    } catch (_) { }
    // re-attempt if browser wasn't ready yet
    if (viewerTries < 30) {
        setTimeout(() => {
            const ws = window.__viewWsClosed;
            if (ws) tryAttachViewer();
            else { /* connected, stop */ }
        }, 1500);
    }
}

on("login-submit", "click", async () => {
    const u = userInput ? userInput.value.trim() : "";
    const p = passInput ? passInput.value : "";
    if (!u || !p) return;

    if (errorBox) errorBox.hidden = true;
    if (bootMsg) bootMsg.textContent = "signing in...";

    try {
        const data = await tryLogin(u, p);
        token = data.token;
        username = data.username;
        localStorage.setItem("ixl_token", token);
        localStorage.setItem("ixl_user", username);
        if (loginBox) loginBox.hidden = true;
        launch();
    } catch (err) {
        if (errorBox) {
            errorBox.hidden = false;
            errorBox.textContent = err.message;
        }
        if (bootMsg) bootMsg.textContent = "sign in to continue.";
    }
});

on("pass-input", "keydown", (e) => {
    if (e.key === "Enter") {
        const b = el("login-submit");
        if (b) b.click();
    }
});

on("stop-btn", "click", async () => {
    if (!currentSessionId) return;
    await fetch("/api/stop/" + currentSessionId, {
        method: "POST",
        headers: { "X-IXL-Token": token }
    });
    if (statusEl) statusEl.textContent = "stopping...";
});

on("back-btn", "click", () => {
    if (socket) { socket.close(); socket = null; }
    destroyViewer();
    currentSessionId = null;
    if (sessionScreen) sessionScreen.hidden = true;
    if (loginScreen) loginScreen.hidden = false;
    if (loginBox) loginBox.hidden = false;
    if (bootMsg) bootMsg.textContent = "signed in as " + username + ".";
});

function openSocket(sessionId) {
    if (socket) socket.close();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(
        proto + "://" + location.host + "/ws?sessionId=" + sessionId + "&token=" + encodeURIComponent(token)
    );
    socket.addEventListener("open", () => { if (statusEl) statusEl.textContent = "connected"; });
    socket.addEventListener("message", (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
        handleEvent(msg);
    });
    socket.addEventListener("close", () => { if (statusEl) statusEl.textContent = "disconnected"; });
}

function handleEvent(msg) {
    switch (msg.type) {
        case "queued":
            if (statusEl) statusEl.textContent = `queued — position ${msg.position}`;
            appendLog(`waiting for a slot (position ${msg.position})`, "status");
            break;
        case "hello":
            appendLog("connected to " + msg.sessionId, "status");
            break;
        case "status":
            if (statusEl) statusEl.textContent = msg.message;
            appendLog(msg.message, "status");
            break;
        case "log":
            appendLog(msg.message);
            break;
        case "solved":
            appendLog("+ " + msg.message, "solved");
            if (statusEl) statusEl.textContent = "solved " + msg.count;
            break;
        case "error":
            appendLog("x " + msg.message, "err");
            break;
        case "fatal":
            appendLog("fatal: " + msg.message, "err");
            if (statusEl) statusEl.textContent = "session ended";
            break;
        case "ended":
            appendLog("session ended", "status");
            if (statusEl) statusEl.textContent = "ended";
            break;
    }
}

function appendLog(text, cls) {
    if (!logEl) return;
    const div = document.createElement("div");
    if (cls) div.className = cls;
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
}

window.addEventListener("DOMContentLoaded", () => {
    if (token) {
        if (loginBox) loginBox.hidden = true;
        launch();
    } else {
        if (loginBox) loginBox.hidden = false;
    }
});