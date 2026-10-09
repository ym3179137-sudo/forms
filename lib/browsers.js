export const BROWSER_FILL_ORDER = ["chrome", "edge", "brave", "firefox"];

export const BROWSERS = {
    chrome: {
        id: "chrome",
        name: "Chrome",
        ramMB: 700,
        maxSessions: 5,
        bin: process.env.CHROME_BIN || "/usr/bin/google-chrome-stable",
        enabled: true
    },
    edge: {
        id: "edge",
        name: "Edge",
        ramMB: 650,
        maxSessions: 2,
        bin: process.env.EDGE_BIN || "/usr/bin/microsoft-edge-stable",
        enabled: true
    },
    brave: {
        id: "brave",
        name: "Brave",
        ramMB: 500,
        maxSessions: 2,
        bin: process.env.BRAVE_BIN || "/usr/bin/brave-browser",
        enabled: true
    },
    firefox: {
        id: "firefox",
        name: "Firefox",
        ramMB: 400,
        maxSessions: 4,
        bin: process.env.FIREFOX_BIN || "/usr/bin/firefox-esr",
        enabled: true
    }
};

export function totalCapacity() {
    return BROWSER_FILL_ORDER
        .map(id => BROWSERS[id])
        .filter(b => b && b.enabled)
        .reduce((sum, b) => sum + b.maxSessions, 0);
}

export function usageByBrowser(sessionsList) {
    const counts = {};
    for (const id of BROWSER_FILL_ORDER) counts[id] = 0;
    for (const s of sessionsList) {
        if (counts[s.browser] !== undefined) counts[s.browser]++;
    }
    return counts;
}

export function pickNextBrowser(sessionsList) {
    const counts = usageByBrowser(sessionsList);
    for (const id of BROWSER_FILL_ORDER) {
        const b = BROWSERS[id];
        if (!b || !b.enabled) continue;
        if (counts[id] < b.maxSessions) return id;
    }
    return null;
}

export function browserFallbackOrder(preferred) {
    const ordered = [];
    if (preferred && BROWSERS[preferred]?.enabled) ordered.push(preferred);
    for (const id of BROWSER_FILL_ORDER) {
        if (id !== preferred && BROWSERS[id]?.enabled) ordered.push(id);
    }
    return ordered;
}

export const APP_BROWSER_PREF = {
    ixl: "any",
    blooket: "any",
    wayground: "any",
    forms: "any",
    unblock: "any"
};

export function browserForApp(appId) {
    const pref = APP_BROWSER_PREF[appId] || "any";
    return pref === "any" ? null : pref;
}