// IXL Solver content script — runs inside every ixl.com page
const API_BASE = window.__IXL_SOLVER_API__ || "https://ixl-solver-production.up.railway.app";

let running = false;
let panelEl = null;
let statusEl = null;
let logEl = null;
let toggleBtn = null;
let token = "";

(function readToken() {
    const m = location.search.match(/[?&]ixl_solver_token=([^&]+)/);
    if (m) {
        token = decodeURIComponent(m[1]);
        try { sessionStorage.setItem("__ixl_tok", token); } catch (_) { }
    } else {
        try { token = sessionStorage.getItem("__ixl_tok") || ""; } catch (_) { }
    }
})();

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
        '.SelectableTile[role="radio"], [class*="SelectableTile"][role="radio"]'
    )).filter(e => e.offsetParent !== null);
    const options = tiles.map(t => extractText(t)).filter(Boolean);

    let questionText = "";
    const qEl = document.querySelector('[data-testid="question-container"], [class*="QuestionContainer"], [class*="question-container"]');
    if (qEl) questionText = extractText(qEl).slice(0, 2000);

    const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input:not([type])'))
        .filter(i => !i.disabled && i.offsetParent !== null)
        .map(i => ({ placeholder: i.placeholder || "", ariaLabel: i.getAttribute("aria-label") || "" }));

    let type = "unknown";
    if (options.length >= 2) type = "multiple_choice";
    else if (inputs.length > 0) type = "fill_in";

    return { type, stem: questionText, options, inputs };
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
    const tiles = Array.from(document.querySelectorAll(
        '.SelectableTile[role="radio"], [class*="SelectableTile"][role="radio"]'
    )).filter(e => e.offsetParent !== null);
    const tile = tiles[idx];
    if (!tile) return false;
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

async function reportFeedback(question, correct, correctAnswerText) {
    try {
        await fetch(`${API_BASE}/api/feedback`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-IXL-Token": token },
            body: JSON.stringify({ question, correct, correctAnswerText })
        });
    } catch (_) { }
}

function readFeedback(sigBefore) {
    const text = document.body.innerText || "";
    const wrong = /sorry,\s*incorrect/i.test(text) || /the correct answer is/i.test(text);
    if (wrong) {
        const m = text.match(/the correct answer is:?\s*([^\n]+)/i);
        return { correct: false, correctAnswerText: m ? m[1].trim().slice(0, 200) : "" };
    }
    if (/(correct!|nice work|good job|great job|well done)/i.test(text)) return { correct: true };
    const tiles = Array.from(document.querySelectorAll('[class*="SelectableTile"][role="radio"]'));
    const sigNow = tiles.map(t => (t.innerText || "").trim()).join("|");
    return { correct: sigNow !== sigBefore && sigNow ? true : null, correctAnswerText: "" };
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

let busy = false;
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

        const sig = captureSignature();
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

        await new Promise(r => setTimeout(r, 500));
        clickSubmit();

        await new Promise(r => setTimeout(r, 2200));
        const fb = readFeedback(sig);

        if (fb.correct === true) { pushLog("✓ correct", "ok"); setStatus("correct"); }
        else if (fb.correct === false) {
            pushLog("✗ wrong — IXL: " + (fb.correctAnswerText || "?"), "err");
            reportFeedback(q, false, fb.correctAnswerText);
            dismissFeedback();
        } else { pushLog("? feedback unknown"); }

        await new Promise(r => setTimeout(r, 800));
    } catch (err) {
        pushLog("loop error: " + err.message, "err");
    } finally {
        busy = false;
        if (running) setTimeout(loop, 400);
    }
}

function boot() {
    buildPanel();
    pushLog("panel ready. click Start Auto.", "ok");
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();