const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "3", 10);
const QUEUE_TIMEOUT_MS = 30 * 1000;       // wait max 30s in queue
const SLOT_MAX_AGE_MS = 30 * 60 * 1000;   // force-free stale slots after 30 min

const active = new Map();  // sessionId -> { startedAt }
const waiting = [];        // { sessionId, resolve, reject, timer }

function reapStale() {
    const now = Date.now();
    for (const [id, rec] of active.entries()) {
        if (now - rec.startedAt > SLOT_MAX_AGE_MS) {
            console.warn(`[pool] reaping stale slot ${id} (age ${Math.round((now - rec.startedAt) / 1000)}s)`);
            active.delete(id);
        }
    }
}

export function getStatus() {
    reapStale();
    return { active: active.size, queued: waiting.length, max: MAX_CONCURRENT };
}

export function acquire(sessionId) {
    return new Promise((resolve, reject) => {
        reapStale();

        if (active.size < MAX_CONCURRENT) {
            active.set(sessionId, { startedAt: Date.now() });
            console.log(`[pool] acquired slot ${sessionId} (${active.size}/${MAX_CONCURRENT})`);
            return resolve({ position: 0 });
        }

        console.log(`[pool] queueing ${sessionId} (${active.size}/${MAX_CONCURRENT} active, ${waiting.length} waiting)`);

        const timer = setTimeout(() => {
            const idx = waiting.findIndex(w => w.sessionId === sessionId);
            if (idx >= 0) waiting.splice(idx, 1);
            reject(new Error("queue timeout — try again in a minute"));
        }, QUEUE_TIMEOUT_MS);

        waiting.push({ sessionId, resolve, reject, timer });
    });
}

export function release(sessionId) {
    if (!active.has(sessionId)) {
        console.log(`[pool] release ignored for ${sessionId} (not active)`);
        return;
    }
    active.delete(sessionId);
    console.log(`[pool] released ${sessionId} (${active.size}/${MAX_CONCURRENT} active)`);

    if (waiting.length > 0) {
        reapStale();
        if (active.size < MAX_CONCURRENT) {
            const next = waiting.shift();
            clearTimeout(next.timer);
            active.set(next.sessionId, { startedAt: Date.now() });
            console.log(`[pool] promoted ${next.sessionId} from queue`);
            next.resolve({ position: 0 });
        }
    }
}

export function queuePosition(sessionId) {
    const idx = waiting.findIndex(w => w.sessionId === sessionId);
    return idx < 0 ? 0 : idx + 1;
}