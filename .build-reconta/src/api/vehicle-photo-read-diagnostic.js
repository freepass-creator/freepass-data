import { PHOTO_READ_FAILURE_PHASES, PHOTO_READ_FAILURE_REASONS } from '../domain/consumer-output-contract.js';
/** Copy only own data values. Never traverse errors, identifiers or caller metadata. */
export function serializeVehiclePhotoReadFailure(input) {
    try {
        if (!input || typeof input !== 'object')
            return undefined;
        const value = (key) => {
            const descriptor = Object.getOwnPropertyDescriptor(input, key);
            return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
        };
        const operation = value('operation'), phase = value('phase'), reason = value('reason');
        const elapsedMs = value('elapsedMs'), phaseElapsedMs = value('phaseElapsedMs');
        if (operation !== 'INDEXED' && operation !== 'MANIFEST')
            return undefined;
        if (!PHOTO_READ_FAILURE_PHASES.includes(phase)
            || !PHOTO_READ_FAILURE_REASONS.includes(reason))
            return undefined;
        const timing = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 300000;
        if (!timing(elapsedMs) || !timing(phaseElapsedMs))
            return undefined;
        return Object.freeze({ event: 'vehicle_photo_read_failure', operation,
            phase: phase, reason: reason, elapsedMs, phaseElapsedMs });
    }
    catch {
        return undefined;
    }
}
/** Best-effort observation; sink failure cannot replace the original reader result. */
export function createVehiclePhotoReadFailureObserver(sink = diagnostic => { console.log(JSON.stringify(diagnostic)); }) {
    return failure => {
        try {
            const diagnostic = serializeVehiclePhotoReadFailure(failure);
            if (!diagnostic)
                return;
            const result = sink(diagnostic);
            if (result !== undefined)
                void Promise.resolve(result).catch(() => { });
        }
        catch { /* Preserve the original reader error or false revalidation result. */ }
    };
}
