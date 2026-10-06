export async function handleInput(cdp, msg) {
    if (!cdp || !msg || !msg.type) return;

    switch (msg.type) {
        case "mouse": {
            const { action, x, y, button = "left", buttons = 0, clickCount = 1 } = msg;
            const px = Math.round(x);
            const py = Math.round(y);

            // IXL listens to POINTER events. CDP needs the mouse event type + pointerType hint.
            const type = action === "down" ? "mousePressed"
                : action === "up" ? "mouseReleased"
                    : "mouseMoved";

            await cdp.send("Input.dispatchMouseEvent", {
                type,
                x: px, y: py,
                button: type === "mouseMoved" ? "none" : button,
                buttons,
                clickCount: type === "mouseMoved" ? 0 : clickCount,
                pointerType: "mouse",
                force: 0.5,
                modifiers: 0
            }).catch((e) => console.error("[input mouse]", e.message));
            break;
        }

        case "wheel":
            await cdp.send("Input.dispatchMouseEvent", {
                type: "mouseWheel",
                x: Math.round(msg.x || 0),
                y: Math.round(msg.y || 0),
                deltaX: Math.round(msg.deltaX || 0),
                deltaY: Math.round(msg.deltaY || 0),
                pointerType: "mouse"
            }).catch(() => { });
            break;

        case "key": {
            const { action, key, code, text, keyCode, modifiers = 0 } = msg;
            if (action === "down") {
                if (text && text.length === 1) {
                    await cdp.send("Input.dispatchKeyEvent", {
                        type: "char", text, unmodifiedText: text, key, code,
                        windowsVirtualKeyCode: keyCode || 0,
                        nativeVirtualKeyCode: keyCode || 0,
                        modifiers
                    }).catch(() => { });
                }
                await cdp.send("Input.dispatchKeyEvent", {
                    type: "keyDown", key, code,
                    windowsVirtualKeyCode: keyCode || 0,
                    nativeVirtualKeyCode: keyCode || 0,
                    modifiers
                }).catch(() => { });
            } else {
                await cdp.send("Input.dispatchKeyEvent", {
                    type: "keyUp", key, code,
                    windowsVirtualKeyCode: keyCode || 0,
                    nativeVirtualKeyCode: keyCode || 0,
                    modifiers
                }).catch(() => { });
            }
            break;
        }

        case "paste": {
            const text = String(msg.text || "");
            if (text) await cdp.send("Input.insertText", { text }).catch(() => { });
            break;
        }
    }
}