// reads IXL's post-submit feedback and detects correct/wrong.
// also extracts the "The correct answer is:" value when wrong.

export async function readFeedback(page, previousSig) {
    // give IXL time to render feedback
    await new Promise(r => setTimeout(r, 2200));

    return await page.evaluate((prev) => {
        const text = (document.body.innerText || "").replace(/\r/g, "");

        // 1. explicit wrong-answer banner
        const wrongMatch = text.match(/sorry,\s*incorrect[\s\S]{0, 800}?the correct answer is:?\s*([^\n]+)/i);
        if (wrongMatch) {
            return {
                correct: false,
                correctAnswerText: wrongMatch[1].trim().slice(0, 200)
            };
        }
        // also handle "Incorrect" without "sorry"
        const incorrect = /^incorrect|\bincorrect\b/i.test(text) && /the correct answer is/i.test(text);
        if (incorrect) {
            const m2 = text.match(/the correct answer is:?\s*([^\n]+)/i);
            return {
                correct: false,
                correctAnswerText: m2 ? m2[1].trim().slice(0, 200) : ""
            };
        }

        // 2. explicit correct signals
        if (/(correct!|nice work|good job|great job|well done)/i.test(text)) {
            return { correct: true };
        }

        // 3. fall back to "did the question change?"
        const tiles = Array.from(document.querySelectorAll('[class*="SelectableTile"][role="radio"]'));
        const currentSig = tiles.map(t => (t.innerText || "").trim()).join("|");
        const changed = currentSig && currentSig !== (prev || "");
        return { correct: changed, unknown: !changed };
    }, previousSig);
}

// IXL shows a "Got it / Continue / Next" button after wrong answers.
// click it so we can move past the feedback panel.
export async function dismissWrongFeedback(page) {
    const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
        const re = /^(got it|continue|next|okay|ok|see explanation|try again)$/i;
        const match = buttons.find(b => re.test((b.innerText || "").trim()) && !b.disabled);
        if (match) {
            match.scrollIntoView({ block: "center", behavior: "instant" });
            match.click();
            return (match.innerText || "").trim();
        }
        return null;
    });
    if (clicked) console.log(`[feedback] dismissed with "${clicked}"`);
    return clicked;
}

// convert "The correct answer is: 20" text into our answer schema
export function parseCorrectAnswerText(text, question) {
    const cleaned = String(text || "").trim();
    if (!cleaned) return null;

    if (question.type === "multiple_choice") {
        const opts = question.options || [];
        // exact match
        let idx = opts.findIndex(o => o.trim() === cleaned);
        if (idx >= 0) return { type: "multiple_choice", answer_index: idx };
        // case/space-insensitive
        const lc = cleaned.toLowerCase();
        idx = opts.findIndex(o => o.trim().toLowerCase() === lc);
        if (idx >= 0) return { type: "multiple_choice", answer_index: idx };
        // substring
        idx = opts.findIndex(o => {
            const t = o.trim().toLowerCase();
            return t.includes(lc) || lc.includes(t);
        });
        if (idx >= 0) return { type: "multiple_choice", answer_index: idx };
        return null;
    }

    if (question.type === "fill_in") {
        return { type: "fill_in", value: cleaned };
    }

    return null;
}

// snapshot of the current tile texts — used as the "before" marker
export async function captureSignature(page) {
    return await page.evaluate(() => {
        const tiles = Array.from(document.querySelectorAll('[class*="SelectableTile"][role="radio"]'));
        return tiles.map(t => (t.innerText || "").trim()).join("|");
    });
}