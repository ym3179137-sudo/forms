import { sbSelect } from "./supabase.js";

const cache = new Map();
let loadedAt = 0;
const TTL_MS = 60 * 1000;

export async function loadSecrets() {
    const now = Date.now();
    if (cache.size > 0 && (now - loadedAt) < TTL_MS) return cache;

    try {
        const rows = await sbSelect("app_secrets", { select: "name,value" });
        cache.clear();
        for (const r of rows) cache.set(r.name, r.value);
        loadedAt = now;
        console.log(`[keys] loaded ${cache.size} secrets from supabase`);
    } catch (err) {
        console.warn("[keys] fallback to env (supabase failed):", err.message);
    }
    return cache;
}

export async function getSecret(name) {
    const c = await loadSecrets();
    if (c.has(name)) return c.get(name);
    return process.env[name] || "";
}

export async function getAllSecrets() {
    const c = await loadSecrets();
    const out = {};
    for (const [k, v] of c.entries()) out[k] = v;
    for (const [k, v] of Object.entries(process.env)) {
        if (!(k in out) && /_KEY$|^USERS$|^SESSION_SECRET$|^SOLVE_SECRET$/.test(k)) out[k] = v;
    }
    return out;
}