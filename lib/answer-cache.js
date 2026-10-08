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

const localCache = new Map();

export async function lookupAnswer(question) {
    try {
        const hash = hashQuestion(question);
        if (localCache.has(hash)) return localCache.get(hash);
        const rows = await sbSelect("ixl_answers", {
            question_hash: "eq." + hash,
            select: "*",
            limit: 1
        });
        if (!rows || !rows.length) return null;
        const row = rows[0];
        if (!row.correct_answer) return null;
        localCache.set(hash, row.correct_answer);
        sbUpdate("ixl_answers", { id: "eq." + row.id }, {
            hits: (row.hits || 0) + 1,
            updated_at: new Date().toISOString()
        }).catch(() => { });
        return row.correct_answer;
    } catch (e) {
        return null;
    }
}

export async function saveAnswer(question, answer, verified) {
    try {
        const hash = hashQuestion(question);
        if (verified) localCache.set(hash, answer);
        await sbUpsert("ixl_answers", {
            question_hash: hash,
            question_stem: (question.stem || "").slice(0, 4000),
            question_type: question.type,
            options: question.options || [],
            correct_answer: verified ? answer : null,
            verified: !!verified,
            updated_at: new Date().toISOString()
        }, "question_hash");
    } catch (e) { }
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
            await sbUpdate("ixl_answers", { id: "eq." + rows[0].id }, {
                wrong_attempts: [...prev, entry].slice(-20),
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
    } catch (e) { }
}