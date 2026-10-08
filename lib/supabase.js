import axios from "axios";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "";

const client = axios.create({
    baseURL: SUPABASE_URL + "/rest/v1",
    headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Content-Type": "application/json"
    },
    timeout: 15000,
    validateStatus: s => s >= 200 && s < 500
});

export async function sbSelect(table, params) {
    const res = await client.get("/" + table, { params });
    if (res.status >= 400) throw new Error("supabase select: " + JSON.stringify(res.data).slice(0, 200));
    return res.data;
}

export async function sbUpsert(table, row, onConflict) {
    const res = await client.post("/" + table, row, {
        params: onConflict ? { on_conflict: onConflict } : {},
        headers: { "Prefer": "return=representation,resolution=merge-duplicates" }
    });
    if (res.status >= 400) throw new Error("supabase upsert: " + JSON.stringify(res.data).slice(0, 200));
    return res.data;
}

export async function sbUpdate(table, filter, updates) {
    const res = await client.patch("/" + table, updates, { params: filter });
    if (res.status >= 400) throw new Error("supabase update: " + JSON.stringify(res.data).slice(0, 200));
    return res.data;
}