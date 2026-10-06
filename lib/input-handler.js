import { humanDelay } from "./humanize.js";

const SPEED = 50;
const fast = (ms) => Math.max(8, Math.round(ms / SPEED));

export async function applyAnswer(page, question, answer, behavior) {
    await dismissModals(page);
    switch (answer.type) {
        case "multiple_choice": return applyMultipleChoice(page, question, answer, behavior);
        case "multi_select": return applyMultiSelect(page, question, answer, behavior);
        case "fill_in": return applyFillIn(page, answer, behavior);
        case "dropdown": return applyDropdown(page, answer, behavior);
        case "matching": return applyMatching(page, answer, behavior);
        case "sorting": return applySorting(page, answer, behavior);
        case "drag_drop": return applyDragDrop(page, answer, behavior);
        case "visual": return applyVisual(page, question, answer, behavior);
        default: throw new Error("unknown answer type: " + answer.type);
    }
}

// ─── force submit with debounce ─────────────────────────────────────

export async function forceSubmit(page) {
    const now = Date.now();
    const last = await page.evaluate(() => window.__lastSubmitAt || 0).catch(() => 0);
    if (now - last < 1500) {
        console.log("[submit] debounced");
        return false;
    }
    await page.evaluate((t) => { window.__lastSubmitAt = t; }, now).catch(() => { });

    for (let attempt = 1; attempt <= 3; attempt++) {
        const found = await page.evaluate((maxWaitMs) => {
            const SUBMIT_RE = /^submit$|^submit answer$|^check$|^check answer$|^done$/i;
            const findEnabled = () => {
                const btns = Array.from(document.querySelectorAll("button, [role='button']"));
                return btns.find((b) => {
                    const t = (b.innerText || "").trim();
                    if (!SUBMIT_RE.test(t)) return false;
                    if (b.disabled) return false;
                    const r = b.getBoundingClientRect();
                    return r.width > 0 && r.height > 0;
                });
            };
            return new Promise((resolve) => {
                const start = Date.now();
                const tick = () => {
                    const el = findEnabled();
                    if (el) {
                        el.scrollIntoView({ block: "center", behavior: "instant" });
                        const r = el.getBoundingClientRect();
                        resolve({ ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2, text: (el.innerText || "").trim() });
                        return;
                    }
                    if (Date.now() - start > maxWaitMs) { resolve({ ok: false }); return; }
                    setTimeout(tick, 100);
                };
                tick();
            });
        }, 4000);

        if (!found.ok) {
            if (attempt >= 3) { console.log("[submit] no enabled submit button found"); return false; }
            await new Promise(r => setTimeout(r, 200));
            continue;
        }

        await realClick(page, found.x, found.y);
        console.log(`[submit] clicked "${found.text}" (attempt ${attempt})`);

        await new Promise(r => setTimeout(r, 400));

        const stillThere = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll("button, [role='button']"));
            return btns.some((b) => {
                const t = (b.innerText || "").trim();
                if (!/^submit$|^submit answer$|^check$|^check answer$|^done$/i.test(t)) return false;
                const r = b.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && !b.disabled;
            });
        });

        if (!stillThere) {
            console.log("[submit] page advanced");
            return true;
        }

        await new Promise(r => setTimeout(r, 250));
    }

    return true;
}

// ─── mouse helpers ──────────────────────────────────────────────────

async function glideMouse(page, targetX, targetY) {
    const start = await page.evaluate(() => ({
        x: window.__lastMouseX ?? window.innerWidth / 2,
        y: window.__lastMouseY ?? window.innerHeight / 2
    })).catch(() => ({ x: 683, y: 384 }));

    const steps = 5;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = start.x + (targetX - start.x) * t;
        const y = start.y + (targetY - start.y) * t;
        await page.mouse.move(x, y);
    }
    await page.mouse.move(targetX, targetY);
    await page.evaluate((x, y) => { window.__lastMouseX = x; window.__lastMouseY = y; }, targetX, targetY).catch(() => { });
}

async function realClick(page, targetX, targetY) {
    await glideMouse(page, targetX, targetY);
    await page.mouse.down();
    await page.mouse.up();
}

async function dismissModals(page) {
    const dismissed = await page.evaluate(() => {
        let count = 0;
        document.querySelectorAll('.ixl-modal[role="dialog"]').forEach((m) => {
            const style = getComputedStyle(m);
            if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return;
            const buttons = Array.from(m.querySelectorAll("button"));
            const back = buttons.find((b) => /go back|cancel|close|no,? ?go/i.test((b.innerText || "").trim()));
            if (back) { back.click(); count++; }
        });
        return count;
    }).catch(() => 0);
    if (dismissed) console.log(`[modal] dismissed ${dismissed}`);
}

// ─── answer types ───────────────────────────────────────────────────

