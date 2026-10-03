import {
  buildIancarOneSourceBatch,
  collectIancarOneVehicleList,
  collectIancarOneFullFacts,
  collectIancarOnePhaseOneFacts,
  createIancarOneApiClient,
  iancarOneApiConfigFromEnv,
  projectIancarOnePhaseOne,
  summarizeJsonShape
  , iancarOnePhotoIds, IancarOneApiError, iancarOneModelIllustration
} from '../adapters/iancar-one-api.js';
import { inspectSupplierSourceBatch } from '../domain/source-intake.js';

const requested = new Set(process.argv.slice(2));
if ([...requested].some(arg => arg.startsWith('--restore-photos='))) {
  const args = [...requested];
  if (args.some(arg => !arg.startsWith('--restore-photos=') && !arg.startsWith('--expected-digest=') && arg !== '--apply')) throw new Error('IANCAR_PHOTO_OPTIONS_MIXED');
  const backupPath = args.find(arg => arg.startsWith('--restore-photos='))!.slice('--restore-photos='.length);
  const expectedSourceDigest = args.find(arg => arg.startsWith('--expected-digest='))?.slice('--expected-digest='.length);
  if (!backupPath || !expectedSourceDigest) throw new Error('IANCAR_RESTORE_BACKUP_INVALID');
  if (requested.has('--apply') && process.env.IANCAR_PHOTO_RESTORE_APPROVED !== 'true') throw new Error('IANCAR_PHOTO_APPROVAL_REQUIRED');
  const { runIancarPhotoRestore } = await import('./data-access-runtime.js');
  console.log(JSON.stringify(await runIancarPhotoRestore({ backupPath, expectedSourceDigest, apply: requested.has('--apply') })));
  process.exit(0);
}
const allowed = new Set(['--apply-raw', '--inspect-detail-shape', '--full-facts', '--save-private', '--phase-one', '--photos', '--apply-photos', '--sync', '--apply-sync']);
if ([...requested].some((arg) => !allowed.has(arg))) {
  throw new Error('UNKNOWN_IANCAR_ONE_OPTION');
}

const config = iancarOneApiConfigFromEnv();
if (!config.apiKey) throw new Error('EANCAR_ONE_API_KEY_REQUIRED');
if (requested.has('--apply-sync') && !requested.has('--sync')) throw new Error('IANCAR_SYNC_MODE_REQUIRED');
if (requested.has('--sync')) {
  if ([...requested].some(arg => !['--sync', '--apply-sync', '--save-private'].includes(arg))) throw new Error('IANCAR_SYNC_OPTIONS_MIXED');
  if (requested.has('--apply-sync') && process.env.EANCAR_ONE_SYNC_APPROVED !== 'true') throw new Error('IANCAR_SYNC_APPROVAL_REQUIRED');
}

if (requested.has('--photos')) {
  if ([...requested].some(arg => !['--photos', '--apply-photos', '--save-private'].includes(arg))) throw new Error('IANCAR_PHOTO_OPTIONS_MIXED');
  if (requested.has('--apply-photos') && process.env.IANCAR_PHOTO_PUBLICATION_APPROVED !== 'true') throw new Error('IANCAR_PHOTO_APPROVAL_REQUIRED');
  const { createConsumerDataAccessRuntime, isPublicIancarPhotoProduct } = await import('../api/data-access-runtime.js');
  const { runIancarPhotoPublication } = await import('./data-access-runtime.js');
  const runtime = createConsumerDataAccessRuntime();
  const catalog = await runtime.access.read({
    context: { actor: { id: 'service:iancar-photo-observer', kind: 'SERVICE' }, clientId: 'job:iancar-photo-observer', purpose: 'observe eligible RP031 photo references without business writes' },
    operation: 'READ_IANCAR_PHOTO_ELIGIBILITY', resource: { kind: 'SOURCE', name: 'products', entityId: 'RP031' },
    summarize: value => ({ count: Object.keys(value.data.products).length }),
  }, () => runtime.compat.read('erp-com'));
  const rows = Object.entries(catalog.data.products).filter(([, p]) => isPublicIancarPhotoProduct(p));
  const client = createIancarOneApiClient(config);
  const records: Parameters<typeof runIancarPhotoPublication>[0]['records'] = [];
  const unresolved: { productId: string; code: string }[] = [];
  // Two bounded read-only workers; source failure remains explicit HOLD, never zero photos.
  let cursor = 0;
  await Promise.all(Array.from({ length: 2 }, async () => { while (cursor < rows.length) {
    const [productId, p] = rows[cursor++]!;
    try {
      const detail = await client.getVehicle(String(p.iancar_one_vehicle_id));
      const ids = iancarOnePhotoIds(detail, String(p.iancar_one_vehicle_id), String(p.car_number));
      const illustration = ids.length ? null : iancarOneModelIllustration(detail, String(p.iancar_one_vehicle_id), String(p.car_number));
      records.push({ productId, vehicleId: String(p.iancar_one_vehicle_id), plate: String(p.car_number), count: ids.length, observedAt: new Date().toISOString(), ...(illustration ? { illustration } : {}) });
    } catch (error) {
      if (!(error instanceof IancarOneApiError)) throw error;
      unresolved.push({ productId, code: error.code });
    }
    const completed = records.length + unresolved.length;
    if (completed % 20 === 0) console.log(JSON.stringify({ phase: 'READING_PHOTO_REFERENCES', completed, total: rows.length }));
  } }));
  const plan = await runIancarPhotoPublication({ records, apply: false });
  console.log(JSON.stringify(plan));
  console.log(JSON.stringify({ status: unresolved.length ? 'HOLD_SOURCE_PARTIAL' : 'PHOTO_OBSERVATION_COMPLETE', observedPublicProducts: rows.length, unresolved, sourceAbsenceIsNotZeroPhotos: true }));
  if (requested.has('--save-private')) {
    const { mkdir, writeFile, readFile } = await import('node:fs/promises');
    const { homedir } = await import('node:os'); const { join } = await import('node:path'); const { randomUUID } = await import('node:crypto');
    const directory = join(homedir(), '.codex', 'private', 'freepass-data-iancar-one-captures');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `photos-${randomUUID()}.json`);
    const bytes = JSON.stringify({ schema: 'iancar-photo-observation/1', records, unresolved, observedPublicProducts: rows.length, plan });
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    if (await readFile(path, 'utf8') !== bytes) throw new Error('IANCAR_PHOTO_CAPTURE_READBACK_FAILED');
    console.log(JSON.stringify({ privateCapturePath: path }));
  }
  if (requested.has('--apply-photos')) console.log(JSON.stringify(await runIancarPhotoPublication({ records, apply: true, expectedPlanDigest: plan.planDigest })));
  process.exit(0);
}
if (requested.has('--apply-photos')) throw new Error('IANCAR_PHOTOS_MODE_REQUIRED');

