import { sbSelect, sbUpsert, sbUpdate } from "./supabase.js";
import { normalizeApps } from "./apps.js";

const DEFAULT_TRIAL_HOURS = 24;

export async function getUser(username) {
    const rows = await sbSelect("ixl_users_auth", {
        username: "eq." + username,
        select: "*",
        limit: 1
    });
    if (!rows || !rows.length) return null;
    const u = rows[0];
    let apps = u.apps;
    if (typeof apps === "string") {
        try { apps = JSON.parse(apps); } catch (_) { apps = ["ixl"]; }
    }
    if (!Array.isArray(apps)) apps = ["ixl"];
    return {
        username: u.username,
        email: u.email || "",
        sso: !!u.sso,
        role: u.role || "user",
        expiresAt: u.expires_at ? new Date(u.expires_at).getTime() : null,
        totalPaidMs: u.total_paid_ms || 0,
        createdAt: u.created_at ? new Date(u.created_at).getTime() : null,
        note: u.note || "",
        apps
    };
}

export function isExpired(user) {
    if (!user) return true;
    if (user.role === "owner") return false;
    if (user.expiresAt == null) return true;
    return Date.now() > user.expiresAt;
}

export function timeLeftMs(user) {
    if (!user || user.role === "owner") return null;
    if (user.expiresAt == null) return 0;
    return Math.max(0, user.expiresAt - Date.now());
}

export async function createUser(username, password, email = "", role = "user", hours = DEFAULT_TRIAL_HOURS, apps = ["ixl"]) {
    const existing = await getUser(username);
    if (existing) throw new Error("user already exists");

    const now = Date.now();
    const expiresAt = role === "owner" ? null : new Date(now + hours * 3600 * 1000).toISOString();
    const cleanApps = role === "owner" ? ["*"] : normalizeApps(apps);

    await sbUpsert("ixl_users_auth", {
        username,
        password,
        email: email || "",
        role,
        expires_at: expiresAt,
        total_paid_ms: 0,
        apps: cleanApps,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    }, "username");

    return getUser(username);
}

export async function addTime(username, hours, note = "") {
    const user = await getUser(username);
    if (!user) throw new Error("user not found");

    const now = Date.now();
    const base = user.expiresAt && user.expiresAt > now ? user.expiresAt : now;
    const newExpiresAt = new Date(base + hours * 3600 * 1000).toISOString();
    const addedMs = hours * 3600 * 1000;

    await sbUpdate("ixl_users_auth", { username: "eq." + username }, {
        expires_at: newExpiresAt,
        total_paid_ms: (user.totalPaidMs || 0) + addedMs,
        note: note || user.note || "",
        updated_at: new Date().toISOString()
    });

    return getUser(username);
}

export async function setExpiry(username, isoDate) {
    await sbUpdate("ixl_users_auth", { username: "eq." + username }, {
        expires_at: isoDate,
        updated_at: new Date().toISOString()
    });
    return getUser(username);
}

export async function setRole(username, role) {
    await sbUpdate("ixl_users_auth", { username: "eq." + username }, {
        role,
        updated_at: new Date().toISOString()
    });
    return getUser(username);
}

export async function setApps(username, apps) {
    const clean = normalizeApps(apps);
    await sbUpdate("ixl_users_auth", { username: "eq." + username }, {
        apps: clean,
        updated_at: new Date().toISOString()
    });
    return getUser(username);
}

export async function listUsers() {
    const rows = await sbSelect("ixl_users_auth", {
        select: "username,email,role,expires_at,total_paid_ms,created_at,note,apps",
        order: "created_at.desc",
        limit: 500
    });
    return (rows || []).map(u => {
        let apps = u.apps;
        if (typeof apps === "string") {
            try { apps = JSON.parse(apps); } catch (_) { apps = ["ixl"]; }
        }
        if (!Array.isArray(apps)) apps = ["ixl"];
        return {
            username: u.username,
            email: u.email || "",
            role: u.role || "user",
            expiresAt: u.expires_at ? new Date(u.expires_at).getTime() : null,
            totalPaidMs: u.total_paid_ms || 0,
            createdAt: u.created_at ? new Date(u.created_at).getTime() : null,
            note: u.note || "",
            apps
        };
    });
}

export async function deleteUser(username) {
    await sbUpdate("ixl_users_auth", { username: "eq." + username }, {
        expires_at: new Date(0).toISOString(),
        role: "deleted",
        updated_at: new Date().toISOString()
    });
}