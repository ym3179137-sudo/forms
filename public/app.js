function el(id) { return document.getElementById(id); }
function on(id, evt, fn) { const e = el(id); if (e) e.addEventListener(evt, fn); }

let socket = null;
let currentSessionId = null;
let token = localStorage.getItem("ixl_token") || "";
let username = localStorage.getItem("ixl_user") || "";

let canvas = null;
let ctx = null;
let currentFrameSize = { width: 1280, height: 720 };
let lastClickTime = 0;
let clickCount = 0;
let reconnectAttempts = 0;
let reconnectTimer = null;
let frameCount = 0;
let lastFrameAt = 0;

function setViewStatus(s) {
  const v = el("viewer-status");
  if (v) v.textContent = s;
}

function attachCanvas() {
  if (canvas) return;
  canvas = el("viewer");
  if (!canvas) return;
  ctx = canvas.getContext("2d", { alpha: false });
  canvas.tabIndex = 0;

  canvas.addEventListener("mousedown", (e) => { canvas.focus(); sendMouse(e, "down"); e.preventDefault(); });
  canvas.addEventListener("mouseup", (e) => { sendMouse(e, "up"); e.preventDefault(); });
  canvas.addEventListener("mousemove", (e) => sendMouse(e, "move"));
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const { x, y } = scaleCoords(e);
    sendMsg({ type: "input", payload: { type: "wheel", x, y, deltaX: e.deltaX, deltaY: e.deltaY } });
  }, { passive: false });

  canvas.addEventListener("keydown", (e) => {
    if (e.ctrlKey && (e.key === "m" || e.key === "M")) {
      e.preventDefault(); e.stopPropagation();
      togglePanic();
      return;
    }
    e.preventDefault();
    sendKey("down", e);
  });
  canvas.addEventListener("keyup", (e) => { e.preventDefault(); sendKey("up", e); });

  canvas.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text");
    if (text) sendMsg({ type: "input", payload: { type: "paste", text } });
  });

  // check frame liveness every 2s — if no frame in 4s, warn
  setInterval(() => {
    if (stopped || !currentSessionId) return;
    if (lastFrameAt && Date.now() - lastFrameAt > 4000) {
      setViewStatus("stalled — waiting for frames");
    }
  }, 2000);
}

let stopped = false;

// synchronous decode + draw. no onload race.
async function renderFrame(base64) {
  if (!canvas || !ctx) return;
  try {
    const bin = atob(base64);
    const len = bin.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: "image/jpeg" });
    const bmp = await createImageBitmap(blob);
    if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      currentFrameSize = { width: bmp.width, height: bmp.height };
    }
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    frameCount++;
    lastFrameAt = Date.now();
    if (frameCount === 1) {
      console.log("[viewer] first frame rendered", currentFrameSize);
      setViewStatus("live");
    } else if (frameCount === 30) {
      setViewStatus("live · 30 frames");
    }
  } catch (err) {
    console.warn("[viewer] render failed:", err.message);
  }
}

function scaleCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (currentFrameSize.width / rect.width);
  const y = (e.clientY - rect.top) * (currentFrameSize.height / rect.height);
  return { x, y };
}

