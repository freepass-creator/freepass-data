import {
  createErp5InspectionDataAccessRuntime,
  createSourceIngestDataAccessRuntime,
  createIancarErpInspectionDataAccessRuntime,
} from './data-access-runtime.js';

const iancarErp = process.argv.includes('--iancar-erp');
const dryRun = process.argv.includes('--dry-run');
if (!dryRun && process.env.ERP5_SOURCE_INGEST_APPROVED !== 'true') {
  throw new Error('ERP5_SOURCE_INGEST_APPROVED=true required');
}

const accessToken = process.env.FREEPASS_ERP5_READ_ACCESS_TOKEN?.trim() ?? '';
const evidenceBucket =
  process.env.FREEPASS_DATA_EVIDENCE_BUCKET?.trim() ??
  process.env.EVIDENCE_BUCKET?.trim() ??
  '';

if (!accessToken) {
  throw new Error('FREEPASS_ERP5_READ_ACCESS_TOKEN is required');
}
if (!evidenceBucket) {
  throw new Error('FREEPASS_DATA_EVIDENCE_BUCKET is required');
}

const readRuntime = createErp5InspectionDataAccessRuntime({
  accessToken,
  evidenceBucket,
});
const iancarRuntime = iancarErp ? createIancarErpInspectionDataAccessRuntime({ accessToken, evidenceBucket,
  accountJson: process.env.IANKA_ACCOUNT_JSON ?? '' }) : null;
const capture = iancarRuntime ? await iancarRuntime.capture() : await readRuntime.capture();
const batches = 'vehicles' in capture
  ? [iancarRuntime!.buildRawIntakeBatch(capture)]
  : readRuntime.buildRawIntakeBatches(capture);
if (dryRun) {
  console.log(JSON.stringify({ status: 'DRY_RUN', source: iancarErp ? 'IANCAR_ERP' : 'ERP5_FIRESTORE',
    batches: batches.map(batch => ({ sourceId: batch.source.sourceId, observedAt: batch.observedAt,
      checksum: batch.checksum, coverage: batch.coverage, rawCount: batch.records.length })),
    canonicalWriteAuthorized: false, consumerCutoverVerified: false }, null, 2));
  process.exit(0);
}
const writeRuntime = await createSourceIngestDataAccessRuntime();
const runs = [];
for (const batch of batches) {
  runs.push(await writeRuntime.ingestRawBatch(batch));
}

console.log(JSON.stringify({
  status: runs.every((run) => run.status === 'COMPLETED'
    && (!iancarErp || (run.headStatus === 'CURRENT' && run.coverage.completeness === 'COMPLETE')))
    ? 'COMPLETED'
    : 'HOLD',
  ...(iancarErp ? { stage: 'RAW_INTAKE_ONLY', pricingState: 'UNKNOWN',
    canonicalWriteAuthorized: false, consumerCutoverVerified: false } : {}),
  sourceReadTime: 'observedAt' in capture ? capture.observedAt : capture.readTime,
  sourceDigest: 'sourceRevision' in capture ? capture.sourceRevision : capture.digest,
  runs: runs.map((run) => ({
    runId: run.runId,
    sourceId: run.sourceId,
    status: run.status,
    headStatus: run.headStatus,
    rawCount: run.rawCount,
    coverage: run.coverage,
  })),
}, null, 2));
