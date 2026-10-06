import crypto from "crypto";
import { sbSelect, sbUpsert, sbUpdate } from "./supabase.js";

function norm(s) {
    return String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function hashQuestion(question) {
    const payload = JSON.stringify({
        stem: norm(question.stem),
        type: question.type,
        options: (question.options || []).map(norm)
    });
    return crypto.createHash("sha256").update(payload).digest("hex");
}

export async function lookupAnswer(question) {
    try {
        const hash = hashQuestion(question);
        const rows = await sbSelect("ixl_answers", {
            question_hash: "eq." + hash,
            select: "*",
            limit: 1
        });
        if (!rows || !rows.length) return null;
        const row = rows[0];
        if (!row.correct_answer) return null;

        // fire-and-forget hit counter
        sbUpdate("ixl_answers", { id: "eq." + row.id }, {
            hits: (row.hits || 0) + 1,
            updated_at: new Date().toISOString()
        }).catch(() => { });

        return row.correct_answer;
    } catch (e) {
        console.warn("[cache] lookup failed:", e.message);
        return null;
    }
}

export async function saveAnswer(question, answer, verified) {
    try {
        const hash = hashQuestion(question);
        const row = {
            question_hash: hash,
            question_stem: (question.stem || "").slice(0, 4000),
            question_type: question.type,
            options: question.options || [],
            correct_answer: verified ? answer : null,
            verified: !!verified,
            updated_at: new Date().toISOString()
        };
        await sbUpsert("ixl_answers", row, "question_hash");
        console.log(`[cache] saved ${verified ? "VERIFIED" : "attempt"} answer for ${hash.slice(0, 8)}`);
    } catch (e) {
        console.warn("[cache] save failed:", e.message);
    }
}

export async function recordWrongAnswer(question, answer) {
    try {
        const hash = hashQuestion(question);
        const rows = await sbSelect("ixl_answers", {
            question_hash: "eq." + hash,
            select: "id,wrong_attempts",
            limit: 1
        });
        const entry = { answer, at: new Date().toISOString() };

        if (rows && rows.length) {
            const prev = Array.isArray(rows[0].wrong_attempts) ? rows[0].wrong_attempts : [];
            const next = [...prev, entry].slice(-20);
            await sbUpdate("ixl_answers", { id: "eq." + rows[0].id }, {
                wrong_attempts: next,
                updated_at: new Date().toISOString()
            });
        } else {
            await sbUpsert("ixl_answers", {
                question_hash: hash,
                question_stem: (question.stem || "").slice(0, 4000),
                question_type: question.type,
                options: question.options || [],
                correct_answer: null,
                verified: false,
                wrong_attempts: [entry],
                updated_at: new Date().toISOString()
            }, "question_hash");
        }
        console.log(`[cache] logged wrong attempt for ${hash.slice(0, 8)}`);
    } catch (e) {
        console.warn("[cache] wrong-log failed:", e.message);
    }
}

export async function stats() {
    try {
        const rows = await sbSelect("ixl_answers", { select: "verified,hits" });
        const total = rows.length;
        const verified = rows.filter(r => r.verified).length;
        const hits = rows.reduce((s, r) => s + (r.hits || 0), 0);
        return { total, verified, hits };
    } catch (e) {
        return { total: 0, verified: 0, hits: 0 };
    }
}