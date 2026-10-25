function alignedByRevision(legacy, freepass) {
    if (legacy.sourceRevision && freepass.sourceRevision) {
        return legacy.sourceRevision === freepass.sourceRevision;
    }
    return null;
}
function isSettled(checkpoint, nowMs, settledWindowMs) {
    const observedMs = Date.parse(checkpoint.observedAt);
    return Number.isFinite(observedMs) && nowMs - observedMs >= settledWindowMs;
}
export function compareShadow(input) {
    try {
        if (input.legacyCheckpoint.sourceId !== input.freepassCheckpoint.sourceId) {
            return {
                status: 'COMPARISON_ERROR',
                reason: 'SOURCE_ID_MISMATCH',
                missingInFreepass: [],
                extraInFreepass: [],
                changed: []
            };
        }
        const revisionAligned = alignedByRevision(input.legacyCheckpoint, input.freepassCheckpoint);
        if (revisionAligned === false) {
            return {
                status: 'PENDING_LAG',
                reason: 'SOURCE_REVISION_NOT_ALIGNED',
                missingInFreepass: [],
                extraInFreepass: [],
                changed: []
            };
        }
        if (revisionAligned === null) {
            const nowMs = Date.parse(input.now ?? new Date().toISOString());
            if (!isSettled(input.legacyCheckpoint, nowMs, input.settledWindowMs) ||
                !isSettled(input.freepassCheckpoint, nowMs, input.settledWindowMs)) {
                return {
                    status: 'PENDING_LAG',
                    reason: 'SETTLED_WINDOW_NOT_REACHED',
                    missingInFreepass: [],
                    extraInFreepass: [],
                    changed: []
                };
            }
        }
        const legacy = new Map(input.legacyRecords.map((x) => [x.key, x.fingerprint]));
        const freepass = new Map(input.freepassRecords.map((x) => [x.key, x.fingerprint]));
        const missingInFreepass = [...legacy.keys()].filter((key) => !freepass.has(key));
        const extraInFreepass = [...freepass.keys()].filter((key) => !legacy.has(key));
        const changed = [...legacy.entries()]
            .filter(([key, fingerprint]) => freepass.has(key) && freepass.get(key) !== fingerprint)
            .map(([key]) => key);
        if (missingInFreepass.length && input.freepassRecords.length === 0) {
            return {
                status: 'SOURCE_INCOMPLETE',
                reason: 'FREEPASS_SNAPSHOT_EMPTY_WHILE_LEGACY_HAS_DATA',
                missingInFreepass,
                extraInFreepass,
                changed
            };
        }
        const status = missingInFreepass.length || extraInFreepass.length || changed.length
            ? 'TRUE_MISMATCH'
            : 'MATCH';
        return {
            status,
            reason: status === 'MATCH' ? 'PARITY_CONFIRMED' : 'RECORD_PARITY_FAILED',
            missingInFreepass,
            extraInFreepass,
            changed
        };
    }
    catch (error) {
        return {
            status: 'COMPARISON_ERROR',
            reason: error instanceof Error ? error.message : String(error),
            missingInFreepass: [],
            extraInFreepass: [],
            changed: []
        };
    }
}
