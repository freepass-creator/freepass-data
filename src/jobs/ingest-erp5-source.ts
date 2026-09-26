import {
  createErp5InspectionDataAccessRuntime,
  createSourceIngestDataAccessRuntime,
} from './data-access-runtime.js';

if (process.env.ERP5_SOURCE_INGEST_APPROVED !== 'true') {
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
const writeRuntime = await createSourceIngestDataAccessRuntime();

const capture = await readRuntime.capture();
const batches = readRuntime.buildRawIntakeBatches(capture);
const runs = [];
for (const batch of batches) {
  runs.push(await writeRuntime.ingestRawBatch(batch));
}

console.log(JSON.stringify({
  status: runs.every((run) => run.status === 'COMPLETED')
    ? 'COMPLETED'
    : 'HOLD',
  sourceReadTime: capture.readTime,
  sourceDigest: capture.digest,
  runs: runs.map((run) => ({
    runId: run.runId,
    sourceId: run.sourceId,
    status: run.status,
    headStatus: run.headStatus,
    rawCount: run.rawCount,
    coverage: run.coverage,
  })),
}, null, 2));
