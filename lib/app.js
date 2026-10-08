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

async function loadIxlCreds() {
    try {
        const cached = localStorage.getItem("__ixl_creds_" + username);
        if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed.email && parsed.password) return { ...parsed, has: true };
        }
        const res = await fetch("/api/ixl-creds", { headers: { "X-IXL-Token": token } });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.has) localStorage.setItem("__ixl_creds_" + username, JSON.stringify(data));
        return data;
    } catch (_) { return null; }
}

async function saveIxlCreds(email, password) {
    try { localStorage.setItem("__ixl_creds_" + username, JSON.stringify({ email, password })); } catch (_) { }
    try {
        const res = await fetch("/api/ixl-creds", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-IXL-Token": token },
            body: JSON.stringify({ email, password })
        });
        return await res.json();
    } catch (_) { return { ok: false }; }
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

function launch() {
    if (launched) return;
    launched = true;
    if (el("screen-login")) el("screen-login").hidden = true;
    if (el("screen-session")) el("screen-session").hidden = false;

    const frame = el("vnc-frame");
    if (frame) {
        frame.src = "/vnc/vnc.html?autoconnect=1&resize=scale&scale=1&view_clip=0&path=vnc/websockify&reconnect=1&reconnect_delay=500&show_dot=0&compression=4&quality=8&view_only=0&shared=1";
        startIframeWatch();
    }
}

function openIxlModal(prefill) {
    const modal = el("ixl-modal");
    if (!modal) return;
    if (prefill) {
        if (el("ixl-email")) el("ixl-email").value = prefill.email || "";
        if (el("ixl-pass")) el("ixl-pass").value = prefill.password || "";
    }
    modal.hidden = false;
}

function closeIxlModal() {
    const modal = el("ixl-modal");
    if (modal) modal.hidden = true;
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

        const creds = await loadIxlCreds();
        if (creds && creds.has) launch();
        else openIxlModal(creds || null);
    } catch (err) {
        if (el("error-box")) { el("error-box").hidden = false; el("error-box").textContent = err.message; }
        if (el("boot-msg")) el("boot-msg").textContent = "sign in to continue.";
    }
});

on("pass-input", "keydown", (e) => { if (e.key === "Enter") el("login-submit")?.click(); });

on("ixl-save", "click", async () => {
    const email = el("ixl-email")?.value.trim() || "";
    const password = el("ixl-pass")?.value || "";
    if (!email || !password) return;
    const btn = el("ixl-save");
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    await saveIxlCreds(email, password);
    if (btn) { btn.disabled = false; btn.textContent = "Save & Log In"; }
    closeIxlModal();
    launch();
});

on("ixl-skip", "click", () => { closeIxlModal(); launch(); });

window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "m" || e.key === "M")) {
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