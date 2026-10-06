const loginScreen = document.getElementById("screen-login");
const sessionScreen = document.getElementById("screen-session");
const bootMsg = document.getElementById("boot-msg");
const errorBox = document.getElementById("error-box");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const sessionIdEl = document.getElementById("session-id");
const stopBtn = document.getElementById("stop-btn");
const backBtn = document.getElementById("back-btn");
const steelLinkWrap = document.getElementById("steel-link-wrap");
const steelLink = document.getElementById("steel-link");
const userInput = document.getElementById("user-input");
const passInput = document.getElementById("pass-input");
const loginSubmit = document.getElementById("login-submit");
const loginBox = document.getElementById("login-box");

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
    errorBox.hidden = true;
    bootMsg.textContent = "launching browser session...";
    logEl.innerHTML = "";
    statusEl.textContent = "queued...";
    sessionScreen.hidden = false;
    loginScreen.hidden = true;
    steelLinkWrap.hidden = true;

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
                sessionScreen.hidden = true;
                loginScreen.hidden = false;
                loginBox.hidden = false;
                bootMsg.textContent = "session expired. sign in again.";
                return;
            }
            throw new Error(err.error || res.statusText);
        }

        const data = await res.json();
        currentSessionId = data.sessionId;
        sessionIdEl.textContent = currentSessionId;
        openSocket(currentSessionId);
    } catch (err) {
        sessionScreen.hidden = true;
        loginScreen.hidden = false;
        errorBox.hidden = false;
        errorBox.textContent = "error: " + err.message;
    }
}

loginSubmit.addEventListener("click", async () => {
    const u = userInput.value.trim();
    const p = passInput.value;
    if (!u || !p) return;

    errorBox.hidden = true;
    bootMsg.textContent = "signing in...";

    try {
        const data = await tryLogin(u, p);
        token = data.token;
        username = data.username;
        localStorage.setItem("ixl_token", token);
        localStorage.setItem("ixl_user", username);
        loginBox.hidden = true;
        launch();
    } catch (err) {
        errorBox.hidden = false;
        errorBox.textContent = err.message;
        bootMsg.textContent = "sign in to continue.";
    }
});

passInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loginSubmit.click();
});

stopBtn.addEventListener("click", async () => {
    if (!currentSessionId) return;
    await fetch("/api/stop/" + currentSessionId, {
        method: "POST",
        headers: { "X-IXL-Token": token }
    });
    statusEl.textContent = "stopping...";
});

backBtn.addEventListener("click", () => {
    if (socket) { socket.close(); socket = null; }
    currentSessionId = null;
    sessionScreen.hidden = true;
    loginScreen.hidden = false;
    loginBox.hidden = false;
    bootMsg.textContent = "signed in as " + username + ". press sign in again.";
});

function openSocket(sessionId) {
    if (socket) socket.close();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(
        proto + "://" + location.host + "/ws?sessionId=" + sessionId + "&token=" + encodeURIComponent(token)
    );
    socket.addEventListener("open", () => { statusEl.textContent = "connected"; });
    socket.addEventListener("message", (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
        handleEvent(msg);
    });
    socket.addEventListener("close", () => { statusEl.textContent = "disconnected"; });
}

function handleEvent(msg) {
    switch (msg.type) {
        case "queued":
            statusEl.textContent = `queued — position ${msg.position}`;
            appendLog(`waiting for a slot (position ${msg.position})`, "status");
            break;
        case "hello":
            appendLog("connected to " + msg.sessionId, "status");
            break;
        case "status":
            statusEl.textContent = msg.message;
            appendLog(msg.message, "status");
            if (msg.liveViewUrl) {
                steelLinkWrap.hidden = false;
                steelLink.href = msg.liveViewUrl;
                steelLink.textContent = msg.liveViewUrl;
            }
            break;
        case "log":
            appendLog(msg.message);
            break;
        case "solved":
            appendLog("+ " + msg.message, "solved");
            statusEl.textContent = "solved " + msg.count;
            break;
        case "error":
            appendLog("x " + msg.message, "err");
            break;
        case "fatal":
            appendLog("fatal: " + msg.message, "err");
            statusEl.textContent = "session ended";
            break;
        case "ended":
            appendLog("session ended", "status");
            statusEl.textContent = "ended";
            break;
    }
}

function appendLog(text, cls) {
    const div = document.createElement("div");
    if (cls) div.className = cls;
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
}

window.addEventListener("DOMContentLoaded", async () => {
    if (token) {
        // token exists — straight to launch
        loginBox.hidden = true;
        launch();
    } else {
        loginBox.hidden = false;
    }
});