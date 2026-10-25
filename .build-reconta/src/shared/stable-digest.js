import { createHash } from 'node:crypto';
export function orderedJsonDigest(value) {
    return createHash('sha256')
        .update(JSON.stringify(value))
        .digest('hex');
}
export function stableValue(value) {
    if (Array.isArray(value))
        return value.map(stableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            // Preserve the existing en-US producer order across Windows/CI host locales.
            .sort(([a], [b]) => a.localeCompare(b, 'en-US'))
            .map(([key, child]) => [key, stableValue(child)]));
    }
    return value;
}
export function stableDigest(value) {
    return createHash('sha256')
        .update(JSON.stringify(stableValue(value)))
        .digest('hex');
}
export function compactFirestoreDocumentIdPart(value) {
    const safe = value.replace(/[\/#?[\]*]/g, '_');
    if (safe.length <= 180)
        return safe;
    const hash = createHash('sha256').update(value).digest('hex');
    return `${safe.slice(0, 100)}__sha256_${hash}`;
}
export function stableRecordSetDigest(values) {
    return stableDigest([...values].sort((a, b) => a.lineageRecordId.localeCompare(b.lineageRecordId, 'en-US')));
}
