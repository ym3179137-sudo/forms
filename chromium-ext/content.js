(function () {
    if (window.__ixl_panel_injected__) return;
    window.__ixl_panel_injected__ = true;

    // ─── style ──────────────────────────────────────────────
    const css = `
    #__ixl_panel { position: fixed; bottom: 16px; right: 16px; width: 280px; background: rgba(18,22,34,0.96); color: #d8dde8; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; border: 1px solid rgba(120,140,200,0.35); border-radius: 10px; padding: 10px; z-index: 2147483647; backdrop-filter: blur(8px); box-shadow: 0 8px 32px rgba(0,0,0,0.5); user-select: none; }
    #__ixl_panel.__hidden { display: none !important; }
    #__ixl_panel .__ixl_header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    #__ixl_panel .__ixl_title { font-weight: 600; color: #8ab4ff; letter-spacing: 0.5px; }
    #__ixl_panel .__ixl_min { background: transparent; border: none; color: #889; cursor: pointer; font-size: 14px; padding: 0 4px; line-height: 1; }
    #__ixl_panel .__ixl_toggle { width: 100%; background: linear-gradient(180deg, #2a6eff, #1d54d6); color: #fff; border: none; border-radius: 6px; padding: 9px 10px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; }
    #__ixl_panel .__ixl_toggle.__on { background: linear-gradient(180deg, #d64545, #a83232); }
    #__ixl_panel .__ixl_status { margin-top: 8px; color: #aab; font-size: 11px; }
    #__ixl_panel .__ixl_log { margin-top: 6px; max-height: 140px; overflow-y: auto; font-size: 10px; color: #889; line-height: 1.5; }
    #__ixl_panel .__ixl_log div { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
    #__ixl_panel .__ixl_log .ok { color: #6d8; }
    #__ixl_panel .__ixl_log .err { color: #d67; }
  `;
    const style = document.createElement("style");
    style.id = "__ixl_panel_style";
    style.textContent = css;
    document.documentElement.appendChild(style);

    // ─── config ─────────────────────────────────────────────
    const API_BASE = "https://ixl-solver-production.up.railway.app";
    let token = "";
    try {
        const m = location.search.match(/[?&]ixl_solver_token=([^&]+)/);
        if (m) {
            token = decodeURIComponent(m[1]);
            sessionStorage.setItem("__ixl_tok", token);
        } else {
            token = sessionStorage.getItem("__ixl_tok") || "";
        }
    } catch (_) { }

    // ─── state ──────────────────────────────────────────────
    let running = false;
    let panelEl = null;
    let statusEl = null;
    let logEl = null;
    let toggleBtn = null;
    let busy = false;

    // ─── panel ──────────────────────────────────────────────
    function buildPanel() {
        if (panelEl) return;
        panelEl = document.createElement("div");
        panelEl.id = "__ixl_panel";
        panelEl.innerHTML = `
      <div class="__ixl_header">
        <span class="__ixl_title">notes</span>
        <button class="__ixl_min" title="Ctrl+M to hide">–</button>
      </div>
      <button class="__ixl_toggle">▶ Start Auto</button>
      <div class="__ixl_status">status: idle</div>
      <div class="__ixl_log"></div>
    `;
        document.documentElement.appendChild(panelEl);

        toggleBtn = panelEl.querySelector(".__ixl_toggle");
        statusEl = panelEl.querySelector(".__ixl_status");
        logEl = panelEl.querySelector(".__ixl_log");

        toggleBtn.addEventListener("click", () => {
            running = !running;
            statusEl.textContent = "status: " + (running ? "solving" : "idle");
            toggleBtn.textContent = running ? "■ Stop Auto" : "▶ Start Auto";
            toggleBtn.classList.toggle("__on", running);
            pushLog(running ? "auto started" : "auto paused", running ? "ok" : "");
            if (running) loop();
        });

        panelEl.querySelector(".__ixl_min").addEventListener("click", () => {
            panelEl.classList.add("__hidden");
        });

        window.addEventListener("keydown", (e) => {
            if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "m" || e.key === "M")) {
                e.preventDefault(); e.stopPropagation();
                panelEl.classList.toggle("__hidden");
            }
        }, true);
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

    // ─── parser ─────────────────────────────────────────────
    function extractText(el) {
        if (!el) return "";
        let out = "";
        function walk(node) {
            if (node.nodeType === 3) { out += node.nodeValue; return; }
            if (node.nodeType !== 1) return;
            const tag = node.tagName.toLowerCase();
            if (tag === "sup") { out += "^"; node.childNodes.forEach(walk); out += " "; return; }
            if (tag === "sub") { out += "_"; node.childNodes.forEach(walk); out += " "; return; }
            if (tag === "br") { out += " "; return; }
            node.childNodes.forEach(walk);
        }
        walk(el);
        return out.replace(/\s+/g, " ").trim();
    }

    function parseQuestion() {
        const tiles = Array.from(document.querySelectorAll(
            '.SelectableTile[role="radio"], [class*="SelectableTile"][role="radio"], [role="radio"]'
        )).filter(e => e.offsetParent !== null);
        const options = tiles.map(t => extractText(t)).filter(Boolean);

        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])'))
            .filter(i => !i.disabled && i.offsetParent !== null)
            .map(i => ({ placeholder: i.placeholder || "", ariaLabel: i.getAttribute("aria-label") || "" }));

        let stem = "";
        const knownSel = ['[data-testid="question-container"]', '[class*="QuestionContainer"]', '[class*="question-container"]', '[class*="question-text"]', 'main'];
        for (const s of knownSel) {
            for (const c of Array.from(document.querySelectorAll(s)).filter(e => e.offsetParent !== null)) {
                const t = extractText(c);
                if (t.length > stem.length && t.length < 3000) stem = t;
            }
            if (stem.length > 10) break;
        }
        if (!stem || stem.length < 10) {
            for (const c of Array.from(document.querySelectorAll("p, h1, h2, h3, label, span")).filter(e => e.offsetParent !== null && e.children.length < 5)) {
                const t = extractText(c);
                if (t.length < 8 || t.length > 400) continue;
                if (tiles.some(tile => c.contains(tile) || tile.contains(c))) continue;
                if (/\?|compare|evaluate|solve|which|what|how many|identify|select|choose|fill in|complete the/i.test(t)) { stem = t; break; }
            }
        }

        let type = "unknown";
        if (options.length >= 2) type = "multiple_choice";
        else if (inputs.length > 0) type = "fill_in";

        return { type, stem: stem.slice(0, 2000), options, inputs };
    }

    // ─── input ──────────────────────────────────────────────
    function clickAt(x, y) {
        const el = document.elementFromPoint(x, y);
        if (!el) return false;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
        el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, buttons: 1 }));
        el.dispatchEvent(new MouseEvent("mousedown", { ...opts, buttons: 1 }));
        el.dispatchEvent(new PointerEvent("pointerup", opts));
        el.dispatchEvent(new MouseEvent("mouseup", opts));
        el.dispatchEvent(new MouseEvent("click", opts));
        return true;
    }

    function applyMultipleChoice(question, answer) {
        const idx = answer.answer_index;
        if (typeof idx !== "number") return false;
        const tiles = Array.from(document.querySelectorAll('.SelectableTile[role="radio"], [class*="SelectableTile"][role="radio"], [role="radio"]')).filter(e => e.offsetParent !== null);
        const tile = tiles[idx];
        if (!tile) return false;
        try { tile.click(); } catch (_) { }
        const r = tile.getBoundingClientRect();
        clickAt(r.left + r.width / 2, r.top + r.height / 2);
        return true;
    }

    function applyFillIn(answer) {
        const value = String(answer.value ?? "");
        const input = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])')).find(i => !i.disabled && i.offsetParent !== null);
        if (!input) return false;
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.blur();
        return true;
    }

    function clickSubmit() {
        const btns = Array.from(document.querySelectorAll("button"));
        const sub = btns.find(b => /^submit$|^submit answer$|^check answer$/i.test((b.innerText || "").trim()) && !b.disabled);
        if (sub) { sub.click(); return true; }
        return false;
    }

    // ─── backend ────────────────────────────────────────────
    async function askBackend(question) {
        const res = await fetch(`${API_BASE}/api/solve`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-IXL-Token": token },
            body: JSON.stringify(question)
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `http ${res.status}`);
        }
        return await res.json();
    }

    function captureSignature() {
        const tiles = Array.from(document.querySelectorAll('[class*="SelectableTile"][role="radio"]'));
        return tiles.map(t => (t.innerText || "").trim()).join("|");
    }

    function dismissFeedback() {
        const btns = Array.from(document.querySelectorAll("button"));
        const m = btns.find(b => /^(got it|continue|next|okay|ok)$/i.test((b.innerText || "").trim()) && !b.disabled);
        if (m) m.click();
    }

    // ─── loop ───────────────────────────────────────────────
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

            setStatus(`thinking (${q.type})`);
            pushLog(`q[${q.type}] ${q.stem.slice(0, 60)}`);

            let answer;
            try {
                answer = await askBackend(q);
            } catch (err) {
                pushLog("✗ " + err.message, "err");
                setStatus("error");
                busy = false;
                setTimeout(loop, 1500);
                return;
            }

            pushLog("ai → " + JSON.stringify(answer).slice(0, 80));

            let ok = false;
            if (answer.type === "multiple_choice") ok = applyMultipleChoice(q, answer);
            else if (answer.type === "fill_in") ok = applyFillIn(answer);

            if (!ok) {
                pushLog("✗ could not apply", "err");
                busy = false;
                setTimeout(loop, 1200);
                return;
            }

            await new Promise(r => setTimeout(r, 700));
            clickSubmit();

            await new Promise(r => setTimeout(r, 2500));
            // simple feedback via page text
            const text = document.body.innerText || "";
            if (/sorry,\s*incorrect/i.test(text) || /the correct answer is/i.test(text)) {
                pushLog("✗ wrong", "err");
                dismissFeedback();
            } else if (/(correct!|nice work|good job|great job|well done)/i.test(text)) {
                pushLog("✓ correct", "ok");
                setStatus("correct");
            } else {
                pushLog("? feedback unknown");
            }

            await new Promise(r => setTimeout(r, 800));
        } catch (err) {
            pushLog("loop error: " + err.message, "err");
        } finally {
            busy = false;
            if (running) setTimeout(loop, 400);
        }
    }

    // ─── boot ───────────────────────────────────────────────
    function boot() {
        buildPanel();
        pushLog("panel ready. click Start Auto.", "ok");
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
})();