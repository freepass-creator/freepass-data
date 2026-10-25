import { GeoPoint, Timestamp } from 'firebase-admin/firestore';
/** Typed private-backup encoding for Firestore values (사진·정책 연결·카톡 실시간 포트 백업 공용). */
export function encodeIancarBackupValue(value) {
    if (value === undefined || (typeof value === 'number' && !Number.isFinite(value)))
        throw new Error('IANCAR_BACKUP_UNSUPPORTED_SCALAR');
    if (value instanceof Timestamp)
        return { type: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
    if (value instanceof GeoPoint)
        return { type: 'geopoint', latitude: value.latitude, longitude: value.longitude };
    if (Buffer.isBuffer(value) || value instanceof Uint8Array)
        return { type: 'bytes', base64: Buffer.from(value).toString('base64') };
    if (Array.isArray(value))
        return { type: 'array', values: value.map(encodeIancarBackupValue) };
    if (value && typeof value === 'object') {
        if ('path' in value && value.constructor.name === 'DocumentReference')
            throw new Error('IANCAR_BACKUP_REFERENCE_REQUIRES_EXPLICIT_PROJECT_ENCODING');
        if (Object.getPrototypeOf(value) !== Object.prototype)
            throw new Error('IANCAR_BACKUP_UNSUPPORTED_TYPE');
        return { type: 'object', values: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeIancarBackupValue(item)])) };
    }
    return { type: 'scalar', value };
}
export function decodeIancarBackupValue(value, reference) {
    if (!value || typeof value !== 'object')
        throw new Error('IANCAR_BACKUP_UNKNOWN_TYPE');
    if (value.type === 'timestamp')
        return new Timestamp(value.seconds, value.nanoseconds);
    if (value.type === 'geopoint')
        return new GeoPoint(value.latitude, value.longitude);
    if (value.type === 'bytes')
        return Buffer.from(value.base64, 'base64');
    if (value.type === 'array')
        return value.values.map((item) => decodeIancarBackupValue(item, reference));
    if (value.type === 'object')
        return Object.fromEntries(Object.entries(value.values).map(([key, item]) => [key, decodeIancarBackupValue(item, reference)]));
    if (value.type === 'scalar')
        return value.value;
    throw new Error('IANCAR_BACKUP_UNKNOWN_TYPE');
}
