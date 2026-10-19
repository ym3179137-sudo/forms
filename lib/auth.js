import crypto from "crypto";
import { sbSelect, sbUpsert, sbUpdate } from "./supabase.js";
import { getSecret } from "./keys.js";
import { verifySSO } from "./sso.js";
import { getUser } from "./users.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Local session tokens (issued by this server after SSO or password check)
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

// Direct login is DISABLED. Users only come in through CyberVault via SSO.
export async function login() {
    return null;
}

export async function signup() {
    return { ok: false, error: "sign up on CyberVault, not here" };
}

// The ONLY entry point.
export async function ssoLogin(t, s) {
    const payload = await verifySSO(t, s);
    if (!payload || !payload.username) return { ok: false, error: "invalid sso token" };

    const { username } = payload;

    // Look up in profiles. If not there, they haven't signed up on CyberVault.
    const user = await getUser(username);
    if (!user) {
        return { ok: false, error: "user not found — sign up on CyberVault first" };
    }
    if (user.banned) {
        return { ok: false, error: "account banned" };
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

// IXL creds live in ixl_users table
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