export async function parseQuestion(page) {
    const collected = await page.evaluate(() => {
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
                if (tag === "msup") { const k = Array.from(node.children); if (k[0]) walk(k[0]); out += "^"; if (k[1]) walk(k[1]); out += " "; return; }
                if (tag === "msub") { const k = Array.from(node.children); if (k[0]) walk(k[0]); out += "_"; if (k[1]) walk(k[1]); out += " "; return; }
                node.childNodes.forEach(walk);
            }
            walk(el);
            return out.replace(/\s+/g, " ").trim();
        }
        function visible(el) {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
        }

        // ─── find question container ────────────────────────────────
        const containerSelectors = [
            '[data-testid="question-container"]',
            '[class*="QuestionContainer"]',
            '[class*="question-container"]',
            '[class*="PracticeQuestion"]',
            'main [class*="question"]'
        ];
        let root = null;
        for (const s of containerSelectors) {
            const c = Array.from(document.querySelectorAll(s)).filter(visible);
            if (c.length) { root = c[0]; break; }
        }
        if (!root) root = document.querySelector("main") || document.body;

        // ─── question text ──────────────────────────────────────────
        let questionText = "";
        const textSelectors = [
            '[class*="question-text"]',
            '[class*="prompt"]',
            '[class*="QuestionText"]',
            '[class*="stem"]'
        ];
        for (const s of textSelectors) {
            const el = root.querySelector(s);
            if (el && visible(el)) {
                const t = extractText(el);
                if (t && t.length > 3) { questionText = t; break; }
            }
        }
        if (!questionText) {
            // fallback: first <p>/<div> with a question mark or operator
            const candidates = Array.from(root.querySelectorAll("p, h2, h3, div")).slice(0, 40);
            for (const el of candidates) {
                if (!visible(el)) continue;
                if (el.children.length > 8) continue;
                const t = extractText(el);
                if (!t || t.length < 5 || t.length > 600) continue;
                if (/\?|what|which|how|identify|select|choose|solve|evaluate|find|complete|translate|correct/i.test(t)) {
                    questionText = t;
                    break;
                }
            }
        }

        // ─── passage (ELA / science / social studies) ───────────────
        let passage = "";
        const passSel = ['[class*="passage"]', '[class*="Passage"]', '[class*="reading"]', 'article'];
        for (const s of passSel) {
            for (const el of Array.from(document.querySelectorAll(s)).filter(visible)) {
                const t = extractText(el);
                if (t.length > passage.length && t.length < 8000) passage = t;
            }
        }
        if (!passage) {
            // biggest <p> group
            const ps = Array.from(root.querySelectorAll("p")).filter(visible);
            let longest = "";
            for (const p of ps) { const t = extractText(p); if (t.length > longest.length && t.length < 6000) longest = t; }
            if (longest.length > 150) passage = longest;
        }
        if (passage && questionText && passage.includes(questionText)) passage = "";

        // ─── multiple choice tiles (radio role) ─────────────────────
        const mcTiles = Array.from(root.querySelectorAll(
            '.SelectableTile[role="radio"], [class*="SelectableTile"][role="radio"], [role="radio"][class*="MULTIPLE_CHOICE"]'
        )).filter(visible);
        const options = mcTiles.map(t => extractText(t)).filter(t => t && t.length < 800);

        // ─── checkbox tiles (multi-select) ──────────────────────────
        const cbTiles = Array.from(root.querySelectorAll(
            '[role="checkbox"], [class*="SelectableTile"][role="checkbox"], input[type="checkbox"]'
        )).filter(visible);

        // ─── text inputs ────────────────────────────────────────────
        const inputs = Array.from(root.querySelectorAll(
            'input[type="text"], input[type="number"], input:not([type]), textarea'
        )).filter(i => !i.disabled && visible(i)).map(i => ({
            placeholder: i.placeholder || "",
            value: i.value || "",
            ariaLabel: i.getAttribute("aria-label") || ""
        }));

        // ─── dropdowns (select) ─────────────────────────────────────
        const dropdowns = Array.from(root.querySelectorAll("select")).filter(visible).map(sel => ({
            options: Array.from(sel.options).map(o => o.textContent.trim()),
            ariaLabel: sel.getAttribute("aria-label") || "",
            currentValue: sel.value
        }));

        // ─── canvas (graph / plotting) ──────────────────────────────
        const hasCanvas = !!root.querySelector("canvas");

        // ─── drag-and-drop tiles / zones ────────────────────────────
        const draggables = Array.from(root.querySelectorAll(
            '[draggable="true"], [class*="draggable"], [class*="SelectableTile"][class*="drag"]'
        )).filter(visible).map(d => extractText(d)).filter(Boolean);
        const dropZones = Array.from(root.querySelectorAll(
            '[class*="drop-zone"], [class*="dropzone"], [data-drop-target], [class*="target"]'
        )).filter(visible).map(d => extractText(d));

        // ─── matching columns ───────────────────────────────────────
        const matchLeft = Array.from(root.querySelectorAll('[class*="match-left"], [class*="left-column"] [class*="tile"]'))
            .filter(visible).map(e => extractText(e));
        const matchRight = Array.from(root.querySelectorAll('[class*="match-right"], [class*="right-column"] [class*="tile"]'))
            .filter(visible).map(e => extractText(e));

        return {
            questionText, passage, options, inputs, dropdowns, hasCanvas,
            draggables, dropZones, matchLeft, matchRight,
            hasCheckboxes: cbTiles.length > 0
        };
    });

    // ─── classify ──────────────────────────────────────────────────
    let type = "unknown";

    if (collected.hasCheckboxes && collected.options.length < 2 && collected.inputs.length === 0) {
        // checkbox list without visible tile text — try treating the whole question as multi-select
        type = "multi_select";
    } else if (collected.matchLeft.length > 0 && collected.matchRight.length > 0) {
        type = "matching";
    } else if (collected.dropdowns.length > 0) {
        type = "dropdown";
    } else if (collected.draggables.length > 0 && collected.dropZones.length > 0) {
        type = "drag_drop";
    } else if (collected.options.length >= 2) {
        type = "multiple_choice";
    } else if (collected.inputs.length > 0) {
        type = "fill_in";
    } else if (collected.hasCanvas) {
        type = "visual";
    }

    // vision fallback for math-heavy or ambiguous
    const mathy = /[÷×^√=+\-*/]|\d\s*[a-z]\s*\d/.test(collected.questionText || "")
        || (collected.questionText && collected.questionText.length < 30 && /\d/.test(collected.questionText));
    const needsVision = type === "visual" || (type === "unknown" && mathy);

    let screenshotBase64 = null;
    if (needsVision) {
        const buf = await page.screenshot({ type: "png", fullPage: false });
        screenshotBase64 = buf.toString("base64");
    }

    // build stem
    const stemParts = [];
    if (collected.passage) stemParts.push("PASSAGE:\n" + collected.passage.slice(0, 2500));
    if (collected.questionText) stemParts.push("QUESTION:\n" + collected.questionText);
    const stem = stemParts.join("\n\n").trim();

    return {
        type,
        stem,
        options: collected.options,
        inputs: collected.inputs,
        dropdowns: collected.dropdowns,
        draggables: collected.draggables,
        dropZones: collected.dropZones,
        matchLeft: collected.matchLeft,
        matchRight: collected.matchRight,
        needsVision,
        screenshotBase64
    };
}