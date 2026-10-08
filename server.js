function el(id) { return document.getElementById(id); }
function on(id, evt, fn) { const e = el(id); if (e) e.addEventListener(evt, fn); }

let token = localStorage.getItem("ixl_token") || "";
let username = localStorage.getItem("ixl_user") || "";
let launched = false;

// ─── SSO pickup from CyberVault ─────────────────────────
(function pickUpSSO() {
  const hash = location.hash.slice(1);
  if (!hash) return;
  const params = new URLSearchParams(hash);
  const ssoToken = params.get("sso_token");
  const ssoUser = params.get("sso_user");
  const ssoSite = params.get("sso_site");
  if (ssoToken && ssoUser) {
    token = ssoToken;
    username = ssoUser;
    localStorage.setItem("ixl_token", token);
    localStorage.setItem("ixl_user", username);
    history.replaceState(null, "", location.pathname);
    console.log("[sso] logged in as", username, "site:", ssoSite);

    // if CyberVault told us which site to open, jump straight there
    if (ssoSite) {
      setTimeout(() => {
        const urls = {
          ixl: "https://www.ixl.com/",
          wayground: "https://wayground.com/",
          blooket: "https://www.blooket.com/",
          forms: "https://docs.google.com/forms/"
        };
        const target = urls[ssoSite.toLowerCase()];
        if (target) launchWithUrl(target);
      }, 400);
    }
  }
})();

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

async function trySignup(u, p, e) {
  const res = await fetch("/api/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: u, password: p, email: e })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "signup failed");
  return data;
}

function showLogin() {
  el("screen-login")?.classList.remove("hidden");
  el("screen-launcher")?.classList.add("hidden");
  el("screen-session")?.classList.add("hidden");
}

function showLauncher() {
  el("screen-login")?.classList.add("hidden");
  el("screen-launcher")?.classList.remove("hidden");
  el("screen-session")?.classList.add("hidden");
}

function showSession() {
  el("screen-login")?.classList.add("hidden");
  el("screen-launcher")?.classList.add("hidden");
  el("screen-session")?.classList.remove("hidden");
}

function setError(msg) {
  const box = el("error-box");
  if (!box) return;
  if (msg) {
    box.textContent = msg;
    box.classList.add("visible");
  } else {
    box.textContent = "";
    box.classList.remove("visible");
  }
}

// ─── noVNC cleanup ──────────────────────────────────────
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

// ─── url normalization ──────────────────────────────────
function normalizeUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(u) && !/\s/.test(u)) return "https://" + u;
  return "https://www.google.com/search?q=" + encodeURIComponent(u);
}

// ─── launch ─────────────────────────────────────────────
function launchWithUrl(targetUrl) {
  if (launched) return;
  launched = true;

  showSession();

  // fire navigation in background — don't block VNC connect
  fetch("/api/navigate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-IXL-Token": token },
    body: JSON.stringify({ url: targetUrl })
  }).catch(() => { });

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

// ─── tab switching ──────────────────────────────────────
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.getAttribute("data-tab");
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.add("hidden"));
    el("tab-" + which)?.classList.remove("hidden");
    setError("");
  });
});

// ─── login ──────────────────────────────────────────────
on("login-submit", "click", async () => {
  const u = el("user-input")?.value.trim() || "";
  const p = el("pass-input")?.value || "";
  if (!u || !p) { setError("username and password required"); return; }
  setError("");
  el("boot-msg").textContent = "signing in...";
  const btn = el("login-submit");
  btn.disabled = true;
  btn.textContent = "...";
  try {
    const data = await tryLogin(u, p);
    token = data.token;
    username = data.username;
    localStorage.setItem("ixl_token", token);
    localStorage.setItem("ixl_user", username);
    showLauncher();
  } catch (err) {
    setError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "START";
    el("boot-msg").textContent = "sign in to continue";
  }
});

on("pass-input", "keydown", (e) => { if (e.key === "Enter") el("login-submit")?.click(); });

// ─── signup ─────────────────────────────────────────────
on("signup-submit", "click", async () => {
  const u = el("signup-user")?.value.trim() || "";
  const p = el("signup-pass")?.value || "";
  const e = el("signup-email")?.value.trim() || "";
  if (!u || !p) { setError("username and password required"); return; }
  setError("");
  const btn = el("signup-submit");
  btn.disabled = true;
  btn.textContent = "...";
  try {
    const data = await trySignup(u, p, e);
    token = data.token;
    username = data.username;
    localStorage.setItem("ixl_token", token);
    localStorage.setItem("ixl_user", username);
    showLauncher();
  } catch (err) {
    setError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "CREATE ACCOUNT";
  }
});

on("signup-pass", "keydown", (e) => { if (e.key === "Enter") el("signup-submit")?.click(); });

// ─── launcher buttons ───────────────────────────────────
document.querySelectorAll("button.launcher-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const url = btn.getAttribute("data-url");
    if (url) launchWithUrl(url);
  });
});

// ─── unblock bar ────────────────────────────────────────
on("unblock-go", "click", () => {
  const input = el("unblock-input");
  if (!input) return;
  const url = normalizeUrl(input.value);
  if (!url) { input.focus(); return; }
  launchWithUrl(url);
});

on("unblock-input", "keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); el("unblock-go")?.click(); }
});

// ─── logout ─────────────────────────────────────────────
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

// ─── panic mode ─────────────────────────────────────────
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "m" || e.key === "M")) {
    e.preventDefault(); e.stopPropagation();
    const o = el("panic-overlay");
    if (o) o.hidden = !o.hidden;
  }
}, true);

// ─── boot ───────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  if (el("user-input") && username) el("user-input").value = username;
  if (token) showLauncher();
  else showLogin();
});