function sendMsg(obj) {
  if (!socket || socket.readyState !== 1) return;
  try { socket.send(JSON.stringify(obj)); } catch (_) { }
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

let panicActive = false;
function togglePanic() {
  panicActive = !panicActive;
  const overlay = el("panic-overlay");
  if (overlay) overlay.hidden = !panicActive;
  if (!panicActive) setTimeout(() => canvas && canvas.focus(), 100);
}

function toggleFullscreen() {
  const target = el("viewer-wrap") || document.documentElement;
  if (!document.fullscreenElement) target.requestFullscreen().catch(() => { });
  else document.exitFullscreen().catch(() => { });
  setTimeout(() => canvas && canvas.focus(), 200);
}

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
  if (el("screen-login")) el("screen-login").hidden = true;
  if (el("screen-session")) el("screen-session").hidden = false;
  setViewStatus("launching…");

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
        return;
      }
      throw new Error(err.error || res.statusText);
    }

    const data = await res.json();
    currentSessionId = data.sessionId;
    if (el("session-id")) el("session-id").textContent = currentSessionId;
    frameCount = 0;
    lastFrameAt = 0;
    attachCanvas();
    openSocket(currentSessionId);
    setTimeout(() => canvas && canvas.focus(), 500);
  } catch (err) {
    if (el("screen-session")) el("screen-session").hidden = true;
    if (el("screen-login")) el("screen-login").hidden = false;
    if (el("error-box")) {
      el("error-box").hidden = false;
      el("error-box").textContent = "error: " + err.message;
    }
  }
}

function openSocket(sessionId) {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (socket) { try { socket.close(); } catch (_) { } }

  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(
    proto + "://" + location.host + "/ws?sessionId=" + sessionId + "&token=" + encodeURIComponent(token)
  );

  socket.addEventListener("open", () => {
    reconnectAttempts = 0;
    if (el("status")) el("status").textContent = "connected";
    console.log("[ws] connected");
  });

  socket.addEventListener("message", (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (_) { return; }
    handleEvent(msg);
  });

  socket.addEventListener("close", (ev) => {
    if (el("status")) el("status").textContent = "reconnecting…";
    if (currentSessionId && reconnectAttempts < 30) {
      reconnectAttempts++;
      const delay = Math.min(1000 + reconnectAttempts * 500, 5000);
      reconnectTimer = setTimeout(() => openSocket(currentSessionId), delay);
    }
  });
}

function handleEvent(msg) {
  const statusEl = el("status");
  switch (msg.type) {
    case "queued":
      if (statusEl) statusEl.textContent = `queued — position ${msg.position}`;
      break;
    case "ping":
      sendMsg({ type: "pong", t: Date.now() });
      break;
    case "status":
      if (statusEl) statusEl.textContent = msg.message;
      break;
    case "frame":
      renderFrame(msg.data);
      break;
    case "view-ready":
      console.log("[ws] view-ready", msg.width, "x", msg.height);
      break;
    case "url": {
      const urlInput = el("nav-url");
      if (urlInput && document.activeElement !== urlInput) urlInput.value = msg.url || "";
      break;
    }
    case "solved":
      if (statusEl) statusEl.textContent = "solved " + msg.count;
      break;
    case "ended":
      if (statusEl) statusEl.textContent = "ended";
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      break;
  }
}

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
  await fetch("/api/stop/" + currentSessionId, { method: "POST", headers: { "X-IXL-Token": token } });
});

on("back-btn", "click", () => {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (socket) { socket.close(); socket = null; }
  currentSessionId = null;
  if (el("screen-session")) el("screen-session").hidden = true;
  if (el("screen-login")) el("screen-login").hidden = false;
});

on("nav-back", "click", () => sendMsg({ type: "nav", action: "back" }));
on("nav-forward", "click", () => sendMsg({ type: "nav", action: "forward" }));
on("nav-reload", "click", () => sendMsg({ type: "nav", action: "reload" }));
on("nav-url", "keydown", (e) => {
  if (e.key === "Enter") {
    const u = e.target.value || "";
    if (u) sendMsg({ type: "nav", action: "navigate", url: u });
    canvas && canvas.focus();
  }
});
on("fs-btn", "click", toggleFullscreen);

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && (e.key === "m" || e.key === "M")) {
    e.preventDefault(); e.stopPropagation();
    togglePanic();
  }
}, true);

window.addEventListener("DOMContentLoaded", () => {
  if (el("screen-login")) el("screen-login").hidden = false;
  if (el("screen-session")) el("screen-session").hidden = true;
  if (el("user-input") && username) el("user-input").value = username;
});