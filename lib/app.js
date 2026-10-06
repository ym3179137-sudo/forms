const loginScreen = document.getElementById("screen-login");
const sessionScreen = document.getElementById("screen-session");
const bootMsg = document.getElementById("boot-msg");
const errorBox = document.getElementById("error-box");
const retryBtn = document.getElementById("retry-btn");
const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const sessionIdEl = document.getElementById("session-id");
const stopBtn = document.getElementById("stop-btn");
const backBtn = document.getElementById("back-btn");
const steelLinkWrap = document.getElementById("steel-link-wrap");
const steelLink = document.getElementById("steel-link");

let socket = null;
let currentSessionId = null;

async function launch() {
    errorBox.hidden = true;
    retryBtn.hidden = true;
    bootMsg.textContent = "launching steel session with .env keys...";
    logEl.innerHTML = "";
    statusEl.textContent = "launching...";
    sessionScreen.hidden = false;
    loginScreen.hidden = true;
    steelLinkWrap.hidden = true;

    try {
        const res = await fetch("/api/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({})
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({ error: "failed" }));
            throw new Error(err.error || res.statusText);
        }
        const data = await res.json();
        currentSessionId = data.sessionId;
        sessionIdEl.textContent = currentSessionId;
        openSocket(currentSessionId);
    } catch (err) {
        sessionScreen.hidden = true;
        loginScreen.hidden = false;
        bootMsg.textContent = "launch failed.";
        errorBox.hidden = false;
        errorBox.textContent = "error: " + err.message;
        retryBtn.hidden = false;
    }
}

retryBtn.addEventListener("click", launch);

stopBtn.addEventListener("click", async () => {
    if (!currentSessionId) return;
    await fetch("/api/stop/" + currentSessionId, { method: "POST" });
    statusEl.textContent = "stopping...";
});

backBtn.addEventListener("click", () => {
    if (socket) { socket.close(); socket = null; }
    currentSessionId = null;
    sessionScreen.hidden = true;
    loginScreen.hidden = false;
    bootMsg.textContent = "idle. hit retry to launch again.";
    retryBtn.hidden = false;
});

function openSocket(sessionId) {
    if (socket) socket.close();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(proto + "://" + location.host + "/ws?sessionId=" + sessionId);
    socket.addEventListener("open", () => { statusEl.textContent = "connected"; });
    socket.addEventListener("message", (ev) => {
        let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
        handleEvent(msg);
    });
    socket.addEventListener("close", () => { statusEl.textContent = "disconnected"; });
}

function handleEvent(msg) {
    switch (msg.type) {
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

window.addEventListener("DOMContentLoaded", launch);