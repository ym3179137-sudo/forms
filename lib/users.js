import { sbSelect, sbUpsert, sbUpdate } from "./supabase.js";
import { normalizeApps } from "./apps.js";

const DEFAULT_TRIAL_HOURS = 24;

export async function getUser(username) {
    if (!username) return null;
    const rows = await sbSelect("profiles", {
        username: "ilike." + username,
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
        id: u.id,
        username: u.username,
        email: u.email || "",
        role: u.role || "user",
        approved: u.approved !== false,
        banned: !!u.banned,
        banReason: u.ban_reason || "",
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
    if (user.banned) return true;
    if (user.expiresAt == null) return true;
    return Date.now() > user.expiresAt;
}

export function timeLeftMs(user) {
    if (!user || user.role === "owner") return null;
    if (user.expiresAt == null) return 0;
    return Math.max(0, user.expiresAt - Date.now());
}

export async function addTime(username, hours, note = "") {
    const user = await getUser(username);
    if (!user) throw new Error("user not found");

    const now = Date.now();
    const base = user.expiresAt && user.expiresAt > now ? user.expiresAt : now;
    const newExpiresAt = new Date(base + hours * 3600 * 1000).toISOString();
    const addedMs = hours * 3600 * 1000;

    await sbUpdate("profiles", { id: "eq." + user.id }, {
        expires_at: newExpiresAt,
        total_paid_ms: (user.totalPaidMs || 0) + addedMs,
        note: note || user.note || "",
        updated_at: new Date().toISOString()
    });

    return getUser(username);
}

export async function setExpiry(username, isoDate) {
    const user = await getUser(username);
    if (!user) throw new Error("user not found");
    await sbUpdate("profiles", { id: "eq." + user.id }, {
        expires_at: isoDate,
        updated_at: new Date().toISOString()
    });
    return getUser(username);
}

export async function setRole(username, role) {
    const user = await getUser(username);
    if (!user) throw new Error("user not found");
    await sbUpdate("profiles", { id: "eq." + user.id }, {
        role,
        updated_at: new Date().toISOString()
    });
    return getUser(username);
}

export async function setApps(username, apps) {
    const user = await getUser(username);
    if (!user) throw new Error("user not found");
    const clean = normalizeApps(apps);
    await sbUpdate("profiles", { id: "eq." + user.id }, {
        apps: clean,
        updated_at: new Date().toISOString()
    });
    return getUser(username);
}

export async function setBanned(username, banned, reason = "") {
    const user = await getUser(username);
    if (!user) throw new Error("user not found");
    await sbUpdate("profiles", { id: "eq." + user.id }, {
        banned: !!banned,
        ban_reason: reason || "",
        updated_at: new Date().toISOString()
    });
    return getUser(username);
}

export async function listUsers() {
    const rows = await sbSelect("profiles", {
        select: "id,username,email,role,approved,banned,ban_reason,expires_at,total_paid_ms,apps,created_at,note",
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
            id: u.id,
            username: u.username,
            email: u.email || "",
            role: u.role || "user",
            approved: u.approved !== false,
            banned: !!u.banned,
            banReason: u.ban_reason || "",
            expiresAt: u.expires_at ? new Date(u.expires_at).getTime() : null,
            totalPaidMs: u.total_paid_ms || 0,
            createdAt: u.created_at ? new Date(u.created_at).getTime() : null,
            note: u.note || "",
            apps
        };
    });
}

export async function deleteUser(username) {
    const user = await getUser(username);
    if (!user) throw new Error("user not found");
    await sbUpdate("profiles", { id: "eq." + user.id }, {
        expires_at: new Date(0).toISOString(),
        role: "deleted",
        banned: true,
        updated_at: new Date().toISOString()
    });
}