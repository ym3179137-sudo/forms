import crypto from "crypto";
import { sbSelect, sbUpsert } from "./supabase.js";
import { getSecret } from "./keys.js";
import { verifySSO } from "./sso.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const FALLBACK_USERS = {
    "yassinyassinfree": "yourpassword"
};

async function parseUsers() {
    const map = new Map();

    const raw = (await getSecret("USERS")) || "";
    for (const pair of raw.split(",")) {
        const [u, p] = pair.trim().split(":");
        if (u && p) map.set(u.trim(), p);
    }

    for (const [u, p] of Object.entries(FALLBACK_USERS)) {
        if (!map.has(u)) map.set(u, p);
    }

    try {
        const rows = await sbSelect("ixl_users_auth", { select: "username,password" });
        for (const r of rows) {
            if (r.username && r.password && !map.has(r.username)) {
                map.set(r.username, r.password);
            }
        }
    } catch (_) { }

    return map;
}

export async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString("hex");
    const derived = crypto.scryptSync(password, salt, 64).toString("hex");
    return `scrypt$${salt}$${derived}`;
}

export async function verifyPassword(password, stored) {
    if (!stored) return false;
    if (!stored.startsWith("scrypt$")) return password === stored;
    const [, salt, expected] = stored.split("$");
    const derived = crypto.scryptSync(password, salt, 64).toString("hex");
    try {
        return crypto.timingSafeEqual(Buffer.from(derived, "hex"), Buffer.from(expected, "hex"));
    } catch { return false; }
}

async function makeSession(username, extra = {}) {
    const secret = (await getSecret("SESSION_SECRET")) || "dev-secret-change-me";
    const payload = { u: username, exp: Date.now() + SESSION_TTL_MS, ...extra };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
    return body + "." + sig;
}

export async function login(username, password) {
    if (!username || !password) return null;
    const users = await parseUsers();
    const expected = users.get(username);
    if (!expected || expected !== password) {
        try {
            const rows = await sbSelect("ixl_users_auth", {
                username: "eq." + username,
                select: "password",
                limit: 1
            });
            if (rows && rows.length && rows[0].password) {
                const ok = await verifyPassword(password, rows[0].password);
                if (ok) return await makeSession(username);
            }
        } catch (_) { }
        return null;
    }
    return await makeSession(username);
}

export async function signup(username, password, email = "") {
    if (!username || !password) return { ok: false, error: "missing fields" };
    if (username.length < 3) return { ok: false, error: "username too short" };
    if (password.length < 6) return { ok: false, error: "password must be at least 6 characters" };

    try {
        const rows = await sbSelect("ixl_users_auth", {
            username: "eq." + username,
            select: "username",
            limit: 1
        });
        if (rows && rows.length) return { ok: false, error: "username already taken" };
    } catch (_) { }

    const hashed = await hashPassword(password);
    try {
        await sbUpsert("ixl_users_auth", {
            username,
            password: hashed,
            email: email || "",
            role: "user",
            expires_at: new Date(0).toISOString(),
            apps: ["ixl"],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }, "username");
    } catch (err) {
        return { ok: false, error: "storage failed: " + err.message };
    }

    const token = await makeSession(username, { signup: true });
    return { ok: true, token, username };
}

export async function ssoLogin(t, s) {
    const payload = await verifySSO(t, s);
    if (!payload || !payload.username) return { ok: false, error: "invalid sso token" };

    const { username } = payload;

    let existing = null;
    try {
        const rows = await sbSelect("ixl_users_auth", {
            username: "eq." + username,
            select: "username",
            limit: 1
        });
        if (rows && rows.length) existing = rows[0];
    } catch (_) { }

    if (!existing) {
        const random = crypto.randomBytes(32).toString("hex");
        const hashed = await hashPassword(random);
        await sbUpsert("ixl_users_auth", {
            username,
            password: hashed,
            email: payload.email || "",
            role: "user",
            sso: true,
            expires_at: new Date(0).toISOString(),
            apps: ["ixl"],
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        }, "username").catch(() => { });
    }

    const token = await makeSession(username, { sso: true, site: payload.site });
    return { ok: true, token, username, site: payload.site };
}

export async function verify(token) {
    if (!token || typeof token !== "string") return null;
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const secret = (await getSecret("SESSION_SECRET")) || "dev-secret-change-me";
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