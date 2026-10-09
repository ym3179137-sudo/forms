function el(id) { return document.getElementById(id); }
function on(id, evt, fn) { const e = el(id); if (e) e.addEventListener(evt, fn); }

let token = localStorage.getItem("ixl_token") || "";
let username = localStorage.getItem("ixl_user") || "";
let launched = false;
let queueTimer = null;
let currentSite = "ixl";
let isOwner = false;

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
    if (ssoSite) {
      setTimeout(() => {
        const urls = {
          ixl: "https://www.ixl.com/",
          wayground: "https://wayground.com/",
          blooket: "https://www.blooket.com/",
          forms: "https://docs.google.com/forms/"
        };
        const target = urls[ssoSite.toLowerCase()];
        if (target) launchWithUrl(target, ssoSite.toLowerCase());
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

function showScreen(which) {
  ["screen-login", "screen-launcher", "screen-queue", "screen-session", "screen-expired", "screen-owner"].forEach(s => {
    el(s)?.classList.add("hidden");
  });
  el(which)?.classList.remove("hidden");
}

function setError(msg) {
  const box = el("error-box");
  if (!box) return;
  if (msg) { box.textContent = msg; box.classList.add("visible"); }
  else { box.textContent = ""; box.classList.remove("visible"); }
}

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

function normalizeUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(u) && !/\s/.test(u)) return "https://" + u;
  return "https://www.google.com/search?q=" + encodeURIComponent(u);
}

function showTimeExpired(message, expiresAt) {
  showScreen("screen-expired");
  const el1 = el("expired-message");
  if (el1) el1.textContent = message || "Your access has ended.";
  const el2 = el("expired-expires");
  if (el2 && expiresAt) el2.textContent = "Ended: " + new Date(expiresAt).toLocaleString();
}

async function launchWithUrl(targetUrl, site) {
  if (launched) return;
  launched = true;
  currentSite = site || "custom";

  showScreen("screen-queue");
  setQueueText("Connecting…", "Waiting for a free slot on the server");

  try {
    const res = await fetch("/api/session/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-IXL-Token": token },
      body: JSON.stringify({ url: targetUrl })
    });

    if (res.status === 402) {
      const data = await res.json();
      launched = false;
      showTimeExpired(data.message, data.expiresAt);
      return;
    }
    if (res.status === 403) {
      const data = await res.json();
      launched = false;
      showScreen("screen-launcher");
      alert("You don't have access to that app. Ask the owner.");
      return;
    }

    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "session start failed");
    if (data.ready) { openVnc(data.wsPath); return; }
    startQueuePolling(targetUrl);
  } catch (err) {
    setQueueText("Error", err.message);
    setTimeout(() => { launched = false; showScreen("screen-launcher"); }, 2500);
  }
}

function startQueuePolling(targetUrl) {
  if (queueTimer) clearInterval(queueTimer);
  queueTimer = setInterval(async () => {
    try {
      const res = await fetch("/api/session/status", { headers: { "X-IXL-Token": token } });
      if (res.status === 402) {
        const data = await res.json();
        clearInterval(queueTimer);
        queueTimer = null;
        launched = false;
        showTimeExpired(data.message, data.expiresAt);
        return;
      }
      const data = await res.json();
      if (data.ready) {
        clearInterval(queueTimer);
        queueTimer = null;
        openVnc(data.wsPath);
        return;
      }
      const pos = data.position;
      const active = data.totalActive;
      const max = data.maxActive;
      if (pos && pos > 0) {
        setQueueText(`You're #${pos} in queue`, `${active}/${max} browsers busy · ${data.queued} waiting`);
      } else {
        setQueueText("Starting your browser…", `${active}/${max} browsers busy`);
      }
    } catch (_) { }
  }, 1500);
}

function setQueueText(main, sub) {
  const m = el("queue-main");
  const s = el("queue-sub");
  if (m) m.textContent = main;
  if (s) s.textContent = sub;
}

function openVnc(wsPath) {
  showScreen("screen-session");
  const frame = el("vnc-frame");
  if (frame) {
    // noVNC prepends its own leading slash — strip ours to avoid //
    const cleanPath = String(wsPath).replace(/^\//, "");

    const params = new URLSearchParams({
      autoconnect: "1",
      resize: "scale",
      scale: "1",
      view_clip: "0",
      path: cleanPath,
      host: location.hostname,
      port: location.port || (location.protocol === "https:" ? "443" : "80"),
      encrypt: location.protocol === "https:" ? "1" : "0",
      reconnect: "1",
      reconnect_delay: "500",
      show_dot: "0",
      compression: "4",
      quality: "8",
      view_only: "0",
      shared: "1"
    });

    frame.src = `/session/vnc/${encodeURIComponent(username)}/vnc.html?${params.toString()}`;
    startIframeWatch();
  }
}

function backToLauncher() {
  launched = false;
  if (queueTimer) { clearInterval(queueTimer); queueTimer = null; }
  const frame = el("vnc-frame");
  if (frame) frame.src = "";
  showScreen("screen-launcher");
}

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
    await bootLauncher();
  } catch (err) {
    setError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "START";
    el("boot-msg").textContent = "sign in to continue";
  }
});

