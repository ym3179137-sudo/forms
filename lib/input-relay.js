export async function handleInput(cdp, msg) {
    if (!cdp || !msg || !msg.type) return;

    switch (msg.type) {
        case "mouse": {
            const { action, x, y, button = "left", buttons = 0, clickCount = 1 } = msg;
            const px = Math.round(x);
            const py = Math.round(y);

            try {
                if (action === "move") {
                    await cdp.send("Input.dispatchMouseEvent", {
                        type: "mouseMoved",
                        x: px, y: py,
                        button: "none",
                        buttons: 0,
                        clickCount: 0,
                        pointerType: "mouse"
                    });
                } else if (action === "down") {
                    // 1) move first — this primes chromium's internal cursor position
                    await cdp.send("Input.dispatchMouseEvent", {
                        type: "mouseMoved",
                        x: px, y: py,
                        button: "none",
                        buttons: 0,
                        clickCount: 0,
                        pointerType: "mouse"
                    });
                    await new Promise(r => setTimeout(r, 12));

                    // 2) press
                    await cdp.send("Input.dispatchMouseEvent", {
                        type: "mousePressed",
                        x: px, y: py,
                        button,
                        buttons: button === "left" ? 1 : button === "right" ? 2 : button === "middle" ? 4 : 0,
                        clickCount,
                        pointerType: "mouse",
                        force: 0.5
                    });
                } else if (action === "up") {
                    // 1) move first (in case we lost the cursor)
                    await cdp.send("Input.dispatchMouseEvent", {
                        type: "mouseMoved",
                        x: px, y: py,
                        button: "none",
                        buttons: 0,
                        clickCount: 0,
                        pointerType: "mouse"
                    });
                    await new Promise(r => setTimeout(r, 12));

                    // 2) release
                    await cdp.send("Input.dispatchMouseEvent", {
                        type: "mouseReleased",
                        x: px, y: py,
                        button,
                        buttons: 0,
                        clickCount,
                        pointerType: "mouse",
                        force: 0.5
                    });
                }
            } catch (e) {
                console.error("[input mouse] error:", e.message);
            }
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
            try {
                if (action === "down") {
                    if (text && text.length === 1) {
                        await cdp.send("Input.dispatchKeyEvent", {
                            type: "char", text, unmodifiedText: text, key, code,
                            windowsVirtualKeyCode: keyCode || 0,
                            nativeVirtualKeyCode: keyCode || 0,
                            modifiers
                        });
                    }
                    await cdp.send("Input.dispatchKeyEvent", {
                        type: "keyDown", key, code,
                        windowsVirtualKeyCode: keyCode || 0,
                        nativeVirtualKeyCode: keyCode || 0,
                        modifiers
                    });
                } else {
                    await cdp.send("Input.dispatchKeyEvent", {
                        type: "keyUp", key, code,
                        windowsVirtualKeyCode: keyCode || 0,
                        nativeVirtualKeyCode: keyCode || 0,
                        modifiers
                    });
                }
            } catch (_) { }
            break;
        }

        case "paste": {
            const text = String(msg.text || "");
            if (text) await cdp.send("Input.insertText", { text }).catch(() => { });
            break;
        }
    }
}