(function () {
    if (window.__wayground_injected__) return;
    window.__wayground_injected__ = true;

    const API_BASE = "";
    let token = "";
    try {
        const m = location.search.match(/[?&]ixl_solver_token=([^&]+)/);
        if (m) { token = decodeURIComponent(m[1]); sessionStorage.setItem("__ixl_tok", token); }
        else { token = sessionStorage.getItem("__ixl_tok") || ""; }
    } catch (_) { }

    const css = `
    #__wg_panel { position: fixed; top: 16px; right: 16px; width: 320px; background: rgba(18,22,34,0.97); color: #d8dde8; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; border: 1px solid rgba(120,140,200,0.35); border-radius: 10px; padding: 10px; z-index: 2147483647; box-shadow: 0 8px 32px rgba(0,0,0,0.5); user-select: none; }
    #__wg_panel.__hidden { display: none !important; }
    #__wg_panel .__wg_header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    #__wg_panel .__wg_title { font-weight: 600; color: #ff8a3d; letter-spacing: 0.5px; }
    #__wg_panel .__wg_min { background: transparent; border: none; color: #889; cursor: pointer; font-size: 14px; padding: 0 4px; }
    #__wg_panel .__wg_toggle { width: 100%; background: linear-gradient(180deg,#ff8a3d,#e66919); color: #fff; border: none; border-radius: 6px; padding: 9px 10px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; }
    #__wg_panel .__wg_toggle.__on { background: linear-gradient(180deg,#d64545,#a83232); }
    #__wg_panel .__wg_status { margin-top: 8px; color: #aab; font-size: 11px; }
    #__wg_panel .__wg_log { margin-top: 6px; max-height: 180px; overflow-y: auto; font-size: 10px; color: #889; line-height: 1.5; }
    #__wg_panel .__wg_log div { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
    #__wg_panel .__wg_log .ok { color: #6d8; }
    #__wg_panel .__wg_log .err { color: #d67; }
  `;

    let running = false;
    let panelEl = null, statusEl = null, logEl = null, toggleBtn = null;
    let busy = false;
    let lastAnsweredSig = "";

    function ensureStyle() {
        if (document.getElementById("__wg_style")) return;
        const s = document.createElement("style");
        s.id = "__wg_style";
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

    // ─── read the current quizizz question ─────────────────
    function parseQuestion() {
        // quizizz has a few possible containers; try several
        const stemEl =
            document.querySelector('[class*="question-text"]') ||
            document.querySelector('[class*="QuestionText"]') ||
            document.querySelector('[class*="question-container"] h2') ||
            document.querySelector('h2[class*="question"]') ||
            document.querySelector('.question-text-color');

        let stem = "";
        if (stemEl) stem = (stemEl.innerText || "").trim();
        if (!stem) {
            // fallback: biggest visible text block
            const candidates = Array.from(document.querySelectorAll("h1, h2, h3, p, div"))
                .filter(e => e.offsetParent !== null && e.children.length < 6);
            let longest = "";
            for (const c of candidates) {
                const t = (c.innerText || "").trim();
                if (t.length > longest.length && t.length < 500) longest = t;
            }
            stem = longest;
        }

        // options — quizizz answers have class with "answer" or "option"
        const optionEls = Array.from(document.querySelectorAll(
            '[class*="answer-option"], [class*="AnswerOption"], [class*="option-container"] [class*="option"], [class*="answer-container"] button, [class*="answer-container"] [role="button"]'
        )).filter(e => e.offsetParent !== null);

        const options = optionEls.map(e => (e.innerText || "").trim()).filter(Boolean);

        let type = "unknown";
        if (options.length >= 2) type = "multiple_choice";
        else {
            // check for fill-in
            const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])'))
                .filter(i => !i.disabled && i.offsetParent !== null);
            if (inputs.length > 0) type = "fill_in";
        }

        return { type, stem: stem.slice(0, 1500), options };
    }

    // ─── click the right option ─────────────────────────────
    function clickElement(el) {
        if (!el) return false;
        try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) { }
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const target = document.elementFromPoint(x, y) || el;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
        try {
            target.dispatchEvent(new PointerEvent("pointerover", opts));
            target.dispatchEvent(new MouseEvent("mouseover", opts));
            target.dispatchEvent(new PointerEvent("pointerdown", { ...opts, buttons: 1 }));
            target.dispatchEvent(new MouseEvent("mousedown", { ...opts, buttons: 1 }));
            target.dispatchEvent(new PointerEvent("pointerup", opts));
            target.dispatchEvent(new MouseEvent("mouseup", opts));
            target.dispatchEvent(new MouseEvent("click", opts));
        } catch (_) { }
        try { el.click(); } catch (_) { }
        return true;
    }

    function applyAnswer(question, answer) {
        if (answer.type === "multiple_choice" && typeof answer.answer_index === "number") {
            const optionEls = Array.from(document.querySelectorAll(
                '[class*="answer-option"], [class*="AnswerOption"], [class*="option-container"] [class*="option"], [class*="answer-container"] button, [class*="answer-container"] [role="button"]'
            )).filter(e => e.offsetParent !== null);
            const el = optionEls[answer.answer_index];
            if (!el) return false;
            return clickElement(el);
        }
        if (answer.type === "fill_in") {
            const input = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])'))
                .find(i => !i.disabled && i.offsetParent !== null);
            if (!input) return false;
            input.focus();
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            setter.call(input, String(answer.value || ""));
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            try {
                const submitBtn = Array.from(document.querySelectorAll("button")).find(b => /submit|next|send/i.test(b.innerText || ""));
                if (submitBtn) clickElement(submitBtn);
            } catch (_) { }
            return true;
        }
        return false;
    }

    async function askBackend(q) {
        const controller = new AbortController();
        const to = setTimeout(() => controller.abort(), 32000);
        try {
            const res = await fetch(`${API_BASE}/api/solve`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-IXL-Token": token },
                body: JSON.stringify(q),
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
            setStatus("reading question");
            const q = parseQuestion();

            if (!q.stem || q.stem.length < 5) {
                setStatus("no question yet");
                busy = false;
                setTimeout(loop, 700);
                return;
            }
            if (q.type === "unknown") {
                setStatus("unknown type");
                busy = false;
                setTimeout(loop, 900);
                return;
            }

            const sig = q.stem + "|" + (q.options || []).join("|");
            if (sig === lastAnsweredSig) {
                setStatus("waiting for next");
                busy = false;
                setTimeout(loop, 1000);
                return;
            }

            setStatus(`thinking (${q.type})`);
            pushLog(`q[${q.type}] ${q.stem.slice(0, 50)}`);

            let answer;
            try {
                answer = await askBackend(q);
            } catch (err) {
                pushLog("✗ " + err.message, "err");
                busy = false;
                setTimeout(loop, 1500);
                return;
            }

            pushLog(`ai → ${JSON.stringify(answer).slice(0, 60)}`, "ok");

            const ok = applyAnswer(q, answer);
            if (ok) {
                lastAnsweredSig = sig;
                pushLog("✓ clicked answer", "ok");
            } else {
                pushLog("✗ could not click", "err");
            }

            busy = false;
            if (running) setTimeout(loop, 600);
        } catch (err) {
            pushLog("loop error: " + err.message, "err");
            busy = false;
            if (running) setTimeout(loop, 1000);
        }
    }

    function buildPanel() {
        if (document.getElementById("__wg_panel")) return;
        panelEl = document.createElement("div");
        panelEl.id = "__wg_panel";
        panelEl.innerHTML = `
      <div class="__wg_header">
        <span class="__wg_title">wayground-solver</span>
        <button class="__wg_min" title="Ctrl+M">–</button>
      </div>
      <button class="__wg_toggle">▶ Start Auto</button>
      <div class="__wg_status">status: idle</div>
      <div class="__wg_log"></div>
    `;
        document.documentElement.appendChild(panelEl);

        toggleBtn = panelEl.querySelector(".__wg_toggle");
        statusEl = panelEl.querySelector(".__wg_status");
        logEl = panelEl.querySelector(".__wg_log");

        toggleBtn.addEventListener("click", () => {
            running = !running;
            statusEl.textContent = "status: " + (running ? "solving" : "idle");
            toggleBtn.textContent = running ? "■ Stop Auto" : "▶ Start Auto";
            toggleBtn.classList.toggle("__on", running);
            pushLog(running ? "auto started" : "auto paused", running ? "ok" : "");
            if (running) loop();
        });

        panelEl.querySelector(".__wg_min").addEventListener("click", () => panelEl.classList.add("__hidden"));

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
        pushLog("wayground panel ready. click Start Auto.", "ok");
        const obs = new MutationObserver(() => {
            ensureStyle();
            if (!document.getElementById("__wg_panel")) buildPanel();
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