export async function handleInput(cdp, msg) {
    if (!cdp || !msg || !msg.type) return;

    switch (msg.type) {
        case "mouse": {
            const { action, x, y, button = "left", buttons = 0, clickCount = 1 } = msg;
            const type = action === "down" ? "mousePressed"
                : action === "up" ? "mouseReleased"
                    : "mouseMoved";

            // CDP expects buttons bitmask: 1=left, 2=right, 4=middle
            let cdpButtons = buttons;
            if (action === "down") cdpButtons = button === "left" ? 1 : button === "right" ? 2 : button === "middle" ? 4 : 0;
            if (action === "up") cdpButtons = 0;

            await cdp.send("Input.dispatchMouseEvent", {
                type,
                x: Math.round(x),
                y: Math.round(y),
                button: type === "mouseMoved" ? "none" : button,
                buttons: cdpButtons,
                clickCount: type === "mouseMoved" ? 0 : clickCount,
                modifiers: 0,
                pointerType: "mouse"
            }).catch((e) => console.error("[input]", e.message));
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