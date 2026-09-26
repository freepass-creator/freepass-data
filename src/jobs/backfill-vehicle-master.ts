import { createVehicleMasterSourceParsers } from '../adapters/vehicle-master-parser-registry.js';
import {
  buildRecentFirstBackfillQueue,
  buildVehicleMasterBackfillCompletionIndex,
  discoverAdditionalVehicleMasterInventoryPages,
  discoverVehicleMasterInventoryExpectedCount,
  discoverVehicleMasterPages,
  shouldSkipVehicleMasterBackfillPage,
} from '../application/vehicle-master-backfill.js';
import {
  buildVehicleMasterCoverage,
  buildVehicleMasterCoverageFromEvidence,
} from '../application/vehicle-master-coverage.js';
import { persistFetchedVehicleMasterSource } from '../application/vehicle-master-source-capture.js';
import { parseFetchedVehicleMasterSource } from '../application/vehicle-master-source-parse.js';
import {
  VEHICLE_MASTER_BACKFILL_SOURCES,
  vehicleMasterBackfillPolicy,
  type VehicleMasterBackfillSourceKey,
  type VehicleMasterDiscoveredPage,
} from '../domain/vehicle-master-backfill.js';
import {
  sealVehicleMasterPipelineRecord,
  deterministicVehicleMasterRecordId,
} from '../domain/vehicle-master.js';
import { stableDigest } from '../shared/stable-digest.js';
import { createVehicleMasterJobRuntime } from './data-access-runtime.js';

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

function discoveryPageLimit(raw: string | undefined) {
  const value = raw ? Number(raw) : 100;
  if (!Number.isSafeInteger(value) || value < 1 || value > 500) {
    throw new Error('VEHICLE_MASTER_BACKFILL_DISCOVERY_PAGE_LIMIT must be 1..500');
  }
  return value;
}

function currentTtlHours(raw: string | undefined) {
  const value = raw ? Number(raw) : 24;
  if (!Number.isSafeInteger(value) || value < 1 || value > 720) {
    throw new Error('VEHICLE_MASTER_BACKFILL_CURRENT_TTL_HOURS must be 1..720');
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

const extras = extraPages(process.env.VEHICLE_MASTER_BACKFILL_EXTRA_URLS_JSON);
const selectedSources = [
  ...new Set([
    ...sourceKeys(process.env.VEHICLE_MASTER_BACKFILL_SOURCES),
    ...extras.map((page) => page.sourceKey),
  ]),
];
const limit = batchSize(process.env.VEHICLE_MASTER_BACKFILL_BATCH_SIZE);
const maxDiscoveryPages = discoveryPageLimit(
  process.env.VEHICLE_MASTER_BACKFILL_DISCOVERY_PAGE_LIMIT
);
const currentRecaptureTtlHours = currentTtlHours(
  process.env.VEHICLE_MASTER_BACKFILL_CURRENT_TTL_HOURS
);

const store = createFirestoreVehicleMasterStore();
const existingSources = await store.listSourceDocuments();
const existingNormalized = await store.listPipelineRecordsByKind('NORMALIZED_RECORD');
const completionIndex = buildVehicleMasterBackfillCompletionIndex({
  sources: existingSources,
  normalized: existingNormalized,
});
const manualCompletedUrls = completedUrls(
  process.env.VEHICLE_MASTER_BACKFILL_COMPLETED_URLS_JSON
);
const archive = createFirebaseVehicleMasterSourceArchive();
const fetcher = createHttpVehicleMasterSourceFetcher();
const parsers = createVehicleMasterSourceParsers();

const discovered: VehicleMasterDiscoveredPage[] = [...extras];
const discovery: Array<Record<string, unknown>> = [];

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

  const frontier = [policy.discoveryUrl];
  const seenInventory = new Set<string>();
  let providerDiscovered = 0;

  while (frontier.length && seenInventory.size < maxDiscoveryPages) {
    const inventoryUrl = frontier.shift()!;
    if (seenInventory.has(inventoryUrl)) continue;
    seenInventory.add(inventoryUrl);

    try {
      const fetched = await fetcher.fetch(inventoryUrl);
      const pages = discoverVehicleMasterPages({
        sourceKey,
        inventoryUrl: fetched.finalUrl,
        bytes: fetched.bytes,
      });
      discovered.push(...pages);
      providerDiscovered += pages.length;

      const expectedItemCount = discoverVehicleMasterInventoryExpectedCount({
        sourceKey,
        bytes: fetched.bytes,
      });
      const discoveredVehicleCount = sourceKey === 'CARISYOU'
        ? new Set(
            pages
              .map((page) => page.sourceUrl.match(/\/car\/(\d+)/)?.[1] ?? null)
              .filter((value): value is string => Boolean(value))
          ).size
        : pages.length;
      const partialDiscovery =
        expectedItemCount !== null &&
        discoveredVehicleCount < expectedItemCount;

      for (const nextUrl of discoverAdditionalVehicleMasterInventoryPages({
        sourceKey,
        inventoryUrl: fetched.finalUrl,
        bytes: fetched.bytes,
      })) {
        if (!seenInventory.has(nextUrl) && !frontier.includes(nextUrl)) {
          frontier.push(nextUrl);
        }
      }

      if (partialDiscovery && sourceKey === 'CARISYOU') {
        const mobile = new URL(fetched.finalUrl);
        if (mobile.hostname !== 'm.carisyou.com') {
          mobile.hostname = 'm.carisyou.com';
          const mobileUrl = mobile.toString();
          if (!seenInventory.has(mobileUrl) && !frontier.includes(mobileUrl)) {
            frontier.push(mobileUrl);
          }
        }
      }

      discovery.push({
        sourceKey,
        discoveryUrl: fetched.finalUrl,
        status: partialDiscovery ? 'DISCOVERY_PARTIAL' : 'DISCOVERED',
        discoveredCount: pages.length,
        discoveredVehicleCount,
        expectedItemCount,
      });
    } catch (error) {
      discovery.push({
        sourceKey,
        discoveryUrl: inventoryUrl,
        status: 'DISCOVERY_HOLD',
        discoveredCount: 0,
        errorCode: errorCode(error),
      });
    }
  }

  discovery.push({
    sourceKey,
    discoveryUrl: policy.discoveryUrl,
    status: frontier.length ? 'DISCOVERY_PAGE_LIMIT' : 'DISCOVERY_COMPLETE',
    inventoryPageCount: seenInventory.size,
    discoveredCount: providerDiscovered,
  });
}

const coverageBefore = buildVehicleMasterCoverageFromEvidence({
  sources: existingSources,
  normalized: existingNormalized,
});
const autoCompletedUrls = discovered
  .filter((page) => shouldSkipVehicleMasterBackfillPage({
    page,
    completions: completionIndex,
    parsers,
    now: observedAt,
    currentTtlHours: currentRecaptureTtlHours,
  }))
  .map((page) => page.sourceUrl);
const skipUrls = [
  ...new Set([
    ...manualCompletedUrls,
    ...autoCompletedUrls,
  ]),
];
const queue = buildRecentFirstBackfillQueue(discovered, {
  completedUrls: skipUrls,
  sourceKeys: selectedSources,
  coverage: coverageBefore,
}).slice(0, limit);

const results: Array<Record<string, unknown>> = [];
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
        coverageStatusBefore: task.coverageStatus,
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
        coverageStatusBefore: task.coverageStatus,
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
      coverageStatusBefore: task.coverageStatus,
      status: 'FETCH_HOLD',
      errorCode: errorCode(error),
    });
  }
}

