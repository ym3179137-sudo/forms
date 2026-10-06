let canvas = null;
let ctx = null;
let currentFrameSize = { width: 1366, height: 768 };
let sendFn = null;
let lastClickTime = 0;
let clickCount = 0;

export function attachCanvas(canvasEl, send) {
    canvas = canvasEl;
    ctx = canvas.getContext("2d");
    sendFn = send;

    canvas.tabIndex = 0;

    canvas.addEventListener("mousedown", (e) => { canvas.focus(); sendMouse(e, "down"); });
    canvas.addEventListener("mouseup", (e) => sendMouse(e, "up"));
    canvas.addEventListener("mousemove", (e) => sendMouse(e, "move"));
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        const { x, y } = scaleCoords(e);
        sendFn({ type: "input", payload: { type: "wheel", x, y, deltaX: e.deltaX, deltaY: e.deltaY } });
    }, { passive: false });

    canvas.addEventListener("keydown", (e) => { e.preventDefault(); sendKey("down", e); });
    canvas.addEventListener("keyup", (e) => { e.preventDefault(); sendKey("up", e); });

    canvas.addEventListener("paste", (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData("text");
        if (text) sendFn({ type: "input", payload: { type: "paste", text } });
    });
}

const imageCache = new Image();
export function renderFrame(base64) {
    if (!canvas || !ctx) return;
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

export function setViewStatus(s) {
    const el = document.getElementById("viewer-status");
    if (el) el.textContent = s;
}

function scaleCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (currentFrameSize.width / rect.width);
    const y = (e.clientY - rect.top) * (currentFrameSize.height / rect.height);
    return { x, y };
}

function sendMouse(e, action) {
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
    sendFn({
        type: "input",
        payload: {
            type: "mouse",
            action,
            x, y,
            button: action === "move" ? "none" : buttonName,
            buttons: e.buttons,
            clickCount: cc
        }
    });
}

function sendKey(action, e) {
    const modifiers =
        (e.altKey ? 1 : 0) |
        (e.ctrlKey ? 2 : 0) |
        (e.metaKey ? 4 : 0) |
        (e.shiftKey ? 8 : 0);
    const text = (action === "down" && e.key && e.key.length === 1) ? e.key : "";
    sendFn({
        type: "input",
        payload: {
            type: "key",
            action,
            key: e.key,
            code: e.code,
            text,
            keyCode: e.keyCode,
            modifiers
        }
    });
}