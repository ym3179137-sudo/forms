// ─── state ─────────────────────────────────────────────────────
let socket = null;
let currentSessionId = null;
let token = localStorage.getItem("ixl_token") || "";
let username = localStorage.getItem("ixl_user") || "";

let canvas = null;
let ctx = null;
let currentFrameSize = { width: 1366, height: 768 };
let lastClickTime = 0;
let clickCount = 0;
const imageCache = new Image();

// ─── helpers ───────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }
function on(id, evt, fn) {
  const e = el(id);
  if (e) e.addEventListener(evt, fn);
  return e;
}

function setViewStatus(s) {
  const v = el("viewer-status");
  if (v) v.textContent = s;
}

// ─── canvas ────────────────────────────────────────────────────
function attachCanvas() {
  canvas = el("viewer");
  if (!canvas) { console.warn("[viewer] no canvas"); return; }
  ctx = canvas.getContext("2d");
  canvas.tabIndex = 0;

  canvas.addEventListener("mousedown", (e) => { canvas.focus(); sendMouse(e, "down"); });
  canvas.addEventListener("mouseup", (e) => sendMouse(e, "up"));
  canvas.addEventListener("mousemove", (e) => sendMouse(e, "move"));
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const { x, y } = scaleCoords(e);
    sendMsg({ type: "input", payload: { type: "wheel", x, y, deltaX: e.deltaX, deltaY: e.deltaY } });
  }, { passive: false });

  canvas.addEventListener("keydown", (e) => { e.preventDefault(); sendKey("down", e); });
  canvas.addEventListener("keyup", (e) => { e.preventDefault(); sendKey("up", e); });

  canvas.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text");
    if (text) sendMsg({ type: "input", payload: { type: "paste", text } });
  });
}

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

function scaleCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (currentFrameSize.width / rect.width);
  const y = (e.clientY - rect.top) * (currentFrameSize.height / rect.height);
  return { x, y };
}

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
  } else {
    cc = clickCount;
  }
  const buttonName = e.button === 0 ? "left" : e.button === 1 ? "middle" : e.button === 2 ? "right" : "none";
  sendMsg({
    type: "input",
    payload: {
      type: "mouse",
      action,
      x, y,
      button: action === "move" ? "none" : buttonName,
      buttons: e.buttons,
      clickCount: cc
    }
  });
}

function sendKey(action, e) {
  const modifiers =
    (e.altKey ? 1 : 0) |
    (e.ctrlKey ? 2 : 0) |
    (e.metaKey ? 4 : 0) |
    (e.shiftKey ? 8 : 0);
  const text = (action === "down" && e.key && e.key.length === 1) ? e.key : "";
  sendMsg({
    type: "input",
    payload: {
      type: "key",
      action,
      key: e.key,
      code: e.code,
      text,
      keyCode: e.keyCode,
      modifiers
    }
  });
}

// ─── auth & launch ─────────────────────────────────────────────
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
  const loginScreen = el("screen-login");
  const sessionScreen = el("screen-session");
  const bootMsg = el("boot-msg");
  const errorBox = el("error-box");
  const logEl = el("log");
  const statusEl = el("status");

  if (errorBox) errorBox.hidden = true;
  if (bootMsg) bootMsg.textContent = "launching browser session...";
  if (logEl) logEl.innerHTML = "";
  if (statusEl) statusEl.textContent = "queued...";
  if (sessionScreen) sessionScreen.hidden = false;
  if (loginScreen) loginScreen.hidden = true;
  setViewStatus("connecting…");

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
  } catch (err) {
    if (sessionScreen) sessionScreen.hidden = true;
    if (loginScreen) loginScreen.hidden = false;
    if (errorBox) {
      errorBox.hidden = false;
      errorBox.textContent = "error: " + err.message;
    }
  }
}

// ─── websocket ─────────────────────────────────────────────────
function openSocket(sessionId) {
  if (socket) socket.close();
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(
    proto + "://" + location.host + "/ws?sessionId=" + sessionId + "&token=" + encodeURIComponent(token)
  );
  socket.addEventListener("open", () => {
    if (el("status")) el("status").textContent = "connected";
    console.log("[ws] connected");
  });
  socket.addEventListener("message", (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
    handleEvent(msg);
  });
  socket.addEventListener("close", (ev) => {
    if (el("status")) el("status").textContent = "disconnected";
    setViewStatus("disconnected " + (ev.code || ""));
    console.warn("[ws] closed code=", ev.code);
  });
}

function handleEvent(msg) {
  const statusEl = el("status");
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
    case "frame":
      renderFrame(msg.data);
      setViewStatus("live");
      break;
    case "view-ready":
      setViewStatus("live");
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
  const logEl = el("log");
  if (!logEl) return;
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.textContent = text;
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
}

// ─── buttons ───────────────────────────────────────────────────
on("login-submit", "click", async () => {
  const userInput = el("user-input");
  const passInput = el("pass-input");
  const errorBox = el("error-box");
  const bootMsg = el("boot-msg");
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
    if (el("login-box")) el("login-box").hidden = true;
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

// ─── boot ──────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  if (token) {
    if (el("login-box")) el("login-box").hidden = true;
    launch();
  } else {
    if (el("login-box")) el("login-box").hidden = false;
  }
});