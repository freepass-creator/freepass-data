import { normalizeVehicleReferenceDataset } from './vehicle-reference-import.js';
import {
  deterministicVehicleMasterRecordId,
  sealVehicleMasterHashRecord,
  sealVehicleMasterPipelineRecord,
  sealVehicleMasterSourceDocument,
} from '../domain/vehicle-master.js';
import { sha256Bytes } from '../shared/binary-digest.js';
import { stableDigest } from '../shared/stable-digest.js';
import type { VehicleMasterSourceArchive } from '../ports/vehicle-master-source-archive.js';
import type { VehicleMasterStore } from '../ports/vehicle-master-store.js';

export async function persistVehicleReferenceDataset(
  dependencies: { store: VehicleMasterStore; archive: VehicleMasterSourceArchive },
  bytes: Buffer
) {
  const dataset = normalizeVehicleReferenceDataset(JSON.parse(bytes.toString('utf8')));
  const sha256 = sha256Bytes(bytes);
  const sourceDocumentId = deterministicVehicleMasterRecordId('srcdoc', {
    schema: dataset.schema,
    sha256,
    observedAt: dataset.observedAt,
    revision: dataset.revision,
  });
  const storagePath = `vehicle-master/reference-import/${sha256}.json`;

  const archiveWrite = await dependencies.archive.archive({
    storagePath,
    bytes,
    expectedSha256: sha256,
    contentType: 'application/json',
    metadata: {
      sourceDocumentId,
      schema: dataset.schema,
      provenanceRefHash: dataset.provenanceRefHash,
      recordCount: String(dataset.records.length),
    },
  });

  const sourceDocument = sealVehicleMasterSourceDocument({
    sourceDocumentId,
    sourceType: 'STRUCTURED_PROVIDER',
    sourceName: 'FreePass Vehicle Reference',
    sourceUrl: null,
    publishedAt: null,
    observedAt: dataset.observedAt,
    effectiveFrom: null,
    effectiveTo: null,
    storagePath,
    sha256,
    mimeType: 'application/json',
    metadata: {
      schema: dataset.schema,
      revision: dataset.revision,
      provenanceRefHash: dataset.provenanceRefHash,
      recordCount: dataset.records.length,
    },
  });
  const sourceWrite = await dependencies.store.putSourceDocument(sourceDocument);

  const hashWrite = await dependencies.store.putHash(sealVehicleMasterHashRecord({
    hashId: deterministicVehicleMasterRecordId('hash', {
      scope: 'SOURCE_BYTES',
      sourceDocumentId,
      digest: sha256,
    }),
    scope: 'SOURCE_BYTES',
    algorithm: 'SHA-256',
    digest: sha256,
    sourceDocumentId,
    targetId: null,
    storagePath,
    byteLength: bytes.byteLength,
    mimeType: 'application/json',
    observedAt: dataset.observedAt,
    metadata: { schema: dataset.schema },
  }));

  const rawWrite = await dependencies.store.putPipelineRecord(sealVehicleMasterPipelineRecord({
    recordId: deterministicVehicleMasterRecordId('raw', { sourceDocumentId, sha256 }),
    kind: 'RAW_RECORD',
    sourceDocumentId,
    observedAt: dataset.observedAt,
    payload: {
      storagePath,
      sha256,
      byteLength: bytes.byteLength,
      schema: dataset.schema,
      revision: dataset.revision,
      provenanceRefHash: dataset.provenanceRefHash,
    },
  }));

  const normalizedIds: string[] = [];
  const normalizedWrites = [];
  for (const record of dataset.records) {
    const recordId = deterministicVehicleMasterRecordId('normalized-reference', {
      sourceDocumentId,
      identityKey: record.identityKey,
      content: stableDigest(record),
    });
    normalizedIds.push(recordId);
    normalizedWrites.push(await dependencies.store.putPipelineRecord(sealVehicleMasterPipelineRecord({
      recordId,
      kind: 'NORMALIZED_RECORD',
      sourceDocumentId,
      observedAt: dataset.observedAt,
      payload: {
        recordKind: 'VEHICLE_REFERENCE_MODEL',
        schema: dataset.schema,
        record,
      },
    })));
  }

  const summaryWrite = await dependencies.store.putPipelineRecord(sealVehicleMasterPipelineRecord({
    recordId: deterministicVehicleMasterRecordId('normalized-summary', {
      sourceDocumentId,
      normalizedIds,
    }),
    kind: 'NORMALIZED_RECORD',
    sourceDocumentId,
    observedAt: dataset.observedAt,
    payload: {
      recordKind: 'VEHICLE_REFERENCE_SUMMARY',
      schema: dataset.schema,
      recordCount: dataset.records.length,
      makerCount: new Set(dataset.records.map((record) => record.maker)).size,
      seriesCount: new Set(dataset.records.map((record) => `${record.maker}\u0000${record.series}`)).size,
      normalizedIds,
    },
  }));

  return {
    sourceDocumentId,
    sha256,
    recordCount: dataset.records.length,
    makerCount: new Set(dataset.records.map((record) => record.maker)).size,
    seriesCount: new Set(dataset.records.map((record) => `${record.maker}\u0000${record.series}`)).size,
    archiveWrite,
    sourceWrite,
    hashWrite,
    rawWrite,
    normalizedWrites,
    summaryWrite,
  };
}