const coverageAfter = await buildVehicleMasterCoverage(store);
const coverageCounts = (rows: typeof coverageAfter) =>
  Object.fromEntries(
    ['OFFICIAL', 'CORROBORATED', 'SINGLE_SOURCE', 'DISCOVERY_ONLY']
      .map((status) => [
        status,
        rows.filter((row) => row.status === status).length,
      ])
  );

const auditPayload = {
  observedAt,
  selectedSources,
  currentRecaptureTtlHours,
  manualCompletedUrlCount: manualCompletedUrls.length,
  autoCompletedUrlCount: autoCompletedUrls.length,
  queued: queue.length,
  parsed: results.filter((row) => row.status === 'PARSED').length,
  capturedHold: results.filter((row) => row.status === 'CAPTURED_HOLD').length,
  fetchHold: results.filter((row) => row.status === 'FETCH_HOLD').length,
  coverageBefore: {
    rowCount: coverageBefore.length,
    statusCounts: coverageCounts(coverageBefore),
    digest: stableDigest(coverageBefore),
  },
  coverageAfter: {
    rowCount: coverageAfter.length,
    statusCounts: coverageCounts(coverageAfter),
    digest: stableDigest(coverageAfter),
  },
};
const auditRecord = sealVehicleMasterPipelineRecord({
  recordId: deterministicVehicleMasterRecordId('backfill-audit', {
    observedAt,
    auditDigest: stableDigest(auditPayload),
  }),
  kind: 'AUDIT_REPORT',
  sourceDocumentId: null,
  observedAt,
  payload: auditPayload,
});
const auditWrite = await store.putPipelineRecord(auditRecord);

const summary = {
  observedAt,
  selectedSources,
  batchSize: limit,
  discoveryPageLimit: maxDiscoveryPages,
  currentRecaptureTtlHours,
  discovery,
  totalDiscovered: discovered.length,
  skippedByParserVersionAndTtl: autoCompletedUrls.length,
  queued: queue.length,
  parsed: results.filter((row) => row.status === 'PARSED').length,
  capturedHold: results.filter((row) => row.status === 'CAPTURED_HOLD').length,
  fetchHold: results.filter((row) => row.status === 'FETCH_HOLD').length,
  coverageBefore: auditPayload.coverageBefore,
  coverageAfter: auditPayload.coverageAfter,
  auditReportId: auditRecord.recordId,
  auditWrite,
  results,
  parsedUrlsThisRun: results
    .filter((row) => row.status === 'PARSED')
    .map((row) => row.sourceUrl)
    .filter((value): value is string => typeof value === 'string')
    .sort(),
};

process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
