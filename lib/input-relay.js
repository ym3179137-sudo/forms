export async function handleInput(cdp, msg) {
    if (!cdp || !msg || !msg.type) return;

    switch (msg.type) {
        case "mouse": {
            const { action, x, y, button = "left", clickCount = 1 } = msg;
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
                    await cdp.send("Input.dispatchMouseEvent", {
                        type: "mouseMoved",
                        x: px, y: py, button: "none", buttons: 0, clickCount: 0, pointerType: "mouse"
                    });
                    await new Promise(r => setTimeout(r, 10));
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
                    await cdp.send("Input.dispatchMouseEvent", {
                        type: "mouseMoved",
                        x: px, y: py, button: "none", buttons: 0, clickCount: 0, pointerType: "mouse"
                    });
                    await new Promise(r => setTimeout(r, 10));
                    await cdp.send("Input.dispatchMouseEvent", {
                        type: "mouseReleased",
                        x: px, y: py,
                        button,
                        buttons: 0,
                        clickCount,
                        pointerType: "mouse",
                        force: 0.5
                    });

                    // ── DOM-level click injection — React WILL see this ──
                    await cdp.send("Runtime.evaluate", {
                        expression: `(function(){
              const x = ${px}, y = ${py};
              const el = document.elementFromPoint(x, y);
              if (!el) return "no-element";
              const opts = {
                bubbles: true, cancelable: true, composed: true,
                view: window, clientX: x, clientY: y,
                screenX: x, screenY: y,
                button: 0, buttons: 0,
                pointerId: 1, pointerType: "mouse", isPrimary: true,
                width: 1, height: 1, pressure: 0.5
              };
              try {
                el.dispatchEvent(new PointerEvent("pointerdown", { ...opts, buttons: 1 }));
                el.dispatchEvent(new MouseEvent("mousedown", { ...opts, buttons: 1 }));
                el.dispatchEvent(new PointerEvent("pointerup", opts));
                el.dispatchEvent(new MouseEvent("mouseup", opts));
                el.dispatchEvent(new MouseEvent("click", opts));
                if (el.focus) try { el.focus(); } catch(_){}
                return el.tagName + "|" + (el.className || "").toString().slice(0, 40);
              } catch (e) { return "error:" + e.message; }
            })()`,
                        returnByValue: true
                    }).catch(() => { });
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

                    // also inject DOM keydown for React listeners
                    await cdp.send("Runtime.evaluate", {
                        expression: `(function(){
              const el = document.activeElement || document.body;
              const opts = { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, bubbles: true, cancelable: true };
              try { el.dispatchEvent(new KeyboardEvent("keydown", opts)); } catch(_){}
            })()`,
                        returnByValue: true
                    }).catch(() => { });
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
            if (!text) break;
            try {
                await cdp.send("Input.insertText", { text });
            } catch (_) { }
            // also DOM insert for React-controlled inputs
            try {
                await cdp.send("Runtime.evaluate", {
                    expression: `(function(){
            const el = document.activeElement;
            if (!el) return;
            if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
              const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, "value").set;
              setter.call(el, (el.value || "") + ${JSON.stringify(text)});
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));
            }
          })()`,
                    returnByValue: true
                });
            } catch (_) { }
            break;
        }
    }
}