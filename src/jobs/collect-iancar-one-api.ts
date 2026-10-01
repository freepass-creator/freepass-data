import {
  buildIancarOneSourceBatch,
  collectIancarOneVehicleList,
  collectIancarOneFullFacts,
  createIancarOneApiClient,
  iancarOneApiConfigFromEnv,
  projectIancarOnePhaseOne,
  summarizeJsonShape
} from '../adapters/iancar-one-api.js';

const requested = new Set(process.argv.slice(2));
const allowed = new Set(['--apply-raw', '--inspect-detail-shape', '--full-facts', '--save-private', '--phase-one']);
if ([...requested].some((arg) => !allowed.has(arg))) {
  throw new Error('UNKNOWN_IANCAR_ONE_OPTION');
}

const config = iancarOneApiConfigFromEnv();
if (!config.apiKey) throw new Error('EANCAR_ONE_API_KEY_REQUIRED');

const capture = requested.has('--full-facts') || requested.has('--phase-one')
  ? await collectIancarOneFullFacts(config, fetch, new Date().toISOString(), (completed, total) => {
    if (completed % 25 === 0) console.log(JSON.stringify({ phase: 'READING_FULL_FACTS', completed, total }));
  }) : await collectIancarOneVehicleList(config);
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

if (requested.has('--phase-one')) {
  const phaseOne = projectIancarOnePhaseOne(capture);
  report.phaseOne = { stage: phaseOne.stage, policyStage: phaseOne.policyStage,
    publicationAuthorized: phaseOne.publicationAuthorized, vehicleCount: phaseOne.vehicles.length,
    observedRateCount: phaseOne.vehicles.reduce((count, vehicle) => count + vehicle.terms.length, 0),
    stateCounts: phaseOne.vehicles.reduce<Record<string, number>>((counts, vehicle) => {
      counts[vehicle.sourceInventoryStatus] = (counts[vehicle.sourceInventoryStatus] ?? 0) + 1;
      return counts;
    }, {}) };
}

if (requested.has('--save-private')) {
  const { mkdir, writeFile, readFile } = await import('node:fs/promises');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const directory = join(homedir(), '.codex', 'private', 'freepass-data-iancar-one-captures');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${randomUUID()}.json`);
  const bytes = JSON.stringify(capture);
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  if (await readFile(path, 'utf8') !== bytes) throw new Error('IANCAR_PRIVATE_CAPTURE_READBACK_FAILED');
  report.privateCapturePath = path;
}

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