on("pass-input", "keydown", (e) => { if (e.key === "Enter") el("login-submit")?.click(); });

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
    await bootLauncher();
  } catch (err) {
    setError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "CREATE ACCOUNT";
  }
});

on("signup-pass", "keydown", (e) => { if (e.key === "Enter") el("signup-submit")?.click(); });

async function bootLauncher() {
  showScreen("screen-launcher");

  let me;
  try {
    const res = await fetch("/api/me", { headers: { "X-IXL-Token": token } });
    if (res.status === 402) {
      const data = await res.json();
      showTimeExpired(data.message, data.expiresAt);
      return;
    }
    if (res.status === 401) {
      localStorage.removeItem("ixl_token");
      localStorage.removeItem("ixl_user");
      showScreen("screen-login");
      return;
    }
    me = await res.json();
  } catch (_) {
    showScreen("screen-login");
    return;
  }

  isOwner = !!me.isOwner;

  let allowedApps = ["ixl"];
  try {
    const res = await fetch("/api/my-apps", { headers: { "X-IXL-Token": token } });
    const data = await res.json();
    allowedApps = (data.apps || []).map(a => a.id);
  } catch (_) { }

  renderLauncherGrid(allowedApps);

  if (isOwner) el("owner-panel-btn")?.classList.remove("hidden");
  else el("owner-panel-btn")?.classList.add("hidden");
}

function renderLauncherGrid(allowedApps) {
  const grid = document.querySelector(".launcher-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const catalog = {
    ixl: { url: "https://www.ixl.com/", icon: "📘", label: "IXL", desc: "math, reading, science" },
    blooket: { url: "https://www.blooket.com/", icon: "🎮", label: "BLOOKET", desc: "game-based review" },
    wayground: { url: "https://wayground.com/", icon: "⚡", label: "WAYGROUND", desc: "quizzes & review" },
    forms: { url: "https://docs.google.com/forms/", icon: "📝", label: "FORMS", desc: "google forms solver" }
  };

  const allowAll = allowedApps.includes("*");
  const allowed = allowAll ? Object.keys(catalog) : allowedApps.filter(a => a !== "unblock");

  for (const id of allowed) {
    const app = catalog[id];
    if (!app) continue;
    const btn = document.createElement("button");
    btn.className = "launcher-btn";
    btn.setAttribute("data-url", app.url);
    btn.setAttribute("data-site", id);
    btn.innerHTML = `
            <div class="launcher-icon">${app.icon}</div>
            <div class="launcher-label">${app.label}</div>
            <div class="launcher-desc">${app.desc}</div>
        `;
    btn.addEventListener("click", () => launchWithUrl(app.url, id));
    grid.appendChild(btn);
  }

  const allowUnblock = allowAll || allowedApps.includes("unblock");
  const unblockSection = document.querySelector(".unblock-label");
  const unblockBar = document.querySelector(".unblock-bar");
  if (unblockSection) unblockSection.style.display = allowUnblock ? "" : "none";
  if (unblockBar) unblockBar.style.display = allowUnblock ? "flex" : "none";
}

on("unblock-go", "click", () => {
  const input = el("unblock-input");
  if (!input) return;
  const url = normalizeUrl(input.value);
  if (!url) { input.focus(); return; }
  launchWithUrl(url, "custom");
});

on("unblock-input", "keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); el("unblock-go")?.click(); }
});

on("logout-btn", "click", async () => {
  try { await fetch("/api/session/end", { method: "POST", headers: { "X-IXL-Token": token } }); } catch (_) { }
  localStorage.removeItem("ixl_token");
  localStorage.removeItem("ixl_user");
  token = "";
  username = "";
  launched = false;
  const frame = el("vnc-frame");
  if (frame) frame.src = "";
  showScreen("screen-login");
});

on("session-back", "click", backToLauncher);
on("queue-cancel", "click", async () => {
  try { await fetch("/api/session/end", { method: "POST", headers: { "X-IXL-Token": token } }); } catch (_) { }
  backToLauncher();
});
on("expired-refresh", "click", () => location.reload());

on("owner-panel-btn", "click", async () => {
  showScreen("screen-owner");
  await refreshOwnerUserList();
});
on("owner-back", "click", () => showScreen("screen-launcher"));

on("new-user-submit", "click", async () => {
  const name = el("new-user-name").value.trim();
  const pass = el("new-user-pass").value;
  const hours = parseInt(el("new-user-hours").value) || 24;
  if (!name || !pass) return alert("username + password required");
  const res = await fetch("/api/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-IXL-Token": token },
    body: JSON.stringify({ username: name, password: pass, hours, apps: ["ixl"] })
  });
  if (res.ok) {
    el("new-user-name").value = "";
    el("new-user-pass").value = "";
    await refreshOwnerUserList();
  } else {
    const d = await res.json().catch(() => ({}));
    alert(d.error || "failed");
  }
});

