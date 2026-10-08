(function () {
    // ─── stealth ──────────────────────────────────────────
    (function stealth() {
        try {
            Object.defineProperty(navigator, "webdriver", { get: () => undefined });
            Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
            Object.defineProperty(navigator, "language", { get: () => "en-US" });
            Object.defineProperty(navigator, "platform", { get: () => "Win32" });
            Object.defineProperty(navigator, "vendor", { get: () => "Google Inc." });
            Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
            Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
            Object.defineProperty(navigator, "maxTouchPoints", { get: () => 0 });

            Object.defineProperty(navigator, "plugins", {
                get: () => {
                    const arr = [
                        { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", length: 1 },
                        { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", length: 1 },
                        { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", length: 1 },
                        { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format", length: 1 },
                        { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "Portable Document Format", length: 1 }
                    ];
                    arr.item = (i) => arr[i];
                    arr.namedItem = (n) => arr.find(p => p.name === n);
                    arr.refresh = () => { };
                    return arr;
                }
            });

            Object.defineProperty(navigator, "mimeTypes", {
                get: () => {
                    const arr = [
                        { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
                        { type: "text/pdf", suffixes: "pdf", description: "Portable Document Format" }
                    ];
                    arr.item = (i) => arr[i];
                    arr.namedItem = (n) => arr.find(m => m.type === n);
                    return arr;
                }
            });

            if (!window.chrome) window.chrome = {};
            if (!window.chrome.runtime) window.chrome.runtime = {};
            if (!window.chrome.loadTimes) window.chrome.loadTimes = () => ({ requestTime: 0, startLoadTime: 0, commitLoadTime: 0, finishDocumentLoadTime: 0, finishLoadTime: 0, firstPaintTime: 0, firstPaintAfterLoadTime: 0, navigationType: "Other", wasFetchedViaSpdy: false, wasNpnNegotiated: false, npnNegotiatedProtocol: "unknown", wasAlternateProtocolAvailable: false, connectionInfo: "http/1.1" });
            if (!window.chrome.csi) window.chrome.csi = () => ({ startE: 0, onloadT: 0, pageT: 0, tran: 15 });
            if (!window.chrome.app) window.chrome.app = { isInstalled: false, InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" }, RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" } };

            const origQuery = navigator.permissions && navigator.permissions.query ? navigator.permissions.query.bind(navigator.permissions) : null;
            if (origQuery) {
                navigator.permissions.query = (params) =>
                    params.name === "notifications"
                        ? Promise.resolve({ state: Notification.permission, onchange: null })
                        : origQuery(params);
            }

            const patchGL = function (orig) {
                return function (param) {
                    if (param === 37445) return "Google Inc. (NVIDIA)";
                    if (param === 37446) return "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)";
                    return orig.apply(this, arguments);
                };
            };
            if (window.WebGLRenderingContext && WebGLRenderingContext.prototype.getParameter) {
                WebGLRenderingContext.prototype.getParameter = patchGL(WebGLRenderingContext.prototype.getParameter);
            }
            if (window.WebGL2RenderingContext && WebGL2RenderingContext.prototype.getParameter) {
                WebGL2RenderingContext.prototype.getParameter = patchGL(WebGL2RenderingContext.prototype.getParameter);
            }

            const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
            HTMLCanvasElement.prototype.toDataURL = function (...args) {
                try {
                    const ctx = this.getContext("2d");
                    if (ctx) {
                        const img = ctx.getImageData(0, 0, this.width, this.height);
                        for (let i = 0; i < img.data.length; i += 400) img.data[i] ^= 1;
                        ctx.putImageData(img, 0, 0);
                    }
                } catch (_) { }
                return origToDataURL.apply(this, args);
            };

            if (window.AudioBuffer) {
                const origGetChannelData = AudioBuffer.prototype.getChannelData;
                AudioBuffer.prototype.getChannelData = function (...args) {
                    const data = origGetChannelData.apply(this, args);
                    try { for (let i = 0; i < data.length; i += 1000) data[i] += (Math.random() - 0.5) * 1e-7; } catch (_) { }
                    return data;
                };
            }

            Object.defineProperty(navigator, "getBattery", {
                get: () => () => Promise.resolve({ charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1 })
            });
        } catch (_) { }
    })();

    if (window.__ixl_panel_injected__) return;
    window.__ixl_panel_injected__ = true;

    const API_BASE = "";

    let token = "";
    try {
        const m = location.search.match(/[?&]ixl_solver_token=([^&]+)/);
        if (m) { token = decodeURIComponent(m[1]); sessionStorage.setItem("__ixl_tok", token); }
        else { token = sessionStorage.getItem("__ixl_tok") || ""; }
    } catch (_) { }

    // ─── per-user prefs ────────────────────────────────────
    const PREFS_KEY = "__ixl_prefs";
    const defaultPrefs = { thinkSeconds: 5, maxWrong: 0 };
    function getPrefs() {
        try {
            const raw = localStorage.getItem(PREFS_KEY);
            if (!raw) return { ...defaultPrefs };
            return { ...defaultPrefs, ...JSON.parse(raw) };
        } catch (_) { return { ...defaultPrefs }; }
    }
    function savePrefs(p) {
        try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (_) { }
    }

    const css = `
    #__ixl_panel { position: fixed; bottom: 16px; right: 16px; width: 360px; background: rgba(18,22,34,0.97); color: #d8dde8; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; border: 1px solid rgba(120,140,200,0.35); border-radius: 10px; padding: 10px; z-index: 2147483647; backdrop-filter: blur(8px); box-shadow: 0 8px 32px rgba(0,0,0,0.5); user-select: none; }
    #__ixl_panel.__hidden { display: none !important; }
    #__ixl_panel .__ixl_header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    #__ixl_panel .__ixl_title { font-weight: 600; color: #8ab4ff; letter-spacing: 0.5px; }
    #__ixl_panel .__ixl_min { background: transparent; border: none; color: #889; cursor: pointer; font-size: 14px; padding: 0 4px; }
    #__ixl_panel .__ixl_toggle { width: 100%; background: linear-gradient(180deg,#2a6eff,#1d54d6); color: #fff; border: none; border-radius: 6px; padding: 9px 10px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; }
    #__ixl_panel .__ixl_toggle.__on { background: linear-gradient(180deg,#d64545,#a83232); }
    #__ixl_panel .__ixl_row { display: flex; gap: 8px; margin-top: 8px; }
    #__ixl_panel .__ixl_field { flex: 1; display: flex; flex-direction: column; gap: 4px; font-size: 10px; color: #889; }
    #__ixl_panel .__ixl_field input { background: #0c0f17; border: 1px solid #232a3a; color: #d8dde8; padding: 6px 8px; border-radius: 4px; font-family: inherit; font-size: 11px; outline: none; width: 100%; }
    #__ixl_panel .__ixl_field input:focus { border-color: #3a6fff; }
    #__ixl_panel .__ixl_status { margin-top: 8px; color: #aab; font-size: 11px; }
    #__ixl_panel .__ixl_log { margin-top: 6px; max-height: 160px; overflow-y: auto; font-size: 10px; color: #889; line-height: 1.5; }
    #__ixl_panel .__ixl_log div { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
    #__ixl_panel .__ixl_log .ok { color: #6d8; }
    #__ixl_panel .__ixl_log .err { color: #d67; }
    #__ixl_panel .__ixl_log .warn { color: #fc6; }
  `;

    let running = false, panelEl, statusEl, logEl, toggleBtn;
    let busy = false, lastAnsweredSig = "", wrongCount = 0;
    let currentPrefs = getPrefs();

    function ensureStyle() {
        if (document.getElementById("__ixl_panel_style")) return;
        const s = document.createElement("style");
        s.id = "__ixl_panel_style";
        s.textContent = css;
        document.documentElement.appendChild(s);
    }

    function buildPanel() {
        if (document.getElementById("__ixl_panel")) return;
        panelEl = document.createElement("div");
        panelEl.id = "__ixl_panel";
        panelEl.innerHTML = `
      <div class="__ixl_header">
        <span class="__ixl_title">notes</span>
        <button class="__ixl_min" title="Ctrl+M">–</button>
      </div>
      <button class="__ixl_toggle">▶ Start Auto</button>
      <div class="__ixl_row">
        <label class="__ixl_field">think delay (sec)<input type="number" id="__ixl_think" min="0" max="60" value="${currentPrefs.thinkSeconds}" /></label>
        <label class="__ixl_field">max wrong (0=∞)<input type="number" id="__ixl_maxwrong" min="0" max="999" value="${currentPrefs.maxWrong}" /></label>
      </div>
      <div class="__ixl_status">status: idle</div>
      <div class="__ixl_log"></div>
    `;
        document.documentElement.appendChild(panelEl);

        toggleBtn = panelEl.querySelector(".__ixl_toggle");
        statusEl = panelEl.querySelector(".__ixl_status");
        logEl = panelEl.querySelector(".__ixl_log");

        const thinkInput = panelEl.querySelector("#__ixl_think");
        const wrongInput = panelEl.querySelector("#__ixl_maxwrong");

        thinkInput.addEventListener("change", () => {
            const v = Math.max(0, Math.min(60, parseInt(thinkInput.value, 10) || 0));
            currentPrefs.thinkSeconds = v;
            thinkInput.value = v;
            savePrefs(currentPrefs);
            pushLog(`think delay = ${v}s`, "ok");
        });

        wrongInput.addEventListener("change", () => {
            const v = Math.max(0, Math.min(999, parseInt(wrongInput.value, 10) || 0));
            currentPrefs.maxWrong = v;
            wrongInput.value = v;
            savePrefs(currentPrefs);
            wrongCount = 0;
            pushLog(`max wrong = ${v === 0 ? "∞" : v}`, "ok");
        });

        toggleBtn.addEventListener("click", () => {
            running = !running;
            statusEl.textContent = "status: " + (running ? "solving" : "idle");
            toggleBtn.textContent = running ? "■ Stop Auto" : "▶ Start Auto";
            toggleBtn.classList.toggle("__on", running);
            pushLog(running ? "auto started" : "auto paused", running ? "ok" : "");
            if (running) { wrongCount = 0; loop(); }
        });

        panelEl.querySelector(".__ixl_min").addEventListener("click", () => panelEl.classList.add("__hidden"));
        window.addEventListener("keydown", (e) => {
            if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "m" || e.key === "M")) {
                e.preventDefault(); e.stopPropagation();
                panelEl.classList.toggle("__hidden");
            }
        }, true);
    }

    function startWatchdog() {
        const obs = new MutationObserver(() => { ensureStyle(); if (!document.getElementById("__ixl_panel")) buildPanel(); });
        obs.observe(document.documentElement, { childList: true, subtree: false });
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

    // ─── deep text extraction ─────────────────────────────
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

    // ─── universal element finders ────────────────────────
    function findAllInteractive() {
        const out = [];
        const seen = new Set();
        const selectors = [
            "button",
            "[role='button']",
            "[role='radio']",
            "[role='checkbox']",
            "input[type='text']",
            "input[type='number']",
            "input:not([type])",
            "textarea",
            "[class*='SelectableTile']",
            "[draggable='true']",
            "[class*='drag']",
            "[class*='Submit']",
            "[class*='submit']",
            "[aria-label]",
            "[data-testid]"
        ];
        for (const sel of selectors) {
            document.querySelectorAll(sel).forEach(el => {
                if (seen.has(el)) return;
                if (el.offsetParent === null) return;
                seen.add(el);
                out.push(el);
            });
        }
        return out;
    }

    function findByText(text, exact) {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
        const want = norm(text);
        return findAllInteractive().find(el => {
            const t = norm(el.innerText || el.textContent || "");
            if (exact) return t === want;
            return t.includes(want) || want.includes(t);
        });
    }

    function findSubmitButton() {
        let btn = Array.from(document.querySelectorAll("button")).find(b => {
            const t = (b.innerText || "").trim().toLowerCase();
            if (b.disabled) return false;
            if (b.offsetParent === null) return false;
            return /^submit$|^submit answer$|^check answer$|^check$|^continue$|^next$/.test(t);
        });
        if (btn) return btn;

        btn = findAllInteractive().find(b => {
            const t = (b.innerText || "").trim().toLowerCase();
            if (b.disabled) return false;
            return /^submit$|^submit answer$|^check answer$|^check$|^continue$|^next$/.test(t);
        });
        if (btn) return btn;

        const byClass = Array.from(document.querySelectorAll('[class*="submit" i], [class*="Submit" i]')).find(b => b.offsetParent !== null);
        if (byClass) return byClass;

        return null;
    }

    function findInput() {
        const candidates = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea'))
            .filter(i => !i.disabled && i.offsetParent !== null);
        if (candidates.length) return candidates[0];
        const ce = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(e => e.offsetParent !== null);
        return ce[0] || null;
    }

    // ─── real mouse click sequence ────────────────────────
    function clickViaMouse(el) {
        if (!el) return false;
        try { el.scrollIntoView({ block: "center", behavior: "instant" }); } catch (_) { }
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const target = document.elementFromPoint(x, y) || el;

        const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: 0, pointerType: "mouse", pointerId: 1, isPrimary: true };
        try {
            target.dispatchEvent(new PointerEvent("pointerover", { ...opts, buttons: 0 }));
            target.dispatchEvent(new MouseEvent("mouseover", { ...opts, buttons: 0 }));
            target.dispatchEvent(new PointerEvent("pointermove", { ...opts, buttons: 0 }));
            target.dispatchEvent(new MouseEvent("mousemove", { ...opts, buttons: 0 }));
            target.dispatchEvent(new PointerEvent("pointerdown", { ...opts, buttons: 1 }));
            target.dispatchEvent(new MouseEvent("mousedown", { ...opts, buttons: 1 }));
            target.dispatchEvent(new PointerEvent("pointerup", { ...opts, buttons: 0 }));
            target.dispatchEvent(new MouseEvent("mouseup", { ...opts, buttons: 0 }));
            target.dispatchEvent(new MouseEvent("click", { ...opts, buttons: 0 }));
        } catch (_) { }

        try { el.click(); } catch (_) { }
        return true;
    }

    // ─── parser ────────────────────────────────────────────
    function parseQuestion() {
        const tiles = Array.from(document.querySelectorAll('.SelectableTile[role="radio"], [class*="SelectableTile"][role="radio"], [role="radio"]'))
            .filter(e => e.offsetParent !== null);
        const options = tiles.map(t => extractText(t)).filter(Boolean);

        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea'))
            .filter(i => !i.disabled && i.offsetParent !== null)
            .map(i => ({ placeholder: i.placeholder || "", ariaLabel: i.getAttribute("aria-label") || "" }));

        const draggables = Array.from(document.querySelectorAll('[draggable="true"], [class*="draggable"]'))
            .filter(e => e.offsetParent !== null)
            .map(e => extractText(e)).filter(Boolean);

        const dropZones = Array.from(document.querySelectorAll('[class*="drop-zone"], [class*="dropzone"], [data-drop-target], [class*="target"]'))
            .filter(e => e.offsetParent !== null)
            .map(e => extractText(e));

        const canvases = document.querySelectorAll('canvas');

        let stem = "";
        for (const s of ['[data-testid="question-container"]', '[class*="QuestionContainer"]', '[class*="question-container"]', '[class*="question-text"]', 'main']) {
            for (const c of Array.from(document.querySelectorAll(s)).filter(e => e.offsetParent !== null)) {
                const t = extractText(c);
                if (t.length > stem.length && t.length < 3000) stem = t;
            }
            if (stem.length > 10) break;
        }
        if (!stem || stem.length < 10) {
            for (const c of Array.from(document.querySelectorAll("p, h1, h2, h3, label, span"))
                .filter(e => e.offsetParent !== null && e.children.length < 5)) {
                const t = extractText(c);
                if (t.length < 8 || t.length > 400) continue;
                if (tiles.some(tile => c.contains(tile) || tile.contains(c))) continue;
                if (/\?|compare|evaluate|solve|which|what|how many|identify|select|choose|fill in|complete the/i.test(t)) { stem = t; break; }
            }
        }

        let type = "unknown";
        if (draggables.length > 0 && dropZones.length > 0) type = "drag_drop";
        else if (options.length >= 2) type = "multiple_choice";
        else if (inputs.length > 0) type = "fill_in";
        else if (canvases.length > 0) type = "visual";

        return { type, stem: stem.slice(0, 2000), options, inputs, draggables, dropZones, hasCanvas: canvases.length > 0 };
    }

    // ─── apply answer ──────────────────────────────────────
    function applyMultipleChoice(question, answer) {
        const idx = answer.answer_index;
        if (typeof idx !== "number") return false;
        const tiles = Array.from(document.querySelectorAll('.SelectableTile[role="radio"], [class*="SelectableTile"][role="radio"], [role="radio"]'))
            .filter(e => e.offsetParent !== null);
        const tile = tiles[idx];
        if (!tile) {
            const target = question.options && question.options[idx];
            if (target) {
                const found = findByText(target, false);
                if (found) return clickViaMouse(found);
            }
            return false;
        }
        return clickViaMouse(tile);
    }

    function applyFillIn(answer) {
        const value = String(answer.value ?? "");
        const input = findInput();
        if (!input) return false;
        try { input.scrollIntoView({ block: "center" }); } catch (_) { }
        input.focus();
        try { input.click(); } catch (_) { }
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", keyCode: 13 }));
        input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", keyCode: 13 }));
        try { input.blur(); } catch (_) { }
        return true;
    }

    async function applyDragDrop(question, answer) {
        const placements = answer.placements || [];
        if (!placements.length) return false;
        for (const p of placements) {
            const tile = findByText(p.tile, true) || findByText(p.tile, false);
            const zone = findByText(p.target, true) || findByText(p.target, false);
            if (!tile || !zone) continue;

            const tr = tile.getBoundingClientRect();
            const zr = zone.getBoundingClientRect();
            const tx = tr.left + tr.width / 2, ty = tr.top + tr.height / 2;
            const zx = zr.left + zr.width / 2, zy = zr.top + zr.height / 2;

            tile.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: tx, clientY: ty, pointerId: 1, buttons: 1 }));
            tile.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: tx, clientY: ty, buttons: 1 }));

            const steps = 12;
            for (let i = 1; i <= steps; i++) {
                const mx = tx + (zx - tx) * (i / steps);
                const my = ty + (zy - ty) * (i / steps);
                tile.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: mx, clientY: my, pointerId: 1, buttons: 1 }));
                zone.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: mx, clientY: my, pointerId: 1, buttons: 1 }));
                await new Promise(r => setTimeout(r, 25));
            }

            zone.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: zx, clientY: zy, pointerId: 1 }));
            zone.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: zx, clientY: zy }));
            tile.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: zx, clientY: zy, pointerId: 1 }));
            tile.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: zx, clientY: zy }));
            tile.dispatchEvent(new MouseEvent("drop", { bubbles: true, clientX: zx, clientY: zy }));
            zone.dispatchEvent(new MouseEvent("drop", { bubbles: true, clientX: zx, clientY: zy }));

            await new Promise(r => setTimeout(r, 400));
        }
        return true;
    }

    function clickSubmit() {
        const btn = findSubmitButton();
        if (!btn) { pushLog("✗ submit button not found", "err"); return false; }
        pushLog(`submitting via "${(btn.innerText || "").trim().slice(0, 20)}"`, "ok");
        return clickViaMouse(btn);
    }

    async function askBackend(question) {
        const controller = new AbortController();
        const to = setTimeout(() => controller.abort(), 25000);
        try {
            const res = await fetch(`${API_BASE}/api/solve`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-IXL-Token": token },
                body: JSON.stringify(question),
                signal: controller.signal
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || `http ${res.status}`);
            }
            return await res.json();
        } finally { clearTimeout(to); }
    }

    function dismissFeedback() {
        const el = findSubmitButton() || findByText("continue", false) || findByText("got it", false) || findByText("next", false);
        if (el) clickViaMouse(el);
    }

    function thinkDelay() {
        const sec = Math.max(0, currentPrefs.thinkSeconds || 0);
        return new Promise(r => setTimeout(r, sec * 1000));
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
                setTimeout(loop, 900);
                return;
            }

            const sig = q.stem + "|" + (q.options || []).join("|");
            if (sig === lastAnsweredSig) {
                setStatus("waiting for new question");
                busy = false;
                setTimeout(loop, 1200);
                return;
            }

            setStatus(`thinking (${q.type})`);
            pushLog(`q[${q.type}] ${q.stem.slice(0, 50)}`);

            await thinkDelay();

            let answer;
            try {
                answer = await askBackend(q);
            } catch (err) {
                pushLog("✗ " + err.message, "err");
                setStatus("error");
                busy = false;
                setTimeout(loop, 2000);
                return;
            }

            // ─── confidence + flags display ─────────────────
            const conf = typeof answer.confidence === "number" ? answer.confidence : null;
            const flags = Array.isArray(answer.flags) ? answer.flags : [];
            const confStr = conf !== null ? ` conf=${conf.toFixed(2)}` : "";
            const flagStr = flags.length ? " ⚠ " + flags.join(", ") : "";
            const cls = conf !== null && conf < 0.5 ? "err" : conf !== null && conf < 0.75 ? "warn" : "";
            pushLog(`ai → ${JSON.stringify(answer).slice(0, 70)}${confStr}${flagStr}`, cls);

            let ok = false;
            if (answer.type === "multiple_choice") ok = applyMultipleChoice(q, answer);
            else if (answer.type === "fill_in") ok = applyFillIn(answer);
            else if (answer.type === "drag_drop") ok = await applyDragDrop(q, answer);
            else if (answer.type === "visual") {
                if (typeof answer.answer_index === "number" && q.options.length > 1) ok = applyMultipleChoice(q, answer);
                else if (answer.value !== undefined) ok = applyFillIn(answer);
            }

            if (!ok) {
                pushLog("✗ could not apply", "err");
                busy = false;
                setTimeout(loop, 1200);
                return;
            }

            await new Promise(r => setTimeout(r, 800));
            clickSubmit();
            lastAnsweredSig = sig;

            await new Promise(r => setTimeout(r, 2500));
            const text = document.body.innerText || "";
            if (/sorry,\s*incorrect/i.test(text) || /the correct answer is/i.test(text)) {
                wrongCount++;
                pushLog(`✗ wrong (${wrongCount}/${currentPrefs.maxWrong || "∞"})`, "err");
                lastAnsweredSig = "";
                dismissFeedback();

                if (currentPrefs.maxWrong > 0 && wrongCount >= currentPrefs.maxWrong) {
                    running = false;
                    setStatus(`stopped: hit max wrong (${wrongCount})`);
                    toggleBtn.textContent = "▶ Start Auto";
                    toggleBtn.classList.remove("__on");
                    pushLog(`⏹ stopped after ${wrongCount} wrong answers`, "err");
                    busy = false;
                    return;
                }
            } else if (/(correct!|nice work|good job|great job|well done)/i.test(text)) {
                pushLog("✓ correct", "ok");
                setStatus("correct");
            } else {
                pushLog("? feedback unclear");
            }

            await new Promise(r => setTimeout(r, 900));
        } catch (err) {
            pushLog("loop error: " + err.message, "err");
        } finally {
            busy = false;
            if (running) setTimeout(loop, 500);
        }
    }

    function boot() {
        ensureStyle();
        buildPanel();
        startWatchdog();
        pushLog("panel ready. click Start Auto.", "ok");
        pushLog(`prefs: think ${currentPrefs.thinkSeconds}s, max wrong ${currentPrefs.maxWrong || "∞"}`);
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