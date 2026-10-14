import {
  buildIancarOneSourceBatch,
  collectIancarOneVehicleList,
  collectIancarOneFullFacts,
  collectIancarOnePhaseOneFacts,
  createIancarOneApiClient,
  iancarOneApiConfigFromEnv,
  projectIancarOnePhaseOne,
  summarizeJsonShape
  , iancarOnePhotoIds, IancarOneApiError, iancarOneModelIllustration, readIancarOnePhotoBytes
} from '../adapters/iancar-one-api.js';
import { inspectSupplierSourceBatch } from '../domain/source-intake.js';
import { createHash } from 'node:crypto';
import { orderedJsonDigest } from '../shared/stable-digest.js';

// Strict isolated entrypoint. Never reaches legacy reports, DB access or private raw capture.
if (process.argv.slice(2).includes('--source-only')) {
  const args = process.argv.slice(2);
  let summary: Record<string, unknown> = { stage: 'SOURCE_ONLY', status: 'STOP', count: 0,
    logicalCalls: 0, fresh: false, writes: 0, photoBytes: 0 };
  if (args.length === 2 && args.includes('--phase-one')) {
    try {
      const { inspectIancarSourceOnly } = await import('../adapters/iancar-one-api.js');
      summary = await inspectIancarSourceOnly(iancarOneApiConfigFromEnv());
    } catch { /* Fixed summary only; no provider exception or credentials leave memory. */ }
  }
  process.stdout.on('error', () => { /* Broken output pipe must never produce a stderr stack. */ });
  const printed = await new Promise<boolean>(resolve => process.stdout.write(`${JSON.stringify(summary)}\n`,
    error => resolve(!error)));
  if (!printed) process.exit(2);
  process.exit(summary.status === 'COMPLETE' ? 0 : 2);
}

