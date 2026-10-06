export async function handleInput(cdp, msg) {
    if (!cdp || !msg || !msg.type) return null;

    switch (msg.type) {
        case "mouse": {
            const { action, x, y, button = "left", buttons = 0, clickCount = 1 } = msg;
            const type = action === "down" ? "mousePressed"
                : action === "up" ? "mouseReleased"
                    : "mouseMoved";
            await cdp.send("Input.dispatchMouseEvent", {
                type, x: Math.round(x), y: Math.round(y), button, buttons, clickCount
            }).catch(() => { });
            return null;
        }

        case "wheel":
            await cdp.send("Input.dispatchMouseEvent", {
                type: "mouseWheel",
                x: Math.round(msg.x || 0),
                y: Math.round(msg.y || 0),
                deltaX: Math.round(msg.deltaX || 0),
                deltaY: Math.round(msg.deltaY || 0)
            }).catch(() => { });
            return null;

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
            return null;
        }

        case "paste": {
            const text = String(msg.text || "");
            if (text) await cdp.send("Input.insertText", { text }).catch(() => { });
            return null;
        }

        case "copy-request": {
            // ask chromium for the current clipboard
            try {
                const r = await cdp.send("Runtime.evaluate", {
                    expression: "navigator.clipboard.readText()",
                    awaitPromise: true,
                    returnByValue: true
                });
                return { type: "clipboard", text: r?.result?.value || "" };
            } catch (_) {
                return { type: "clipboard", text: "" };
            }
        }
    }
    return null;
}