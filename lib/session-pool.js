const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "3", 10);
const QUEUE_TIMEOUT_MS = 5 * 60 * 1000; // 5 min max wait

const active = new Map();  // sessionId -> { startedAt }
const waiting = [];        // { sessionId, resolve, reject, timer }

export function getStatus() {
    return {
        active: active.size,
        queued: waiting.length,
        max: MAX_CONCURRENT
    };
}

export function acquire(sessionId) {
    return new Promise((resolve, reject) => {
        if (active.size < MAX_CONCURRENT) {
            active.set(sessionId, { startedAt: Date.now() });
            return resolve({ position: 0 });
        }
        const timer = setTimeout(() => {
            const idx = waiting.findIndex(w => w.sessionId === sessionId);
            if (idx >= 0) waiting.splice(idx, 1);
            reject(new Error("queue timeout"));
        }, QUEUE_TIMEOUT_MS);
        waiting.push({ sessionId, resolve, reject, timer });
    });
}

export function release(sessionId) {
    if (!active.has(sessionId)) return;
    active.delete(sessionId);
    // promote next in queue
    if (waiting.length > 0) {
        const next = waiting.shift();
        clearTimeout(next.timer);
        active.set(next.sessionId, { startedAt: Date.now() });
        next.resolve({ position: 0 });
    }
}

export function queuePosition(sessionId) {
    const idx = waiting.findIndex(w => w.sessionId === sessionId);
    return idx < 0 ? 0 : idx + 1;
}