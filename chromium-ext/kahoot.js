(function () {
    if (window.__kahoot_injected__) return;
    window.__kahoot_injected__ = true;

    const API_BASE = "";
    let token = "";
    try {
        const m = location.search.match(/[?&]ixl_solver_token=([^&]+)/);
        if (m) { token = decodeURIComponent(m[1]); sessionStorage.setItem("__ixl_tok", token); }
        else { token = sessionStorage.getItem("__ixl_tok") || ""; }
    } catch (_) { }

    const css = `
    #__kh_panel { position: fixed; top: 16px; right: 16px; width: 320px; background: rgba(18,22,34,0.97); color: #d8dde8; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; border: 1px solid rgba(120,140,200,0.35); border-radius: 10px; padding: 10px; z-index: 2147483647; box-shadow: 0 8px 32px rgba(0,0,0,0.5); user-select: none; }
    #__kh_panel.__hidden { display: none !important; }
    #__kh_panel .__kh_header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    #__kh_panel .__kh_title { font-weight: 600; color: #ffcc00; letter-spacing: 0.5px; }
    #__kh_panel .__kh_min { background: transparent; border: none; color: #889; cursor: pointer; font-size: 14px; padding: 0 4px; }
    #__kh_panel .__kh_toggle { width: 100%; background: linear-gradient(180deg,#ffcc00,#e69900); color: #000; border: none; border-radius: 6px; padding: 9px 10px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; }
    #__kh_panel .__kh_toggle.__on { background: linear-gradient(180deg,#d64545,#a83232); color: #fff; }
    #__kh_panel .__kh_status { margin-top: 8px; color: #aab; font-size: 11px; }
    #__kh_panel .__kh_log { margin-top: 6px; max-height: 200px; overflow-y: auto; font-size: 10px; color: #889; line-height: 1.5; }
    #__kh_panel .__kh_log div { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
    #__kh_panel .__kh_log .ok { color: #6d8; }
    #__kh_panel .__kh_log .err { color: #d67; }
  `;

    let running = false;
    let panelEl = null, statusEl = null, logEl = null, toggleBtn = null;
    let busy = false;
    let lastSig = "";
    let clickTimeout = null;

    function ensureStyle() {
        if (document.getElementById("__kh_style")) return;
        const s = document.createElement("style");
        s.id = "__kh_style";
        s.textContent = css;
        document.documentElement.appendChild(s);
    }

    function pushLog(text, cls) {
        if (!logEl) return;
        const d = document.createElement("div");
        if (cls) d.className = cls;
        d.textContent = text;
        logEl.appendChild(d);
        logEl.scrollTop = logEl.scrollHeight;
        while (logEl.children.length > 30) logEl.removeChild(logEl.firstChild);
    }
    function setStatus(s) { if (statusEl) statusEl.textContent = "status: " + s; }

    // ─── find question + answer buttons ─────────────────
    function parseQuestion() {
        const qEl = document.querySelector('[data-functional-selector="question-title"]')
            || document.querySelector('[class*="question-title"]')
            || document.querySelector('h2[class*="question"]');
        const question = qEl ? (qEl.innerText || "").trim() : "";

        // Kahoot answer buttons have data-functional-selector="answer-0..3"
        const buttons = Array.from(document.querySelectorAll(
            '[data-functional-selector^="answer-"], button[data-functional-selector^="answer-"]'
        ));

        const options = buttons.map(b => {
            const textEl = b.querySelector('[data-functional-selector="answer-text"]');
            const text = textEl ? (textEl.innerText || "").trim() : "";
            return { text, el: b };
        });

        return { question, options };
    }

    // ─── click a Kahoot answer button ───────────────────
    function clickButton(el) {
        if (!el) return false;
        try { el.scrollIntoView({ block: "center" }); } catch (_) { }
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const target = document.elementFromPoint(x, y) || el;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
        try {
            target.dispatchEvent(new PointerEvent("pointerdown", { ...opts, buttons: 1 }));
            target.dispatchEvent(new MouseEvent("mousedown", { ...opts, buttons: 1 }));
            target.dispatchEvent(new PointerEvent("pointerup", opts));
            target.dispatchEvent(new MouseEvent("mouseup", opts));
            target.dispatchEvent(new MouseEvent("click", opts));
        } catch (_) { }
        try { el.click(); } catch (_) { }
        return true;
    }

    async function askBackend(question, options) {
        const controller = new AbortController();
        const to = setTimeout(() => controller.abort(), 20000);
        try {
            const res = await fetch(`${API_BASE}/api/solve`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-IXL-Token": token },
                body: JSON.stringify({
                    type: "multiple_choice",
                    stem: question,
                    options: options.map(o => o.text)
                }),
                signal: controller.signal
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `http ${res.status}`);
            }
            return await res.json();
        } finally { clearTimeout(to); }
    }

    async function loop() {
        if (!running || busy) return;
        busy = true;
        try {
            setStatus("watching");
            const q = parseQuestion();

            if (!q.question || q.question.length < 4 || q.options.length === 0) {
                busy = false;
                setTimeout(loop, 400);
                return;
            }

            const sig = q.question + "|" + q.options.map(o => o.text).join("|");
            if (sig === lastSig) {
                busy = false;
                setTimeout(loop, 400);
                return;
            }

            setStatus("solving");
            pushLog(`Q: ${q.question.slice(0, 60)}`);

            let answer;
            try {
                answer = await askBackend(q.question, q.options);
            } catch (err) {
                pushLog(`✗ ${err.message}`, "err");
                busy = false;
                setTimeout(loop, 1000);
                return;
            }

            const idx = answer.answer_index;
            if (typeof idx !== "number" || !q.options[idx]) {
                pushLog(`✗ bad answer: ${JSON.stringify(answer).slice(0, 60)}`, "err");
                busy = false;
                setTimeout(loop, 800);
                return;
            }

            pushLog(`→ ${q.options[idx].text.slice(0, 40)}`, "ok");
            lastSig = sig;

            // short delay so we don't slam the button on the same tick the question renders
            if (clickTimeout) clearTimeout(clickTimeout);
            clickTimeout = setTimeout(() => {
                const ok = clickButton(q.options[idx].el);
                pushLog(ok ? "✓ clicked" : "✗ click failed", ok ? "ok" : "err");
            }, 400);

            busy = false;
            if (running) setTimeout(loop, 500);
        } catch (err) {
            pushLog("loop error: " + err.message, "err");
            busy = false;
            if (running) setTimeout(loop, 800);
        }
    }

    function buildPanel() {
        if (document.getElementById("__kh_panel")) return;
        panelEl = document.createElement("div");
        panelEl.id = "__kh_panel";
        panelEl.innerHTML = `
      <div class="__kh_header">
        <span class="__kh_title">kahoot-solver</span>
        <button class="__kh_min" title="Ctrl+M">–</button>
      </div>
      <button class="__kh_toggle">▶ Start Auto</button>
      <div class="__kh_status">status: idle</div>
      <div class="__kh_log"></div>
    `;
        document.documentElement.appendChild(panelEl);

        toggleBtn = panelEl.querySelector(".__kh_toggle");
        statusEl = panelEl.querySelector(".__kh_status");
        logEl = panelEl.querySelector(".__kh_log");

        toggleBtn.addEventListener("click", () => {
            running = !running;
            statusEl.textContent = "status: " + (running ? "solving" : "idle");
            toggleBtn.textContent = running ? "■ Stop Auto" : "▶ Start Auto";
            toggleBtn.classList.toggle("__on", running);
            pushLog(running ? "auto started" : "auto paused", running ? "ok" : "");
            if (running) loop();
        });

        panelEl.querySelector(".__kh_min").addEventListener("click", () => panelEl.classList.add("__hidden"));

        window.addEventListener("keydown", (e) => {
            if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "m" || e.key === "M")) {
                e.preventDefault(); e.stopPropagation();
                panelEl.classList.toggle("__hidden");
            }
        }, true);
    }

    function boot() {
        ensureStyle();
        buildPanel();
        pushLog("kahoot-solver ready. Join a game, then click Start Auto.", "ok");
        const obs = new MutationObserver(() => {
            ensureStyle();
            if (!document.getElementById("__kh_panel")) buildPanel();
        });
        obs.observe(document.documentElement, { childList: true, subtree: false });
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();

    let lastUrl = location.href;
    setInterval(() => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            ensureStyle();
            buildPanel();
        }
    }, 1000);
})();