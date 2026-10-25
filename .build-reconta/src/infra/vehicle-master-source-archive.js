import { sha256Bytes } from '../shared/binary-digest.js';
import { getStorage } from 'firebase-admin/storage';
import { getTargetFirebaseApp } from './firebase-target.js';
export { sha256Bytes };
function resolveStorageBucket(env = process.env) {
    const bucket = env.FIREBASE_STORAGE_BUCKET?.trim();
    if (!bucket)
        throw new Error('FIREBASE_STORAGE_BUCKET is required for vehicle master source archive');
    if (!/^[a-z0-9][a-z0-9._-]+$/i.test(bucket)) {
        throw new Error('Invalid FIREBASE_STORAGE_BUCKET');
    }
    return bucket;
}
export class FirebaseVehicleMasterSourceArchive {
    async archive(input) {
        const storagePath = input.storagePath.trim();
        if (!storagePath || storagePath.startsWith('/') || storagePath.includes('..')) {
            throw new Error('VEHICLE_MASTER_ARCHIVE_INVALID_PATH');
        }
        const expected = input.expectedSha256.toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(expected)) {
            throw new Error('VEHICLE_MASTER_ARCHIVE_INVALID_SHA256');
        }
        const actual = sha256Bytes(input.bytes);
        if (actual !== expected) {
            throw new Error('VEHICLE_MASTER_ARCHIVE_SHA256_MISMATCH');
        }
        const bucket = getStorage(getTargetFirebaseApp()).bucket(resolveStorageBucket());
        const file = bucket.file(storagePath);
        const [exists] = await file.exists();
        if (exists) {
            const [metadata] = await file.getMetadata();
            const storedSha = String(metadata.metadata?.sha256 ?? '').toLowerCase();
            if (storedSha === expected)
                return 'UNCHANGED';
            throw new Error(`VEHICLE_MASTER_ARCHIVE_PATH_COLLISION:${storagePath}`);
        }
        await file.save(input.bytes, {
            resumable: false,
            metadata: {
                contentType: input.contentType ?? 'application/octet-stream',
                metadata: {
                    ...(input.metadata ?? {}),
                    sha256: expected,
                },
            },
            preconditionOpts: { ifGenerationMatch: 0 },
        });
        return 'CREATED';
    }
}
export function createFirebaseVehicleMasterSourceArchive() {
    return new FirebaseVehicleMasterSourceArchive();
}
