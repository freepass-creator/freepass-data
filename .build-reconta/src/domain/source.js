export function isValidSourceObservation(observedAt) {
    return Number.isFinite(Date.parse(observedAt));
}
export function canAdvanceSourceHead(candidateObservedAt, currentObservedAt) {
    const candidate = Date.parse(candidateObservedAt);
    if (!Number.isFinite(candidate))
        return false;
    if (!currentObservedAt)
        return true;
    const current = Date.parse(currentObservedAt);
    if (!Number.isFinite(current))
        return false;
    return candidate > current;
}
export function canAssertSourceAbsence(run) {
    return run.status === 'COMPLETED'
        && run.coverage.mode === 'FULL'
        && run.coverage.completeness === 'COMPLETE'
        && run.headStatus === 'CURRENT';
}
export function decideSourceHead(coverage, observedAt, currentObservedAt) {
    const eligible = coverage.completeness === 'COMPLETE'
        && isValidSourceObservation(observedAt);
    const acceptedAsHead = eligible
        && canAdvanceSourceHead(observedAt, currentObservedAt);
    return {
        eligible,
        acceptedAsHead,
        headStatus: acceptedAsHead ? 'CURRENT' : eligible ? 'STALE' : 'INELIGIBLE'
    };
}