async function refreshOwnerUserList() {
  const box = el("owner-user-list");
  if (!box) return;
  box.innerHTML = "<p style='opacity:0.6'>Loading…</p>";

  const res = await fetch("/api/users", { headers: { "X-IXL-Token": token } });
  if (res.status === 403) { box.innerHTML = "<p>Owner only.</p>"; return; }
  const data = await res.json();
  const users = data.users || [];

  box.innerHTML = "";
  for (const u of users) {
    const row = document.createElement("div");
    row.className = "owner-user-row";

    const now = Date.now();
    let timeStr = "—";
    if (u.role === "owner") timeStr = "OWNER · never expires";
    else if (u.expiresAt == null) timeStr = "no time set";
    else if (u.expiresAt < now) timeStr = "EXPIRED";
    else {
      const ms = u.expiresAt - now;
      const days = Math.floor(ms / 86400000);
      const hours = Math.floor((ms % 86400000) / 3600000);
      timeStr = days > 0 ? `${days}d ${hours}h left` : `${hours}h left`;
    }

    const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const safeUser = esc(u.username);
    const has = (a) => u.apps.includes("*") || u.apps.includes(a);

    row.innerHTML = `
            <div class="owner-user-info">
                <b>${safeUser}</b>
                <span class="owner-user-time">${timeStr}</span>
                ${u.role !== "user" ? `<span class="owner-user-role">${u.role}</span>` : ""}
            </div>
            <div class="owner-user-apps">
                <span>Apps:</span>
                <label><input type="checkbox" data-username="${safeUser}" data-app="ixl" ${has("ixl") ? "checked" : ""}> IXL</label>
                <label><input type="checkbox" data-username="${safeUser}" data-app="blooket" ${has("blooket") ? "checked" : ""}> Blooket</label>
                <label><input type="checkbox" data-username="${safeUser}" data-app="wayground" ${has("wayground") ? "checked" : ""}> Wayground</label>
                <label><input type="checkbox" data-username="${safeUser}" data-app="forms" ${has("forms") ? "checked" : ""}> Forms</label>
                <label><input type="checkbox" data-username="${safeUser}" data-app="unblock" ${has("unblock") ? "checked" : ""}> Unblock</label>
            </div>
            <div class="owner-user-actions">
                <button data-act="add-1h" data-username="${safeUser}">+1h</button>
                <button data-act="add-1d" data-username="${safeUser}">+1d</button>
                <button data-act="add-7d" data-username="${safeUser}">+7d</button>
                <button data-act="add-30d" data-username="${safeUser}">+30d</button>
                <button data-act="save-apps" data-username="${safeUser}">Save apps</button>
                <button data-act="delete" data-username="${safeUser}" class="danger">Delete</button>
            </div>
        `;
    box.appendChild(row);
  }

  box.querySelectorAll("button[data-act]").forEach(btn => {
    btn.addEventListener("click", () => handleOwnerAction(btn.getAttribute("data-act"), btn.getAttribute("data-username"), btn));
  });
}

async function handleOwnerAction(act, username, btn) {
  const HOURS = { "add-1h": 1, "add-1d": 24, "add-7d": 168, "add-30d": 720 };

  if (HOURS[act]) {
    btn.disabled = true;
    try {
      await fetch(`/api/users/${encodeURIComponent(username)}/add-time`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-IXL-Token": token },
        body: JSON.stringify({ hours: HOURS[act], note: "owner granted" })
      });
      await refreshOwnerUserList();
    } catch (_) { btn.disabled = false; }
    return;
  }

  if (act === "save-apps") {
    btn.disabled = true;
    const checkboxes = document.querySelectorAll(`input[data-username="${CSS.escape(username)}"][data-app]`);
    const apps = [];
    checkboxes.forEach(cb => { if (cb.checked) apps.push(cb.getAttribute("data-app")); });
    try {
      await fetch(`/api/users/${encodeURIComponent(username)}/apps`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-IXL-Token": token },
        body: JSON.stringify({ apps })
      });
      btn.textContent = "✓ saved";
      setTimeout(() => { btn.textContent = "Save apps"; btn.disabled = false; }, 1200);
    } catch (_) { btn.disabled = false; }
    return;
  }

  if (act === "delete") {
    if (!confirm(`Delete ${username}? They lose access immediately.`)) return;
    btn.disabled = true;
    try {
      await fetch(`/api/users/${encodeURIComponent(username)}`, {
        method: "DELETE",
        headers: { "X-IXL-Token": token }
      });
      await refreshOwnerUserList();
    } catch (_) { btn.disabled = false; }
    return;
  }
}

window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "m" || e.key === "M")) {
    e.preventDefault(); e.stopPropagation();
    const o = el("panic-overlay");
    if (o) o.hidden = !o.hidden;
  }
}, true);

window.addEventListener("DOMContentLoaded", async () => {
  if (el("user-input") && username) el("user-input").value = username;
  if (token) await bootLauncher();
  else showScreen("screen-login");
});