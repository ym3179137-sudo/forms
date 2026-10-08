import fs from "fs";
import path from "path";
import { sbSelect } from "./supabase.js";

const OUT_DIR = process.env.DATASET_DIR || "/data/dataset";

export async function exportDataset() {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const rows = await sbSelect("ixl_answers", {
        select: "question_stem,question_type,options,correct_answer,hits,wrong_attempts,site,subject",
        verified: "eq.true",
        order: "updated_at.desc",
        limit: 100000
    });

    const examples = [];
    for (const r of rows) {
        if (!r.question_stem || !r.correct_answer) continue;
        const wrongs = Array.isArray(r.wrong_attempts) ? r.wrong_attempts : [];
        if (wrongs.length > 0) continue;

        const instruction = buildInstruction(r);
        const output = JSON.stringify(r.correct_answer);
        examples.push({
            instruction,
            input: "",
            output,
            site: r.site || "ixl",
            type: r.question_type
        });
    }

    const jsonlPath = path.join(OUT_DIR, `dataset-${Date.now()}.jsonl`);
    const fd = fs.openSync(jsonlPath, "w");
    for (const ex of examples) {
        fs.writeSync(fd, JSON.stringify(ex) + "\n");
    }
    fs.closeSync(fd);

    console.log(`[dataset] exported ${examples.length} examples → ${jsonlPath}`);
    return { count: examples.length, path: jsonlPath };
}

function buildInstruction(r) {
    const parts = [];
    parts.push("Solve the following question. Return ONLY valid JSON matching the schema.");
    parts.push("");
    parts.push(`Question type: ${r.question_type}`);
    parts.push(`Question: ${r.question_stem}`);
    if (Array.isArray(r.options) && r.options.length) {
        parts.push("Options:");
        r.options.forEach((o, i) => parts.push(`  ${i}: ${o}`));
    }
    return parts.join("\n");
}