const capture = requested.has('--phase-one') || requested.has('--sync')
  ? await collectIancarOnePhaseOneFacts(config, fetch, new Date().toISOString(), (completed, total) => {
    if (completed % 25 === 0) console.log(JSON.stringify({ phase: 'READING_PHASE_ONE_FACTS', completed, total }));
  }, { photos: requested.has('--sync') }) : requested.has('--full-facts')
  ? await collectIancarOneFullFacts(config, fetch, new Date().toISOString(), (completed, total) => {
    if (completed % 25 === 0) console.log(JSON.stringify({ phase: 'READING_FULL_FACTS', completed, total }));
  }) : await collectIancarOneVehicleList(config);
const batch = buildIancarOneSourceBatch(capture);
const commonEvidence = inspectSupplierSourceBatch({ adapterId: 'iancar-one-api',
  sourceId: batch.source.sourceId, scope: capture.factScope ? 'terms' : 'inventory' }, batch, new Date().toISOString());

const report: Record<string, unknown> = {
  collector: 'freepass-data/iancar-one-api',
  commonEvidence,
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

if ((requested.has('--phase-one') || requested.has('--sync')) && capture.readyForRawIngest) {
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

if (requested.has('--sync')) {
  if (!capture.readyForRawIngest || capture.issues.length) {
    console.log(JSON.stringify({ ...report, status: 'HOLD_SOURCE_REVIEW', writeExecuted: false }, null, 2));
    process.exit(2);
  }
  const { runIancarPhaseOnePublication } = await import('./data-access-runtime.js');
  const input = { capture, apply: false, mirrorInventory: true,
    ...(process.env.EANCAR_ONE_PRIVATE_EVIDENCE_BUCKET ? { privateEvidenceBucket: process.env.EANCAR_ONE_PRIVATE_EVIDENCE_BUCKET } : {}) };
  const plan = await runIancarPhaseOnePublication(input);
  report.publicationPlan = plan;
  if (requested.has('--apply-sync')) {
    const result = await runIancarPhaseOnePublication({ ...input, apply: true, expectedPlanDigest: plan.planDigest });
    // Only redacted counts/references leave the private evidence boundary.
    report.publication = { status: result.status, sourceDigest: capture.sourceDigest,
      sourceSyncedAt: capture.syncedAt, open: result.open, created: result.created, absenceHeld: result.absenceHeld,
      withPhotos: result.withPhotos, photoCount: result.photoCount,
      runId: 'runId' in result ? result.runId : null,
      privateBackupObject: 'privateBackupObject' in result ? result.privateBackupObject : null };
  }
}

report.status = capture.issues.length
  ? 'HOLD_SOURCE_REVIEW'
  : requested.has('--apply-sync') ? 'IANCAR_ATOM_SYNC_VERIFIED_CONSUMERS_PENDING'
  : requested.has('--apply-raw')
    ? 'RAW_INGESTED_NOT_CANONICAL'
    : 'OBSERVED_NOT_PUBLISHED';

console.log(JSON.stringify(report, null, 2));
if (capture.issues.length) process.exitCode = 2;
