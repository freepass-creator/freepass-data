import { deterministicVehicleMasterRecordId, sealVehicleMasterHashRecord, sealVehicleMasterSourceDocument, } from '../domain/vehicle-master.js';
import { sha256Bytes } from '../shared/binary-digest.js';
function extension(contentType, url) {
    const normalized = String(contentType ?? '').toLowerCase();
    if (normalized.includes('application/pdf'))
        return 'pdf';
    if (normalized.includes('application/json'))
        return 'json';
    if (normalized.includes('text/html'))
        return 'html';
    if (normalized.includes('text/plain'))
        return 'txt';
    const pathname = new URL(url).pathname.toLowerCase();
    for (const ext of ['pdf', 'json', 'html', 'htm', 'txt']) {
        if (pathname.endsWith(`.${ext}`))
            return ext === 'htm' ? 'html' : ext;
    }
    return 'bin';
}
function stringMetadata(value) {
    return Object.fromEntries(Object.entries(value)
        .filter(([, child]) => typeof child === 'string' ||
        typeof child === 'number' ||
        typeof child === 'boolean')
        .map(([key, child]) => [key, String(child)]));
}
export async function persistFetchedVehicleMasterSource(dependencies, input, fetched) {
    const sha256 = sha256Bytes(fetched.bytes);
    const sourceDocumentId = deterministicVehicleMasterRecordId('srcdoc', {
        sourceType: input.sourceType,
        requestedUrl: fetched.requestedUrl,
        finalUrl: fetched.finalUrl,
        sha256,
        observedAt: input.observedAt,
    });
    const ext = extension(fetched.contentType, fetched.finalUrl);
    const storagePath = `vehicle-master/source-documents/${input.sourceType.toLowerCase()}/${sha256}.${ext}`;
    const archiveInput = {
        storagePath,
        bytes: fetched.bytes,
        expectedSha256: sha256,
        contentType: fetched.contentType,
        metadata: {
            sourceDocumentId,
            sourceType: input.sourceType,
            requestedUrl: fetched.requestedUrl,
            finalUrl: fetched.finalUrl,
            ...stringMetadata(input.metadata ?? {}),
        },
    };
    const archiveWrite = await dependencies.archive.archive(archiveInput);
    const sourceDocument = sealVehicleMasterSourceDocument({
        sourceDocumentId,
        sourceType: input.sourceType,
        sourceName: input.sourceName,
        sourceUrl: fetched.finalUrl,
        publishedAt: input.publishedAt ?? null,
        observedAt: input.observedAt,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveTo: input.effectiveTo ?? null,
        storagePath,
        sha256,
        mimeType: fetched.contentType,
        metadata: {
            ...(input.metadata ?? {}),
            requestedUrl: fetched.requestedUrl,
            finalUrl: fetched.finalUrl,
            httpStatus: fetched.status,
            byteLength: fetched.bytes.byteLength,
        },
    });
    const documentWrite = await dependencies.store.putSourceDocument(sourceDocument);
    const hashRecord = sealVehicleMasterHashRecord({
        hashId: deterministicVehicleMasterRecordId('hash', {
            scope: 'SOURCE_BYTES',
            sourceDocumentId,
            algorithm: 'SHA-256',
            digest: sha256,
        }),
        scope: 'SOURCE_BYTES',
        algorithm: 'SHA-256',
        digest: sha256,
        sourceDocumentId,
        targetId: null,
        storagePath,
        byteLength: fetched.bytes.byteLength,
        mimeType: fetched.contentType,
        observedAt: input.observedAt,
        metadata: {
            sourceType: input.sourceType,
            sourceUrl: fetched.finalUrl,
        },
    });
    const hashWrite = await dependencies.store.putHash(hashRecord);
    return { sourceDocument, hashRecord, archiveWrite, documentWrite, hashWrite };
}
export async function captureVehicleMasterSource(dependencies, input) {
    const fetched = await dependencies.fetcher.fetch(input.sourceUrl);
    return persistFetchedVehicleMasterSource({ archive: dependencies.archive, store: dependencies.store }, input, fetched);
}
