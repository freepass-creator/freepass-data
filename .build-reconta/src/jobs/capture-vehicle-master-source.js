import { captureVehicleMasterSource } from '../application/vehicle-master-source-capture.js';
import { createVehicleMasterJobRuntime } from './data-access-runtime.js';
const SOURCE_TYPES = new Set([
    'MANUFACTURER_OFFICIAL',
    'PUBLIC_CERTIFIED',
    'STRUCTURED_PROVIDER',
    'DANAWA',
    'CARNOON',
    'CARISYOU',
    'WIKICAR',
    'MARKET_LISTING',
    'MANUAL',
    'OTHER',
]);
function parseRequest(raw) {
    if (!raw)
        throw new Error('VEHICLE_MASTER_CAPTURE_JSON is required');
    const value = JSON.parse(raw);
    if (typeof value.sourceType !== 'string' ||
        !SOURCE_TYPES.has(value.sourceType)) {
        throw new Error('Invalid vehicle master sourceType');
    }
    if (typeof value.sourceName !== 'string' || !value.sourceName.trim()) {
        throw new Error('Invalid vehicle master sourceName');
    }
    if (typeof value.sourceUrl !== 'string' || !value.sourceUrl.trim()) {
        throw new Error('Invalid vehicle master sourceUrl');
    }
    if (typeof value.observedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.observedAt))) {
        throw new Error('Invalid vehicle master observedAt');
    }
    const request = {
        sourceType: value.sourceType,
        sourceName: value.sourceName,
        sourceUrl: value.sourceUrl,
        observedAt: value.observedAt,
    };
    if (typeof value.publishedAt === 'string' || value.publishedAt === null) {
        request.publishedAt = value.publishedAt;
    }
    if (typeof value.effectiveFrom === 'string' || value.effectiveFrom === null) {
        request.effectiveFrom = value.effectiveFrom;
    }
    if (typeof value.effectiveTo === 'string' || value.effectiveTo === null) {
        request.effectiveTo = value.effectiveTo;
    }
    if (value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)) {
        request.metadata = value.metadata;
    }
    return request;
}
const input = parseRequest(process.env.VEHICLE_MASTER_CAPTURE_JSON);
const { store, archive, fetcher } = createVehicleMasterJobRuntime();
const result = await captureVehicleMasterSource({ fetcher, archive, store }, input);
process.stdout.write(JSON.stringify({
    sourceDocumentId: result.sourceDocument.sourceDocumentId,
    sourceType: result.sourceDocument.sourceType,
    sourceUrl: result.sourceDocument.sourceUrl,
    storagePath: result.sourceDocument.storagePath,
    sha256: result.sourceDocument.sha256,
    hashId: result.hashRecord.hashId,
    archiveWrite: result.archiveWrite,
    documentWrite: result.documentWrite,
    hashWrite: result.hashWrite,
}, null, 2) + '\n');
