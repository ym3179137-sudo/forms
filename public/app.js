function el(id) { return document.getElementById(id); }
function on(id, evt, fn) { const e = el(id); if (e) e.addEventListener(evt, fn); }

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

function launch() {
  if (el("screen-login")) el("screen-login").hidden = true;
  if (el("screen-session")) el("screen-session").hidden = false;
  // load noVNC in the iframe
  const frame = el("vnc-frame");
  if (frame) frame.src = "/vnc/vnc.html?autoconnect=1&resize=scale&path=websockify&password=";
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

on("pass-input", "keydown", (e) => { if (e.key === "Enter") el("login-submit")?.click(); });

on("back-btn", "click", () => {
  if (el("screen-session")) el("screen-session").hidden = true;
  if (el("screen-login")) el("screen-login").hidden = false;
  const frame = el("vnc-frame");
  if (frame) frame.src = "";
});

on("fs-btn", "click", () => {
  const target = el("viewer-wrap") || document.documentElement;
  if (!document.fullscreenElement) target.requestFullscreen().catch(() => { });
  else document.exitFullscreen().catch(() => { });
});

// panic mode via Ctrl+M
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && (e.key === "m" || e.key === "M")) {
    e.preventDefault(); e.stopPropagation();
    const o = el("panic-overlay");
    if (o) o.hidden = !o.hidden;
  }
}, true);

window.addEventListener("DOMContentLoaded", () => {
  if (el("screen-login")) el("screen-login").hidden = false;
  if (el("screen-session")) el("screen-session").hidden = true;
  if (el("user-input") && username) el("user-input").value = username;
});