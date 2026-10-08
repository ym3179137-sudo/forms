(function () {
    if (window.__blooket_injected__) return;
    window.__blooket_injected__ = true;

    const API_BASE = "";
    let token = "";
    try {
        const m = location.search.match(/[?&]ixl_solver_token=([^&]+)/);
        if (m) { token = decodeURIComponent(m[1]); sessionStorage.setItem("__ixl_tok", token); }
        else { token = sessionStorage.getItem("__ixl_tok") || ""; }
    } catch (_) { }

    const css = `
    #__bk_panel { position: fixed; top: 16px; right: 16px; width: 320px; background: rgba(18,22,34,0.97); color: #d8dde8; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; border: 1px solid rgba(120,140,200,0.35); border-radius: 10px; padding: 10px; z-index: 2147483647; box-shadow: 0 8px 32px rgba(0,0,0,0.5); user-select: none; }
    #__bk_panel.__hidden { display: none !important; }
    #__bk_panel .__bk_header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    #__bk_panel .__bk_title { font-weight: 600; color: #9d6cff; letter-spacing: 0.5px; }
    #__bk_panel .__bk_min { background: transparent; border: none; color: #889; cursor: pointer; font-size: 14px; padding: 0 4px; }
    #__bk_panel .__bk_toggle { width: 100%; background: linear-gradient(180deg,#9d6cff,#6f42d4); color: #fff; border: none; border-radius: 6px; padding: 9px 10px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; }
    #__bk_panel .__bk_toggle.__on { background: linear-gradient(180deg,#d64545,#a83232); }
    #__bk_panel .__bk_status { margin-top: 8px; color: #aab; font-size: 11px; }
    #__bk_panel .__bk_log { margin-top: 6px; max-height: 180px; overflow-y: auto; font-size: 10px; color: #889; line-height: 1.5; }
    #__bk_panel .__bk_log div { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
    #__bk_panel .__bk_log .ok { color: #6d8; }
    #__bk_panel .__bk_log .err { color: #d67; }
  `;

    let running = false;
    let panelEl = null, statusEl = null, logEl = null, toggleBtn = null;
    let busy = false;
    let lastAnsweredSig = "";

    function ensureStyle() {
        if (document.getElementById("__bk_style")) return;
        const s = document.createElement("style");
        s.id = "__bk_style";
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

    // ─── read the current blooket question ─────────────────
    function parseQuestion() {
        // blooket question text lives in specific containers depending on game mode
        const stemEl =
            document.querySelector('[class*="questionText"]') ||
            document.querySelector('[class*="QuestionText"]') ||
            document.querySelector('h2[class*="Question"]') ||
            document.querySelector('[class*="question__"]');

        let stem = stemEl ? (stemEl.innerText || "").trim() : "";
        if (!stem) {
            const candidates = Array.from(document.querySelectorAll("h1, h2, h3, p, div"))
                .filter(e => e.offsetParent !== null && e.children.length < 5);
            let longest = "";
            for (const c of candidates) {
                const t = (c.innerText || "").trim();
                if (t.length > longest.length && t.length < 500) longest = t;
            }
            stem = longest;
        }

        // blooket answer buttons — usually <button> children of a specific container
        const optionEls = Array.from(document.querySelectorAll(
            '[class*="answerContainer"] button, [class*="answer"] button, [class*="answerButton"], [class*="Answer"] button, button[class*="answer"]'
        )).filter(e => e.offsetParent !== null);

        const options = optionEls.map(e => (e.innerText || "").trim()).filter(Boolean);

        let type = options.length >= 2 ? "multiple_choice" : "unknown";
        return { type, stem: stem.slice(0, 1500), options };
    }

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
        if (answer.type !== "multiple_choice" || typeof answer.answer_index !== "number") return false;
        const optionEls = Array.from(document.querySelectorAll(
            '[class*="answerContainer"] button, [class*="answer"] button, [class*="answerButton"], [class*="Answer"] button, button[class*="answer"]'
        )).filter(e => e.offsetParent !== null);
        const el = optionEls[answer.answer_index];
        if (!el) return false;
        return clickElement(el);
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

    // blooket answers should be fast but not instant — otherwise flagged
    function humanDelay() {
        return new Promise(r => setTimeout(r, 400 + Math.random() * 800));
    }

    async function loop() {
        if (!running || busy) return;
        busy = true;
        try {
            setStatus("reading question");
            const q = parseQuestion();

            if (!q.stem || q.stem.length < 5 || q.type !== "multiple_choice") {
                setStatus("no question yet");
                busy = false;
                setTimeout(loop, 500);
                return;
            }

            const sig = q.stem + "|" + q.options.join("|");
            if (sig === lastAnsweredSig) {
                setStatus("waiting for next");
                busy = false;
                setTimeout(loop, 700);
                return;
            }

            setStatus("thinking");
            pushLog(`q ${q.stem.slice(0, 50)}`);

            let answer;
            try {
                answer = await askBackend(q);
            } catch (err) {
                pushLog("✗ " + err.message, "err");
                busy = false;
                setTimeout(loop, 1200);
                return;
            }

            pushLog(`ai → idx ${answer.answer_index}`, "ok");

            await humanDelay();

            const ok = applyAnswer(q, answer);
            if (ok) {
                lastAnsweredSig = sig;
                pushLog("✓ clicked", "ok");
            } else {
                pushLog("✗ could not click", "err");
            }

            busy = false;
            if (running) setTimeout(loop, 400);
        } catch (err) {
            pushLog("loop error: " + err.message, "err");
            busy = false;
            if (running) setTimeout(loop, 700);
        }
    }

    function buildPanel() {
        if (document.getElementById("__bk_panel")) return;
        panelEl = document.createElement("div");
        panelEl.id = "__bk_panel";
        panelEl.innerHTML = `
      <div class="__bk_header">
        <span class="__bk_title">blooket-solver</span>
        <button class="__bk_min" title="Ctrl+M">–</button>
      </div>
      <button class="__bk_toggle">▶ Start Auto</button>
      <div class="__bk_status">status: idle</div>
      <div class="__bk_log"></div>
    `;
        document.documentElement.appendChild(panelEl);

        toggleBtn = panelEl.querySelector(".__bk_toggle");
        statusEl = panelEl.querySelector(".__bk_status");
        logEl = panelEl.querySelector(".__bk_log");

        toggleBtn.addEventListener("click", () => {
            running = !running;
            statusEl.textContent = "status: " + (running ? "solving" : "idle");
            toggleBtn.textContent = running ? "■ Stop Auto" : "▶ Start Auto";
            toggleBtn.classList.toggle("__on", running);
            pushLog(running ? "auto started" : "auto paused", running ? "ok" : "");
            if (running) loop();
        });

        panelEl.querySelector(".__bk_min").addEventListener("click", () => panelEl.classList.add("__hidden"));

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
        pushLog("blooket panel ready. click Start Auto.", "ok");
        const obs = new MutationObserver(() => {
            ensureStyle();
            if (!document.getElementById("__bk_panel")) buildPanel();
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