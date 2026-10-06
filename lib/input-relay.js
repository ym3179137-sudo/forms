export async function handleInput(page, msg) {
    if (!page || !msg || !msg.type) return;

    if (msg.type === "mouse") {
        const { action, x, y, button = "left" } = msg;
        const px = Math.round(x);
        const py = Math.round(y);

        try {
            if (action === "move") {
                await page.mouse.move(px, py);
            } else if (action === "down") {
                await page.mouse.move(px, py);
                await page.mouse.down({ button });
            } else if (action === "up") {
                await page.mouse.move(px, py);
                await page.mouse.up({ button });
            }
        } catch (err) {
            console.error("[input mouse]", err.message);
        }
        return;
    }

    if (msg.type === "wheel") {
        try {
            await page.mouse.move(Math.round(msg.x || 0), Math.round(msg.y || 0));
            await page.mouse.wheel(msg.deltaX || 0, msg.deltaY || 0);
        } catch (_) { }
        return;
    }

    if (msg.type === "key") {
        const { action, key, text } = msg;
        try {
            if (action === "down") {
                if (text && text.length === 1) await page.keyboard.down(text);
                else await page.keyboard.down(key);
            } else if (action === "up") {
                if (text && text.length === 1) await page.keyboard.up(text);
                else await page.keyboard.up(key);
            }
        } catch (_) { }
        return;
    }

    if (msg.type === "paste") {
        const text = String(msg.text || "");
        if (!text) return;
        try { await page.keyboard.insertText(text); } catch (_) { }
        return;
    }
}