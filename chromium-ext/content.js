(function () {
    // ─── anti-detect + stealth patches (run before anything) ──
    (function stealth() {
        try {
            // webdriver
            Object.defineProperty(navigator, "webdriver", { get: () => undefined });

            // languages + platform
            Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
            Object.defineProperty(navigator, "language", { get: () => "en-US" });
            Object.defineProperty(navigator, "platform", { get: () => "Win32" });
            Object.defineProperty(navigator, "vendor", { get: () => "Google Inc." });
            Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
            Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
            Object.defineProperty(navigator, "maxTouchPoints", { get: () => 0 });

            // plugins (real Chrome has these)
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

            // mimeTypes
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

            // chrome object with all expected props
            if (!window.chrome) window.chrome = {};
            if (!window.chrome.runtime) window.chrome.runtime = {};
            if (!window.chrome.loadTimes) window.chrome.loadTimes = () => ({
                requestTime: 0, startLoadTime: 0, commitLoadTime: 0,
                finishDocumentLoadTime: 0, finishLoadTime: 0, firstPaintTime: 0,
                firstPaintAfterLoadTime: 0, navigationType: "Other",
                wasFetchedViaSpdy: false, wasNpnNegotiated: false,
                npnNegotiatedProtocol: "unknown", wasAlternateProtocolAvailable: false,
                connectionInfo: "http/1.1"
            });
            if (!window.chrome.csi) window.chrome.csi = () => ({ startE: 0, onloadT: 0, pageT: 0, tran: 15 });
            if (!window.chrome.app) window.chrome.app = {
                isInstalled: false,
                InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
                RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" }
            };

            // permissions query — spoof notification state
            const origQuery = navigator.permissions?.query?.bind(navigator.permissions);
            if (origQuery) {
                navigator.permissions.query = (params) =>
                    params.name === "notifications"
                        ? Promise.resolve({ state: Notification.permission, onchange: null })
                        : origQuery(params);
            }

            // WebGL vendor/renderer spoof (hide SwiftShader)
            const patchGL = function (orig) {
                return function (param) {
                    if (param === 37445) return "Google Inc. (NVIDIA)";
                    if (param === 37446) return "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)";
                    return orig.apply(this, arguments);
                };
            };
            if (window.WebGLRenderingContext) {
                const p = WebGLRenderingContext.prototype;
                if (p.getParameter) p.getParameter = patchGL(p.getParameter);
            }
            if (window.WebGL2RenderingContext) {
                const p2 = WebGL2RenderingContext.prototype;
                if (p2.getParameter) p2.getParameter = patchGL(p2.getParameter);
            }

            // canvas noise (breaks canvas fingerprint)
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
            const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
            CanvasRenderingContext2D.prototype.getImageData = function (...args) {
                const img = origGetImageData.apply(this, args);
                try { for (let i = 0; i < img.data.length; i += 400) img.data[i] ^= 1; } catch (_) { }
                return img;
            };

            // audio fingerprint noise
            if (window.AudioBuffer) {
                const origGetChannelData = AudioBuffer.prototype.getChannelData;
                AudioBuffer.prototype.getChannelData = function (...args) {
                    const data = origGetChannelData.apply(this, args);
                    try { for (let i = 0; i < data.length; i += 1000) data[i] += (Math.random() - 0.5) * 1e-7; } catch (_) { }
                    return data;
                };
            }
            if (window.AnalyserNode) {
                const origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData;
                AnalyserNode.prototype.getFloatFrequencyData = function (arr) {
                    origGetFloatFreq.call(this, arr);
                    try { for (let i = 0; i < arr.length; i += 100) arr[i] += (Math.random() - 0.5) * 1e-3; } catch (_) { }
                };
            }

            // battery api
            Object.defineProperty(navigator, "getBattery", {
                get: () => () => Promise.resolve({
                    charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1
                })
            });

            // notification permission state
            Object.defineProperty(Notification, "permission", { get: () => "default" });

            // hide automation flags
            if (window.navigator.connection) {
                Object.defineProperty(navigator.connection, "rtt", { get: () => 50 });
                Object.defineProperty(navigator.connection, "downlink", { get: () => 10 });
                Object.defineProperty(navigator.connection, "effectiveType", { get: () => "4g" });
            }

            // timezone + date
            const origResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
            Intl.DateTimeFormat.prototype.resolvedOptions = function () {
                const opts = origResolved.call(this);
                opts.timeZone = "America/New_York";
                return opts;
            };

            // iframe contentWindow.navigator — steal parent's (already patched) references
            try {
                const origIframeNav = HTMLIFrameElement.prototype.__lookupGetter__("contentWindow");
                if (origIframeNav) {
                    Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
                        get() { return origIframeNav.call(this); }
                    });
                }
            } catch (_) { }

        } catch (e) { /* silent */ }
    })();

    // ─── panel + parser ────────────────────────────────────────
    if (window.__ixl_panel_injected__) return;
    window.__ixl_panel_injected__ = true;
    // the URL here is a marker the Playwright route interceptor matches on
    // it never leaves the browser — Playwright forwards it to the real backend
    const API_BASE = "https://ixl-api.local";
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

    const css = `
    #__ixl_panel { position: fixed; bottom: 16px; right: 16px; width: 300px; background: rgba(18,22,34,0.97); color: #d8dde8; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; border: 1px solid rgba(120,140,200,0.35); border-radius: 10px; padding: 10px; z-index: 2147483647; backdrop-filter: blur(8px); box-shadow: 0 8px 32px rgba(0,0,0,0.5); user-select: none; }
    #__ixl_panel.__hidden { display: none !important; }
    #__ixl_panel .__ixl_header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    #__ixl_panel .__ixl_title { font-weight: 600; color: #8ab4ff; letter-spacing: 0.5px; }
    #__ixl_panel .__ixl_min { background: transparent; border: none; color: #889; cursor: pointer; font-size: 14px; padding: 0 4px; }
    #__ixl_panel .__ixl_toggle { width: 100%; background: linear-gradient(180deg,#2a6eff,#1d54d6); color: #fff; border: none; border-radius: 6px; padding: 9px 10px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; }
    #__ixl_panel .__ixl_toggle.__on { background: linear-gradient(180deg,#d64545,#a83232); }
    #__ixl_panel .__ixl_status { margin-top: 8px; color: #aab; font-size: 11px; }
    #__ixl_panel .__ixl_log { margin-top: 6px; max-height: 160px; overflow-y: auto; font-size: 10px; color: #889; line-height: 1.5; }
    #__ixl_panel .__ixl_log div { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
    #__ixl_panel .__ixl_log .ok { color: #6d8; }
    #__ixl_panel .__ixl_log .err { color: #d67; }
  `;

    let running = false;
    let panelEl = null;
    let statusEl = null;
    let logEl = null;
    let toggleBtn = null;
    let busy = false;
    let lastAnsweredSig = "";

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

    function startWatchdog() {
        const obs = new MutationObserver(() => {
            ensureStyle();
            if (!document.getElementById("__ixl_panel")) buildPanel();
        });
        obs.observe(document.documentElement, { childList: true, subtree: false });
    }

    function pushLog(text, cls) {
        if (!logEl) return;
        const d = document.createElement("div");
        if (cls) d.className = cls;
        d.textContent = text;
        logEl.appendChild(d);
        logEl.scrollTop = logEl.scrollHeight;
        while (logEl.children.length > 25) logEl.removeChild(logEl.firstChild);
    }

    function setStatus(s) { if (statusEl) statusEl.textContent = "status: " + s; }

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
        const tiles = Array.from(document.querySelectorAll('.SelectableTile[role="radio"], [class*="SelectableTile"][role="radio"], [role="radio"]'))
            .filter(e => e.offsetParent !== null);
        const options = tiles.map(t => extractText(t)).filter(Boolean);

        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])'))
            .filter(i => !i.disabled && i.offsetParent !== null)
            .map(i => ({ placeholder: i.placeholder || "", ariaLabel: i.getAttribute("aria-label") || "" }));

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
        if (options.length >= 2) type = "multiple_choice";
        else if (inputs.length > 0) type = "fill_in";

        return { type, stem: stem.slice(0, 2000), options, inputs };
    }

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
        const tiles = Array.from(document.querySelectorAll('.SelectableTile[role="radio"], [class*="SelectableTile"][role="radio"], [role="radio"]'))
            .filter(e => e.offsetParent !== null);
        const tile = tiles[idx];
        if (!tile) return false;
        try { tile.click(); } catch (_) { }
        const r = tile.getBoundingClientRect();
        clickAt(r.left + r.width / 2, r.top + r.height / 2);
        return true;
    }

    function applyFillIn(answer) {
        const value = String(answer.value ?? "");
        const input = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])'))
            .find(i => !i.disabled && i.offsetParent !== null);
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
        } finally {
            clearTimeout(to);
        }
    }

    function dismissFeedback() {
        const btns = Array.from(document.querySelectorAll("button"));
        const m = btns.find(b => /^(got it|continue|next|okay|ok)$/i.test((b.innerText || "").trim()) && !b.disabled);
        if (m) m.click();
    }

    function thinkDelay() {
        return new Promise(r => setTimeout(r, 1200 + Math.random() * 1800));
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

            pushLog("ai → " + JSON.stringify(answer).slice(0, 70));

            let ok = false;
            if (answer.type === "multiple_choice") ok = applyMultipleChoice(q, answer);
            else if (answer.type === "fill_in") ok = applyFillIn(answer);

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
                pushLog("✗ wrong", "err");
                lastAnsweredSig = "";
                dismissFeedback();
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