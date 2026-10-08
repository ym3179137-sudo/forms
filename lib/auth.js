import crypto from "crypto";
import { sbSelect, sbUpsert } from "./supabase.js";
import { getSecret } from "./keys.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function parseUsers() {
    const raw = (await getSecret("USERS")) || "";
    const map = new Map();
    for (const pair of raw.split(",")) {
        const [u, p] = pair.trim().split(":");
        if (u && p) map.set(u.trim(), p);
    }
    return map;
}

export async function login(username, password) {
    if (!username || !password) return null;
    const users = await parseUsers();
    const expected = users.get(username);
    if (!expected || expected !== password) return null;
    const secret = (await getSecret("SESSION_SECRET")) || "dev-secret";
    const payload = { u: username, exp: Date.now() + SESSION_TTL_MS };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    return body + "." + sig;
}

export async function verify(token) {
    if (!token || typeof token !== "string") return null;
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const secret = (await getSecret("SESSION_SECRET")) || "dev-secret";
    const expectedSig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    if (sig !== expectedSig) return null;
    try {
        const payload = JSON.parse(Buffer.from(body, "base64url").toString());
        if (!payload.exp || Date.now() > payload.exp) return null;
        return payload;
    } catch { return null; }
}

export async function getIxlCreds(username) {
    try {
        const rows = await sbSelect("ixl_users", {
            username: "eq." + username,
            select: "ixl_email,ixl_password",
            limit: 1
        });
        if (!rows.length) return null;
        return { email: rows[0].ixl_email || "", password: rows[0].ixl_password || "" };
    } catch { return null; }
}

export async function saveIxlCreds(username, email, password) {
    try {
        await sbUpsert("ixl_users", {
            username,
            ixl_email: email || "",
            ixl_password: password || "",
            updated_at: new Date().toISOString()
        }, "username");
        return true;
    } catch (e) {
        console.warn("[ixl-creds] save failed:", e.message);
        return false;
    }
}