import { createVehicleMasterSourceParsers } from '../adapters/vehicle-master-parser-registry.js';
import {
  buildRecentFirstBackfillQueue,
  discoverVehicleMasterPages,
} from '../application/vehicle-master-backfill.js';
import { persistFetchedVehicleMasterSource } from '../application/vehicle-master-source-capture.js';
import { parseFetchedVehicleMasterSource } from '../application/vehicle-master-source-parse.js';
import {
  VEHICLE_MASTER_BACKFILL_SOURCES,
  vehicleMasterBackfillPolicy,
  type VehicleMasterBackfillSourceKey,
  type VehicleMasterDiscoveredPage,
} from '../domain/vehicle-master-backfill.js';
import { createFirestoreVehicleMasterStore } from '../infra/vehicle-master-firestore-store.js';
import { createFirebaseVehicleMasterSourceArchive } from '../infra/vehicle-master-source-archive.js';
import { createHttpVehicleMasterSourceFetcher } from '../infra/vehicle-master-source-fetcher.js';

function approved() {
  if (process.env.VEHICLE_MASTER_BACKFILL_APPROVED !== 'true') {
    throw new Error('VEHICLE_MASTER_BACKFILL_APPROVED=true required');
  }
}

function batchSize(raw: string | undefined) {
  const value = raw ? Number(raw) : 20;
  if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
    throw new Error('VEHICLE_MASTER_BACKFILL_BATCH_SIZE must be 1..200');
  }
  return value;
}

function sourceKeys(raw: string | undefined): VehicleMasterBackfillSourceKey[] {
  if (!raw?.trim()) {
    return VEHICLE_MASTER_BACKFILL_SOURCES
      .filter((policy) => policy.discoveryUrl && !policy.discoveryOnly)
      .map((policy) => policy.key);
  }
  const values = [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))];
  return values.map((value) => {
    const key = value as VehicleMasterBackfillSourceKey;
    vehicleMasterBackfillPolicy(key);
    return key;
  });
}

function completedUrls(raw: string | undefined) {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== 'string')) {
    throw new Error('VEHICLE_MASTER_BACKFILL_COMPLETED_URLS_JSON must be a string array');
  }
  return parsed;
}

