export async function ensureInjected() {
    console.log("[inject] disabled — per-session injection is active in session-manager");
    return true;
}