async function applyMultipleChoice(page, question, answer, behavior) {
    const idx = answer.answer_index;
    const options = question.options || [];
    const targetText = options[idx];
    if (!targetText) throw new Error(`no option at index ${idx} (options=${options.length})`);

    const coords = await page.evaluate((wanted) => {
        function norm(s) { return (s || "").replace(/\s+/g, " ").trim().toLowerCase(); }
        const want = norm(wanted);
        const tiles = Array.from(document.querySelectorAll('.SelectableTile[role="radio"], [class*="SelectableTile"][role="radio"]'));
        if (!tiles.length) return { ok: false, reason: "no tiles" };
        const match = tiles.find((el) => {
            const t = norm(el.innerText);
            return t === want || t.includes(want) || want.includes(t);
        });
        if (!match) return { ok: false, reason: "no match" };
        match.scrollIntoView({ block: "center", behavior: "instant" });
        const r = match.getBoundingClientRect();
        return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, targetText);
    if (!coords.ok) throw new Error("tile: " + coords.reason);

    await realClick(page, coords.x, coords.y);
    console.log(`[tile] clicked @ (${Math.round(coords.x)}, ${Math.round(coords.y)})`);

    await new Promise(r => setTimeout(r, 250));
    await forceSubmit(page);
}

async function applyMultiSelect(page, question, answer, behavior) {
    const indices = answer.answer_indices || [];
    console.log(`[multi] selecting ${indices.length} options`);

    for (const idx of indices) {
        const coords = await page.evaluate((i) => {
            const tiles = Array.from(document.querySelectorAll(
                '[role="checkbox"], [class*="SelectableTile"][role="checkbox"], input[type="checkbox"]'
            )).filter(el => el.offsetParent !== null);
            if (!tiles[i]) return null;
            const el = tiles[i];
            el.scrollIntoView({ block: "center", behavior: "instant" });
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, idx);

        if (!coords) { console.warn(`[multi] no checkbox at index ${idx}`); continue; }
        await realClick(page, coords.x, coords.y);
        await new Promise(r => setTimeout(r, 200));
    }
    await forceSubmit(page);
}

async function applyFillIn(page, answer, behavior) {
    const value = String(answer.value == null ? "" : answer.value);

    const box = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), textarea'))
            .filter(i => !i.disabled && i.offsetParent !== null);
        if (!inputs.length) return null;
        const el = inputs[0];
        el.scrollIntoView({ block: "center", behavior: "instant" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    if (!box) throw new Error("no input field");

    await realClick(page, box.x, box.y);
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.keyboard.type(value, { delay: 20 });
    console.log(`[input] typed "${value}"`);

    await new Promise(r => setTimeout(r, 180));
    await forceSubmit(page);
}

async function applyDropdown(page, answer, behavior) {
    const values = answer.values || [];
    console.log(`[dropdown] setting ${values.length} selects`);

    const selects = await page.$$("select");
    for (let i = 0; i < selects.length && i < values.length; i++) {
        const value = values[i];
        try {
            await selects[i].selectOption({ label: value });
            console.log(`[dropdown] set "${value}"`);
        } catch (err) {
            const opts = await selects[i].$$eval("option", os => os.map(o => ({ v: o.value, t: o.textContent.trim() })));
            const hit = opts.find(o => o.t.toLowerCase() === value.toLowerCase() || o.v === value);
            if (hit) await selects[i].selectOption(hit.v);
        }
        await new Promise(r => setTimeout(r, 150));
    }
    await forceSubmit(page);
}

async function applyMatching(page, answer, behavior) {
    const pairs = answer.pairs || [];
    console.log(`[matching] ${pairs.length} pairs`);

    for (const p of pairs) {
        const clickedLeft = await page.evaluate((text) => {
            function norm(s) { return (s || "").replace(/\s+/g, " ").trim().toLowerCase(); }
            const want = norm(text);
            const tiles = Array.from(document.querySelectorAll(
                '[class*="match-left"] *, [class*="left-column"] [class*="tile"], [class*="tile"][class*="left"]'
            ));
            const el = tiles.find(t => norm(t.innerText) === want || norm(t.innerText).includes(want));
            if (!el) return null;
            el.scrollIntoView({ block: "center", behavior: "instant" });
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, p.left);

        if (!clickedLeft) { console.warn(`[matching] left "${p.left}" not found`); continue; }
        await realClick(page, clickedLeft.x, clickedLeft.y);
        await new Promise(r => setTimeout(r, 250));

        const clickedRight = await page.evaluate((text) => {
            function norm(s) { return (s || "").replace(/\s+/g, " ").trim().toLowerCase(); }
            const want = norm(text);
            const tiles = Array.from(document.querySelectorAll(
                '[class*="match-right"] *, [class*="right-column"] [class*="tile"], [class*="tile"][class*="right"]'
            ));
            const el = tiles.find(t => norm(t.innerText) === want || norm(t.innerText).includes(want));
            if (!el) return null;
            el.scrollIntoView({ block: "center", behavior: "instant" });
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, p.right);

        if (!clickedRight) { console.warn(`[matching] right "${p.right}" not found`); continue; }
        await realClick(page, clickedRight.x, clickedRight.y);
        await new Promise(r => setTimeout(r, 400));
    }
    await forceSubmit(page);
}

async function applySorting(page, answer, behavior) {
    const order = answer.order || [];
    console.log(`[sorting] target order: ${order.length} items`);

    for (let targetIdx = 0; targetIdx < order.length; targetIdx++) {
        const wanted = order[targetIdx];
        for (let attempt = 0; attempt < order.length; attempt++) {
            const moved = await page.evaluate((want, targetPos) => {
                function norm(s) { return (s || "").replace(/\s+/g, " ").trim().toLowerCase(); }
                const w = norm(want);
                const items = Array.from(document.querySelectorAll('[class*="sortable"], [class*="ordering"] [class*="tile"], [class*="rank"] > *'));
                if (!items.length) return { done: true };
                const currentIdx = items.findIndex(el => norm(el.innerText).includes(w));
                if (currentIdx < 0) return { done: true };
                if (currentIdx === targetPos) return { done: true };
                const upBtn = items[currentIdx].querySelector('[class*="move-up"], [aria-label*="up" i], button[class*="up"]');
                const downBtn = items[currentIdx].querySelector('[class*="move-down"], [aria-label*="down" i], button[class*="down"]');
                if (currentIdx > targetPos && upBtn) { upBtn.click(); return { moved: "up" }; }
                if (currentIdx < targetPos && downBtn) { downBtn.click(); return { moved: "down" }; }
                return { done: true };
            }, wanted, targetIdx);

            if (moved.done) break;
            await new Promise(r => setTimeout(r, 200));
        }
    }
    await forceSubmit(page);
}

async function applyDragDrop(page, answer, behavior) {
    const placements = answer.placements || [];
    for (const p of placements) {
        const c = await page.evaluate((tileText, targetText) => {
            function norm(s) { return (s || "").replace(/\s+/g, " ").trim().toLowerCase(); }
            const tiles = Array.from(document.querySelectorAll('[draggable="true"], [class*="draggable"], [class*="tile"]'));
            const zones = Array.from(document.querySelectorAll('[class*="drop-zone"], [class*="dropzone"], [data-drop-target], [class*="target"]'));
            const tile = tiles.find(t => norm(t.innerText) === norm(tileText));
            const zone = zones.find(z => norm(z.innerText) === norm(targetText));
            if (!tile || !zone) return null;
            tile.scrollIntoView({ block: "center", behavior: "instant" });
            const tr = tile.getBoundingClientRect(), zr = zone.getBoundingClientRect();
            return { tx: tr.left + tr.width / 2, ty: tr.top + tr.height / 2, zx: zr.left + zr.width / 2, zy: zr.top + zr.height / 2 };
        }, p.tile, p.target);
        if (!c) continue;

        await glideMouse(page, c.tx, c.ty);
        await page.mouse.down();
        for (let i = 1; i <= 6; i++) {
            const t = i / 6;
            await page.mouse.move(c.tx + (c.zx - c.tx) * t, c.ty + (c.zy - c.ty) * t);
        }
        await page.mouse.up();
        await new Promise(r => setTimeout(r, 250));
    }
    await forceSubmit(page);
}

async function applyVisual(page, question, answer, behavior) {
    if (typeof answer.answer_index === "number" && question.options && question.options.length > 1) {
        return applyMultipleChoice(page, question, { answer_index: answer.answer_index }, behavior);
    }
    if (answer.value !== undefined && answer.value !== null) return applyFillIn(page, { value: answer.value }, behavior);
    throw new Error("visual answer has no actionable field");
}

export async function waitForNextQuestion(page) {
    const before = await page.evaluate(() => {
        const tiles = Array.from(document.querySelectorAll('[class*="SelectableTile"][role="radio"]'));
        return {
            tileSig: tiles.map(t => (t.innerText || "").trim()).join("|"),
            submitVisible: !!Array.from(document.querySelectorAll("button")).find((b) =>
                /^submit$/i.test((b.innerText || "").trim()) &&
                !b.disabled &&
                b.getBoundingClientRect().width > 0
            )
        };
    });

    await page.waitForFunction((prev) => {
        const tiles = Array.from(document.querySelectorAll('[class*="SelectableTile"][role="radio"]'));
        const tileSig = tiles.map(t => (t.innerText || "").trim()).join("|");
        const submitVisible = !!Array.from(document.querySelectorAll("button")).find((b) =>
            /^submit$/i.test((b.innerText || "").trim()) &&
            !b.disabled &&
            b.getBoundingClientRect().width > 0
        );
        return (tileSig && tileSig !== prev.tileSig) || (prev.submitVisible && !submitVisible);
    }, before, { timeout: 8000, polling: 80 }).catch(() => { });
}