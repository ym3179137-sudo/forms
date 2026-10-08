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
        console.warn("[keys] supabase unavailable, using env");
    }
    return cache;
}

export async function getSecret(name) {
    const c = await loadSecrets();
    if (c.has(name)) return c.get(name);
    return process.env[name] || "";
}