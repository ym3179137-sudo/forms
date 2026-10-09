export const APP_CATALOG = [
    { id: "ixl", label: "IXL", url: "https://www.ixl.com/", icon: "📘" },
    { id: "blooket", label: "Blooket", url: "https://www.blooket.com/", icon: "🎮" },
    { id: "wayground", label: "Wayground", url: "https://wayground.com/", icon: "⚡" },
    { id: "forms", label: "Google Forms", url: "https://docs.google.com/forms/", icon: "📝" },
    { id: "unblock", label: "Unblock (any URL)", url: null, icon: "🔓" }
];

export function userCanUseApp(user, appId) {
    if (!user) return false;
    if (user.role === "owner") return true;
    const apps = user.apps || [];
    if (apps.includes("*")) return true;
    return apps.includes(appId);
}

export function filterAppsForUser(user) {
    if (!user) return [];
    if (user.role === "owner" || (user.apps || []).includes("*")) return APP_CATALOG;
    return APP_CATALOG.filter(a => (user.apps || []).includes(a.id));
}

export function normalizeApps(input) {
    if (!input) return ["ixl"];
    if (!Array.isArray(input)) return ["ixl"];
    const valid = new Set(APP_CATALOG.map(a => a.id));
    if (input.includes("*")) return ["*"];
    const cleaned = input.filter(x => valid.has(x));
    return cleaned.length ? cleaned : ["ixl"];
}

export function detectAppFromUrl(url) {
    if (!url) return null;
    if (/ixl\.com/i.test(url)) return "ixl";
    if (/blooket\.com/i.test(url)) return "blooket";
    if (/quizizz\.com|wayground\.com/i.test(url)) return "wayground";
    if (/docs\.google\.com\/forms|forms\.gle/i.test(url)) return "forms";
    return null;
}