function extraPages(raw: string | undefined): VehicleMasterDiscoveredPage[] {
  if (!raw?.trim()) return [];
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('VEHICLE_MASTER_BACKFILL_EXTRA_URLS_JSON must be an array');
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Invalid extra URL at index ${index}`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row.sourceKey !== 'string' || typeof row.sourceUrl !== 'string') {
      throw new Error(`Invalid extra URL at index ${index}`);
    }
    const policy = vehicleMasterBackfillPolicy(row.sourceKey as VehicleMasterBackfillSourceKey);
    const sourceUrl = new URL(row.sourceUrl).toString();
    const latestModelYearHint =
      typeof row.latestModelYearHint === 'number' &&
      Number.isInteger(row.latestModelYearHint)
        ? row.latestModelYearHint
        : null;
    return {
      sourceKey: policy.key,
      sourceType: policy.sourceType,
      sourceName: policy.sourceName,
      sourceUrl,
      discoveredFromUrl:
        typeof row.discoveredFromUrl === 'string'
          ? row.discoveredFromUrl
          : 'manual-extra-url',
      modelHint: typeof row.modelHint === 'string' ? row.modelHint : null,
      latestModelYearHint,
      currentHint:
        typeof row.currentHint === 'boolean' ? row.currentHint : null,
    };
  });
}

function errorCode(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(':')[0]?.slice(0, 120) || 'UNKNOWN_ERROR';
}

approved();

const observedAt =
  process.env.VEHICLE_MASTER_BACKFILL_OBSERVED_AT?.trim() ||
  new Date().toISOString();
if (!Number.isFinite(Date.parse(observedAt))) {
  throw new Error('Invalid VEHICLE_MASTER_BACKFILL_OBSERVED_AT');
}

const selectedSources = sourceKeys(process.env.VEHICLE_MASTER_BACKFILL_SOURCES);
const limit = batchSize(process.env.VEHICLE_MASTER_BACKFILL_BATCH_SIZE);
const skipUrls = completedUrls(process.env.VEHICLE_MASTER_BACKFILL_COMPLETED_URLS_JSON);

const store = createFirestoreVehicleMasterStore();
const archive = createFirebaseVehicleMasterSourceArchive();
const fetcher = createHttpVehicleMasterSourceFetcher();
const parsers = createVehicleMasterSourceParsers();

const discovered: VehicleMasterDiscoveredPage[] = [
  ...extraPages(process.env.VEHICLE_MASTER_BACKFILL_EXTRA_URLS_JSON),
];
const discovery = [];

for (const sourceKey of selectedSources) {
  const policy = vehicleMasterBackfillPolicy(sourceKey);
  if (!policy.discoveryUrl) {
    discovery.push({
      sourceKey,
      discoveryUrl: null,
      status: 'NO_GENERIC_DISCOVERY_URL',
      discoveredCount: 0,
    });
    continue;
  }

  try {
    const fetched = await fetcher.fetch(policy.discoveryUrl);
    const pages = discoverVehicleMasterPages({
      sourceKey,
      inventoryUrl: fetched.finalUrl,
      bytes: fetched.bytes,
    });
    discovered.push(...pages);
    discovery.push({
      sourceKey,
      discoveryUrl: fetched.finalUrl,
      status: 'DISCOVERED',
      discoveredCount: pages.length,
    });
  } catch (error) {
    discovery.push({
      sourceKey,
      discoveryUrl: policy.discoveryUrl,
      status: 'DISCOVERY_HOLD',
      discoveredCount: 0,
      errorCode: errorCode(error),
    });
  }
}

const queue = buildRecentFirstBackfillQueue(discovered, {
  completedUrls: skipUrls,
  sourceKeys: selectedSources,
}).slice(0, limit);

const results = [];
for (const task of queue) {
  const policy = vehicleMasterBackfillPolicy(task.sourceKey);
  try {
    const fetched = await fetcher.fetch(task.sourceUrl);
    const captured = await persistFetchedVehicleMasterSource(
      { archive, store },
      {
        sourceType: policy.sourceType,
        sourceName: `${policy.sourceName} vehicle backfill`,
        sourceUrl: task.sourceUrl,
        observedAt,
        metadata: {
          backfillTaskId: task.taskId,
          backfillRank: task.rank,
          sourceKey: task.sourceKey,
          discoveredFromUrl: task.discoveredFromUrl,
          modelHint: task.modelHint,
          latestModelYearHint: task.latestModelYearHint,
          currentHint: task.currentHint,
        },
      },
      fetched
    );

    try {
      const parsed = await parseFetchedVehicleMasterSource(
        { store, parsers },
        { sourceDocument: captured.sourceDocument, fetched }
      );
      results.push({
        taskId: task.taskId,
        rank: task.rank,
        sourceKey: task.sourceKey,
        sourceUrl: task.sourceUrl,
        latestModelYearHint: task.latestModelYearHint,
        status: 'PARSED',
        sourceDocumentId: captured.sourceDocument.sourceDocumentId,
        hashId: captured.hashRecord.hashId,
        archiveWrite: captured.archiveWrite,
        documentWrite: captured.documentWrite,
        hashWrite: captured.hashWrite,
        parserId: parsed.parserId,
        parserVersion: parsed.parserVersion,
        recordCount: parsed.parseResult.records.length,
        warnings: parsed.parseResult.warnings,
      });
    } catch (error) {
      results.push({
        taskId: task.taskId,
        rank: task.rank,
        sourceKey: task.sourceKey,
        sourceUrl: task.sourceUrl,
        latestModelYearHint: task.latestModelYearHint,
        status: 'CAPTURED_HOLD',
        sourceDocumentId: captured.sourceDocument.sourceDocumentId,
        hashId: captured.hashRecord.hashId,
        archiveWrite: captured.archiveWrite,
        documentWrite: captured.documentWrite,
        hashWrite: captured.hashWrite,
        errorCode: errorCode(error),
      });
    }
  } catch (error) {
    results.push({
      taskId: task.taskId,
      rank: task.rank,
      sourceKey: task.sourceKey,
      sourceUrl: task.sourceUrl,
      latestModelYearHint: task.latestModelYearHint,
      status: 'FETCH_HOLD',
      errorCode: errorCode(error),
    });
  }
}

const summary = {
  observedAt,
  selectedSources,
  batchSize: limit,
  discovery,
  totalDiscovered: discovered.length,
  queued: queue.length,
  parsed: results.filter((row) => row.status === 'PARSED').length,
  capturedHold: results.filter((row) => row.status === 'CAPTURED_HOLD').length,
  fetchHold: results.filter((row) => row.status === 'FETCH_HOLD').length,
  results,
  nextCompletedUrls: [
    ...new Set([
      ...skipUrls,
      ...results
        .filter((row) => row.status === 'PARSED' || row.status === 'CAPTURED_HOLD')
        .map((row) => row.sourceUrl),
    ]),
  ].sort(),
};

process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
