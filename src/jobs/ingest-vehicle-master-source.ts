import { persistFetchedVehicleMasterSource } from '../application/vehicle-master-source-capture.js';
import { parseFetchedVehicleMasterSource } from '../application/vehicle-master-source-parse.js';
import { createVehicleMasterSourceParsers } from '../adapters/vehicle-master-parser-registry.js';
import { createFirestoreVehicleMasterStore } from '../infra/vehicle-master-firestore-store.js';
import { createFirebaseVehicleMasterSourceArchive } from '../infra/vehicle-master-source-archive.js';
import { createHttpVehicleMasterSourceFetcher } from '../infra/vehicle-master-source-fetcher.js';
import type { CaptureVehicleMasterSourceInput } from '../application/vehicle-master-source-capture.js';
import type { VehicleMasterSourceDocument } from '../domain/vehicle-master.js';

const SOURCE_TYPES = new Set<VehicleMasterSourceDocument['sourceType']>([
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

function parseInput(raw: string | undefined): CaptureVehicleMasterSourceInput {
  if (!raw) throw new Error('VEHICLE_MASTER_CAPTURE_JSON is required');
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (
    typeof value.sourceType !== 'string' ||
    !SOURCE_TYPES.has(value.sourceType as VehicleMasterSourceDocument['sourceType'])
  ) {
    throw new Error('Invalid vehicle master sourceType');
  }
  if (typeof value.sourceName !== 'string' || !value.sourceName.trim()) {
    throw new Error('Invalid vehicle master sourceName');
  }
  if (typeof value.sourceUrl !== 'string' || !value.sourceUrl.trim()) {
    throw new Error('Invalid vehicle master sourceUrl');
  }
  if (
    typeof value.observedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.observedAt))
  ) {
    throw new Error('Invalid vehicle master observedAt');
  }

  const input: CaptureVehicleMasterSourceInput = {
    sourceType: value.sourceType as VehicleMasterSourceDocument['sourceType'],
    sourceName: value.sourceName,
    sourceUrl: value.sourceUrl,
    observedAt: value.observedAt,
  };
  if (typeof value.publishedAt === 'string' || value.publishedAt === null) {
    input.publishedAt = value.publishedAt;
  }
  if (typeof value.effectiveFrom === 'string' || value.effectiveFrom === null) {
    input.effectiveFrom = value.effectiveFrom;
  }
  if (typeof value.effectiveTo === 'string' || value.effectiveTo === null) {
    input.effectiveTo = value.effectiveTo;
  }
  if (value.metadata && typeof value.metadata === 'object' && !Array.isArray(value.metadata)) {
    input.metadata = value.metadata as Record<string, unknown>;
  }
  return input;
}

const input = parseInput(process.env.VEHICLE_MASTER_CAPTURE_JSON);
const store = createFirestoreVehicleMasterStore();
const archive = createFirebaseVehicleMasterSourceArchive();
const fetcher = createHttpVehicleMasterSourceFetcher();

const fetched = await fetcher.fetch(input.sourceUrl);
const captured = await persistFetchedVehicleMasterSource(
  { archive, store },
  input,
  fetched
);
const parsed = await parseFetchedVehicleMasterSource(
  { store, parsers: createVehicleMasterSourceParsers() },
  { sourceDocument: captured.sourceDocument, fetched }
);

process.stdout.write(JSON.stringify({
  sourceDocumentId: captured.sourceDocument.sourceDocumentId,
  sourceType: captured.sourceDocument.sourceType,
  sourceUrl: captured.sourceDocument.sourceUrl,
  storagePath: captured.sourceDocument.storagePath,
  sha256: captured.sourceDocument.sha256,
  archiveWrite: captured.archiveWrite,
  documentWrite: captured.documentWrite,
  parserId: parsed.parserId,
  parserVersion: parsed.parserVersion,
  rawRecordId: parsed.rawRecordId,
  normalizedRecordIds: parsed.normalizedRecordIds,
  summaryRecordId: parsed.summaryRecordId,
  recordCount: parsed.parseResult.records.length,
  warnings: parsed.parseResult.warnings,
}, null, 2) + '\n');
