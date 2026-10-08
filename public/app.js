function el(id) { return document.getElementById(id); }
function on(id, evt, fn) { const e = el(id); if (e) e.addEventListener(evt, fn); }

let token = localStorage.getItem("ixl_token") || "";
let username = localStorage.getItem("ixl_user") || "";
let launched = false;

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

function showLogin() {
  if (el("screen-login")) el("screen-login").classList.remove("hidden");
  if (el("screen-launcher")) el("screen-launcher").classList.add("hidden");
  if (el("screen-session")) el("screen-session").classList.add("hidden");
}

function showLauncher() {
  if (el("screen-login")) el("screen-login").classList.add("hidden");
  if (el("screen-launcher")) el("screen-launcher").classList.remove("hidden");
  if (el("screen-session")) el("screen-session").classList.add("hidden");
}

function showSession() {
  if (el("screen-login")) el("screen-login").classList.add("hidden");
  if (el("screen-launcher")) el("screen-launcher").classList.add("hidden");
  if (el("screen-session")) el("screen-session").classList.remove("hidden");
}

// hide noVNC's own toolbar inside the iframe
function injectNoVncCleanup() {
  const frame = el("vnc-frame");
  if (!frame) return;
  try {
    const doc = frame.contentDocument;
    if (!doc) return;
    if (doc.getElementById("__ixl_hide_ui")) return;
    const s = doc.createElement("style");
    s.id = "__ixl_hide_ui";
    s.textContent = `
      #noVNC_control_bar_anchor, #noVNC_control_bar, #noVNC_control_bar_handle,
      .noVNC_control_bar_anchor, #noVNC_status, #noVNC_screen .noVNC_status_bar,
      .noVNC_panel, #noVNC_connect_button, #noVNC_disconnect_button,
      #noVNC_clipboard_button, #noVNC_settings_button, #noVNC_fullscreen_button,
      #noVNC_view_drag_button, #noVNC_mobile_buttons, #noVNC_transition { display: none !important; }
      #noVNC_screen { padding: 0 !important; margin: 0 !important; }
      #noVNC_container, #noVNC_canvas { margin: 0 !important; padding: 0 !important; }
    `;
    (doc.head || doc.documentElement).appendChild(s);
  } catch (_) { }
}

function startIframeWatch() {
  const frame = el("vnc-frame");
  if (!frame) return;
  frame.addEventListener("load", () => {
    injectNoVncCleanup();
    setTimeout(injectNoVncCleanup, 500);
    setTimeout(injectNoVncCleanup, 1500);
    setTimeout(injectNoVncCleanup, 3000);
  });
  setInterval(injectNoVncCleanup, 2000);
}

async function launchWithUrl(targetUrl) {
  if (launched) return;
  launched = true;

  showSession();

  // ask the server to navigate chromium to the target URL
  try {
    await fetch("/api/navigate", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-IXL-Token": token },
      body: JSON.stringify({ url: targetUrl })
    });
  } catch (_) { }

  const frame = el("vnc-frame");
  if (frame) {
    frame.src = "/vnc/vnc.html?autoconnect=1&resize=scale&scale=1&view_clip=0&path=vnc/websockify&reconnect=1&reconnect_delay=500&show_dot=0&compression=4&quality=8&view_only=0&shared=1";
    startIframeWatch();
  }
}

function backToLauncher() {
  launched = false;
  const frame = el("vnc-frame");
  if (frame) frame.src = "";
  showLauncher();
}

// ─── login ─────────────────────────────────────────────
on("login-submit", "click", async () => {
  const u = el("user-input") ? el("user-input").value.trim() : "";
  const p = el("pass-input") ? el("pass-input").value : "";
  if (!u || !p) return;

  const errBox = el("error-box");
  const bootMsg = el("boot-msg");
  if (errBox) errBox.textContent = "";
  if (bootMsg) bootMsg.textContent = "signing in...";

  const btn = el("login-submit");
  if (btn) { btn.disabled = true; btn.textContent = "..."; }

  try {
    const data = await tryLogin(u, p);
    token = data.token;
    username = data.username;
    localStorage.setItem("ixl_token", token);
    localStorage.setItem("ixl_user", username);
    if (bootMsg) bootMsg.textContent = "sign in to continue";
    showLauncher();
  } catch (err) {
    if (errBox) errBox.textContent = err.message;
    if (bootMsg) bootMsg.textContent = "sign in to continue";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "START"; }
  }
});

on("pass-input", "keydown", (e) => { if (e.key === "Enter") el("login-submit")?.click(); });

// ─── launcher buttons ──────────────────────────────────
document.querySelectorAll("button.cabinet").forEach(btn => {
  btn.addEventListener("click", () => {
    const url = btn.getAttribute("data-url");
    if (url) launchWithUrl(url);
  });
});

on("logout-btn", "click", () => {
  localStorage.removeItem("ixl_token");
  localStorage.removeItem("ixl_user");
  token = "";
  username = "";
  launched = false;
  const frame = el("vnc-frame");
  if (frame) frame.src = "";
  showLogin();
});

on("session-back", "click", backToLauncher);

// ─── panic mode (Ctrl+M) ───────────────────────────────
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "m" || e.key === "M")) {
    e.preventDefault(); e.stopPropagation();
    const o = el("panic-overlay");
    if (o) o.hidden = !o.hidden;
  }
}, true);

// ─── boot ──────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  if (el("user-input") && username) el("user-input").value = username;
  if (token) showLauncher();
  else showLogin();
});