// Exact reviewed input is separate from full collection and never bootstraps a new identity.
if (process.argv.slice(2).some(arg => arg.startsWith('--reviewed-plan='))) {
  let applyRequested = false;
  let publicationAttempted = false;
  try {
    const args = process.argv.slice(2);
    if (new Set(args).size !== args.length || args.some(arg => !arg.startsWith('--reviewed-plan=')
      && !arg.startsWith('--expected-digest=') && arg !== '--apply')
      || args.filter(arg => arg.startsWith('--reviewed-plan=')).length !== 1
      || args.filter(arg => arg.startsWith('--expected-digest=')).length !== 1) throw new Error('IANCAR_REVIEW_OPTIONS_INVALID');
    const path = args.find(arg => arg.startsWith('--reviewed-plan='))!.slice('--reviewed-plan='.length);
    const expectedPlanDigest = args.find(arg => arg.startsWith('--expected-digest='))!.slice('--expected-digest='.length);
    const apply = args.includes('--apply');
    applyRequested = apply;
    const discoverPlan = expectedPlanDigest === 'PLAN' && !apply;
    if (!path || (!discoverPlan && !/^[a-f0-9]{64}$/.test(expectedPlanDigest))) throw new Error('IANCAR_REVIEW_OPTIONS_INVALID');
    if (apply && process.env.IANCAR_PHOTO_REVIEW_APPROVED !== 'true') throw new Error('IANCAR_PHOTO_APPROVAL_REQUIRED');
    const { readFile, stat } = await import('node:fs/promises');
    if ((await stat(path)).size > 2 * 1024 * 1024) throw new Error('IANCAR_REVIEW_INPUT_INVALID');
    const plan = JSON.parse(await readFile(path, 'utf8'));
    if (!plan || typeof plan !== 'object' || Object.keys(plan).some(key => key !== 'records')
      || !Array.isArray(plan.records) || plan.records.length !== 1) throw new Error('IANCAR_REVIEW_INPUT_INVALID');
    const row = plan.records[0];
    const rowKeys = ['productId', 'vehicleId', 'plate', 'count', 'observedAt', 'review'];
    const reviewKeys = ['upstreamPhotoIds', 'servingPhotoIds', 'refs', 'basis', 'sourceRepresentatives'];
    const refKeys = ['sourceKind', 'sourceApiVersion', 'sourceBindingDigest', 'photoSetDigest', 'sourcePhotoIdDigest',
      'sourceOrdinal', 'servingIndex', 'mediaType', 'photoSha256', 'sourceObservedAt',
      'vehiclePhotoVerifiedBy', 'vehiclePhotoVerificationMethod', 'vehiclePhotoVerifiedAt', 'reviewBasis', 'representative'];
    if (!row || Object.keys(row).some(key => !rowKeys.includes(key))
      || !['productId', 'vehicleId', 'plate', 'observedAt'].every(key => typeof row[key] === 'string' && row[key].trim())
      || /[\/\u0000-\u001f\u007f]/.test(row.productId) || !row.review
      || Object.keys(row.review).some(key => !reviewKeys.includes(key))
      || !Array.isArray(row.review.refs) || !row.review.refs.length
      || row.review.refs.some((ref: any) => !ref || Object.keys(ref).some(key => !refKeys.includes(key)))) throw new Error('IANCAR_REVIEW_INPUT_INVALID');
    // The same pure writer validator is used before source I/O, preserving the actual human timestamps.
    const { planIancarPhotoReviewPatch } = await import('../domain/consumer-output-contract.js');
    const identity = { provider_company_code: 'RP031', listable: true, status_kind: '가용',
      iancar_one_vehicle_id: row.vehicleId, car_number: row.plate };
    // An apply may refresh an old capture only after the entire original album is checked below.
    const sourceRecheckRequired = apply || Date.now() - Date.parse(row.observedAt) > 900_000;
    const candidate = sourceRecheckRequired ? { ...row, observedAt: new Date().toISOString() } : row;
    planIancarPhotoReviewPatch(identity, candidate, row.review);
    if (sourceRecheckRequired) {
      const config = iancarOneApiConfigFromEnv();
      if (!config.apiKey) throw new Error('IANCAR_ONE_API_KEY_REQUIRED');
      const client = createIancarOneApiClient(config);
      const inspect = (detail: unknown) => {
        const ids = iancarOnePhotoIds(detail, row.vehicleId, row.plate);
        const raw = (detail as any)?.data ?? detail;
        const upstream = raw.photos.map((photo: any) => String(photo.photo_id).trim());
        if (row.review.basis === 'CONTENT_ORDINAL/1') {
          const representatives = raw.photos.map((photo: any) => photo.representative);
          if (ids.length !== row.count || orderedJsonDigest(representatives) !== orderedJsonDigest(row.review.sourceRepresentatives)
            || ids.some((id, i) => upstream.indexOf(id) !== row.review.refs[i].sourceOrdinal)) throw new Error('IANCAR_REVIEW_SOURCE_CHANGED');
        } else if (orderedJsonDigest(ids) !== orderedJsonDigest(row.review.servingPhotoIds)
          || orderedJsonDigest(upstream) !== orderedJsonDigest(row.review.upstreamPhotoIds)) throw new Error('IANCAR_REVIEW_SOURCE_CHANGED');
        return ids;
      };
      const ids = inspect(await client.getVehicle(row.vehicleId));
      for (let i = 0; i < ids.length; i++) {
        const photo = await readIancarOnePhotoBytes(await client.getPhoto(row.vehicleId, ids[i]!));
        if (photo.contentType !== row.review.refs[i].mediaType
          || createHash('sha256').update(photo.bytes).digest('hex') !== row.review.refs[i].photoSha256) throw new Error('IANCAR_REVIEW_SOURCE_CHANGED');
      }
      inspect(await client.getVehicle(row.vehicleId));
      row.observedAt = new Date().toISOString();
    }
    const { runIancarPhotoPublication } = await import('./data-access-runtime.js');
    publicationAttempted = true;
    const result = await runIancarPhotoPublication({ records: [row], verificationOnly: true, apply,
      ...(discoverPlan ? {} : { expectedPlanDigest }) });
    console.log(JSON.stringify({ status: result.status, count: result.count, planDigest: result.planDigest,
      writeExecuted: result.writeExecuted, ...('backupPath' in result ? { backupPath: result.backupPath } : {}) }));
    if (!apply && !discoverPlan && result.planDigest !== expectedPlanDigest) throw new Error('IANCAR_PHOTO_PLAN_CHANGED');
  } catch (error) {
    const candidate = error instanceof Error ? error.message : '';
    const code = /^IANCAR_[A-Z_]+$/.test(candidate) ? candidate : 'IANCAR_REVIEW_FAILED';
    const committed = !!error && typeof error === 'object' && 'writeExecuted' in error && error.writeExecuted === true;
    console.error(JSON.stringify({ code, writeExecuted: committed ? true
      : (applyRequested && publicationAttempted ? 'UNKNOWN' : false) }));
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

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
// 이안카 상품 문서(가격·재고·상태)의 유일한 작성 주체는 원천 엔진(source-engine)이다. 옛 1차 발행(--sync/--apply-sync 등)은 2026-10-14 폐기.
const allowed = new Set(['--apply-raw', '--inspect-detail-shape', '--full-facts', '--save-private', '--phase-one', '--photos', '--apply-photos']);
if ([...requested].some((arg) => !allowed.has(arg))) {
  throw new Error('UNKNOWN_IANCAR_ONE_OPTION');
}

const config = iancarOneApiConfigFromEnv();
if (!config.apiKey) throw new Error('EANCAR_ONE_API_KEY_REQUIRED');
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

const capture = requested.has('--phase-one')
  ? await collectIancarOnePhaseOneFacts(config, fetch, new Date().toISOString(), (completed, total) => {
    if (completed % 25 === 0) console.log(JSON.stringify({ phase: 'READING_PHASE_ONE_FACTS', completed, total }));
  }) : requested.has('--full-facts')
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

if (requested.has('--phase-one') && capture.readyForRawIngest) {
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
