import {
  buildIancarOneSourceBatch,
  collectIancarOneVehicleList,
  createIancarOneApiClient,
  iancarOneApiConfigFromEnv,
  summarizeJsonShape
} from '../adapters/iancar-one-api.js';

const requested = new Set(process.argv.slice(2));
const allowed = new Set(['--apply-raw', '--inspect-detail-shape']);
if ([...requested].some((arg) => !allowed.has(arg))) {
  throw new Error('UNKNOWN_IANCAR_ONE_OPTION');
}

const config = iancarOneApiConfigFromEnv();
if (!config.apiKey) throw new Error('EANCAR_ONE_API_KEY_REQUIRED');

const capture = await collectIancarOneVehicleList(config);
const batch = buildIancarOneSourceBatch(capture);

const report: Record<string, unknown> = {
  collector: 'freepass-data/iancar-one-api',
  sourceId: batch.source.sourceId,
  origin: capture.origin,
  syncedAt: capture.syncedAt,
  stale: capture.stale,
  total: capture.total,
  pages: capture.pages,
  sourceDigest: capture.sourceDigest,
  coverage: batch.coverage,
  issues: capture.issues,
  canonicalPublication: 'NOT_AUTHORIZED_BY_RAW_COLLECTION',
  consumerReadback: 'NOT_VERIFIED'
};

if (requested.has('--inspect-detail-shape') && capture.records.length) {
  const vehicleId = capture.records[0]!.vehicleId;
  const client = createIancarOneApiClient(config);
  const [detail, availability, rates] = await Promise.all([
    client.getVehicle(vehicleId),
    client.getAvailability(vehicleId),
    client.getRates(vehicleId)
  ]);
  report.schema = {
    listItem: summarizeJsonShape(capture.records[0]!.payload),
    detail: summarizeJsonShape(detail),
    availability: summarizeJsonShape(availability),
    rates: summarizeJsonShape(rates)
  };
}

if (requested.has('--apply-raw')) {
  if (process.env.EANCAR_ONE_RAW_INGEST_APPROVED !== 'true') {
    throw new Error('EANCAR_ONE_RAW_INGEST_APPROVED=true required');
  }
  if (!capture.readyForRawIngest) {
    throw new Error('EANCAR_ONE_SOURCE_NOT_READY_FOR_RAW_INGEST');
  }
  const { createSourceIngestDataAccessRuntime } = await import('./data-access-runtime.js');
  const runtime = await createSourceIngestDataAccessRuntime();
  const run = await runtime.ingestRawBatch(batch);
  report.rawIngest = {
    runId: run.runId,
    status: run.status,
    headStatus: run.headStatus,
    rawCount: run.rawCount,
    observedAt: run.observedAt ?? null
  };
}

report.status = capture.issues.length
  ? 'HOLD_SOURCE_REVIEW'
  : requested.has('--apply-raw')
    ? 'RAW_INGESTED_NOT_CANONICAL'
    : 'OBSERVED_NOT_PUBLISHED';

console.log(JSON.stringify(report, null, 2));
if (capture.issues.length) process.exitCode = 2;
