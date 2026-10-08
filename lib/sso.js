import crypto from "crypto";
import { getSecret } from "./keys.js";

function hmacSign(message, secret) {
    return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

// token format: base64(json) + '.' + hex_signature — sent as ?t= and ?s=
// payload shape (from CyberVault): { u: username, site: 'ixl'|'wayground'|'blooket', exp: timestamp }
export async function verifySSO(t, s) {
    if (!t || !s) return null;
    const secret = await getSecret("SSO_SECRET");
    if (!secret) {
        console.warn("[sso] SSO_SECRET not set");
        return null;
    }
    const expected = hmacSign(t, secret);
    if (expected !== s) {
        console.warn("[sso] signature mismatch");
        return null;
    }
    let payload;
    try {
        payload = JSON.parse(Buffer.from(t, "base64").toString("utf8"));
    } catch (e) {
        console.warn("[sso] bad base64/json:", e.message);
        return null;
    }
    if (!payload.exp || Date.now() > payload.exp) {
        console.warn("[sso] token expired");
        return null;
    }
    return {
        username: payload.u || payload.username,
        site: payload.site || "ixl",
        email: payload.email || "",
        sessionId: payload.sid || payload.sessionId || null,
        exp: payload.exp
    };
}