let ws = null;
let canvas = null;
let ctx = null;
let currentFrameSize = { width: 1366, height: 768 };
let lastClickTime = 0;
let clickCount = 0;

export function initViewer(sessionId, token) {
    canvas = document.getElementById("viewer");
    if (!canvas) return;
    ctx = canvas.getContext("2d");

    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(
        `${proto}://${location.host}/view?sessionId=${sessionId}&token=${encodeURIComponent(token)}`
    );
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
        setViewStatus("live");
    });

    ws.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") return;
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        if (msg.type === "frame") drawFrame(msg.data);
        else if (msg.type === "meta") {
            if (msg.width && msg.height) currentFrameSize = { width: msg.width, height: msg.height };
        }
    });

    ws.addEventListener("close", () => {
        setViewStatus("disconnected");
    });

    // ── input capture ─────────────────────────────────────────────
    canvas.tabIndex = 0;

    canvas.addEventListener("mousedown", (e) => { canvas.focus(); sendMouse(e, "down"); });
    canvas.addEventListener("mouseup", (e) => sendMouse(e, "up"));
    canvas.addEventListener("mousemove", (e) => sendMouse(e, "move"));
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        if (!ws || ws.readyState !== 1) return;
        const { x, y } = scaleCoords(e);
        ws.send(JSON.stringify({
            type: "wheel", x, y,
            deltaX: e.deltaX, deltaY: e.deltaY
        }));
    }, { passive: false });

    canvas.addEventListener("keydown", (e) => {
        e.preventDefault();
        sendKey("down", e);
    });
    canvas.addEventListener("keyup", (e) => {
        e.preventDefault();
        sendKey("up", e);
    });

    canvas.addEventListener("paste", (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData("text");
        if (text && ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: "paste", text }));
        }
    });
}

export function destroyViewer() {
    if (ws) { try { ws.close(); } catch (_) { } ws = null; }
}

// ── frame rendering ────────────────────────────────────────────

const imageCache = new Image();
function drawFrame(base64) {
    imageCache.onload = () => {
        if (canvas.width !== imageCache.width || canvas.height !== imageCache.height) {
            canvas.width = imageCache.width;
            canvas.height = imageCache.height;
            currentFrameSize = { width: imageCache.width, height: imageCache.height };
        }
        ctx.drawImage(imageCache, 0, 0);
    };
    imageCache.src = "data:image/jpeg;base64," + base64;
}

// ── coordinate scaling ─────────────────────────────────────────

function scaleCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const x = cssX * (currentFrameSize.width / rect.width);
    const y = cssY * (currentFrameSize.height / rect.height);
    return { x, y };
}

function sendMouse(e, action) {
    if (!ws || ws.readyState !== 1) return;
    const { x, y } = scaleCoords(e);

    let cc = 1;
    if (action === "down") {
        const now = Date.now();
        clickCount = (now - lastClickTime < 400) ? clickCount + 1 : 1;
        lastClickTime = now;
        cc = clickCount;
    } else {
        cc = clickCount;
    }

    const buttonName = e.button === 0 ? "left" : e.button === 1 ? "middle" : e.button === 2 ? "right" : "none";

    ws.send(JSON.stringify({
        type: "mouse",
        action,
        x, y,
        button: action === "move" ? "none" : buttonName,
        buttons: e.buttons,
        clickCount: cc
    }));
}

function sendKey(action, e) {
    if (!ws || ws.readyState !== 1) return;
    const modifiers =
        (e.altKey ? 1 : 0) |
        (e.ctrlKey ? 2 : 0) |
        (e.metaKey ? 4 : 0) |
        (e.shiftKey ? 8 : 0);

    const text = (action === "down" && e.key && e.key.length === 1) ? e.key : "";

    ws.send(JSON.stringify({
        type: "key",
        action,
        key: e.key,
        code: e.code,
        text,
        keyCode: e.keyCode,
        modifiers
    }));
}

function setViewStatus(s) {
    const el = document.getElementById("viewer-status");
    if (el) el.textContent = s;
}