import { createSourceIngestDataAccessRuntime } from './data-access-runtime.js';

const targetProjectId = process.env.FIREBASE_PROJECT_ID?.trim();
const legacyProjectId = process.env.LEGACY_FREEPASSERP3_PROJECT_ID?.trim();

if (!targetProjectId) {
  throw new Error('Refusing to ingest: FIREBASE_PROJECT_ID target is not configured');
}
if (!legacyProjectId) {
  throw new Error('Refusing to ingest: LEGACY_FREEPASSERP3_PROJECT_ID is not configured');
}
if (targetProjectId === legacyProjectId) {
  throw new Error(
    'Refusing to ingest: target and legacy project IDs are identical. ' +
    'This requires an explicit architecture decision, not an accidental default.'
  );
}

const runtime = await createSourceIngestDataAccessRuntime();
const snapshot = await runtime.readLegacySnapshot();
const run = await runtime.ingestLegacySnapshot(snapshot);

console.log(JSON.stringify({
  status: run?.status ?? 'UNKNOWN',
  runId: run?.runId ?? null,
  sourceId: run?.sourceId ?? null,
  rawCount: run?.rawCount ?? null,
  candidateCount: run?.candidateCount ?? null,
  lineageCount: run?.lineageCount ?? null,
  coverage: run?.coverage ?? null,
  headStatus: run?.headStatus ?? null,
  warningCount: run?.warningCount ?? null,
  targetProjectId,
  legacyProjectId
}, null, 2));
