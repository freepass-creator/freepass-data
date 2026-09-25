import { readLegacyProductSnapshot } from '../adapters/legacy-freepasserp3.js';
import { ingestLegacyProductSnapshot } from '../application/ingest-legacy-products.js';
import { createFirestoreSourceStore } from '../infra/source-firestore-store.js';
import { createFirestoreDataAccessLogStore } from '../infra/firestore-data-access-log.js';
import { DataAccessGateway } from '../application/data-access-gateway.js';
import { stableDigest } from '../shared/stable-digest.js';

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

const target = createFirestoreSourceStore();
const snapshot = await readLegacyProductSnapshot();
const access = new DataAccessGateway(createFirestoreDataAccessLogStore());
const run = await access.write({
  context: {
    actor: { id: 'service:freepass-data-ingest', kind: 'SERVICE' },
    clientId: 'job:ingest-legacy-products',
    purpose: 'ingest reviewed legacy source snapshot through FreePass Data',
    correlationId: snapshot.checkpoint.sourceId
  },
  operation: 'WRITE_LEGACY_SOURCE_INGEST',
  resource: {
    kind: 'SOURCE',
    name: snapshot.checkpoint.sourceId
  },
  requestDigest: stableDigest({
    sourceId: snapshot.checkpoint.sourceId,
    checkpoint: snapshot.checkpoint,
    coverage: snapshot.coverage,
    recordCount: snapshot.records.length
  }),
  summarize: (value) => value ? {
    count: value.rawCount,
    digest: stableDigest({
      runId: value.runId,
      sourceId: value.sourceId,
      rawCount: value.rawCount,
      candidateCount: value.candidateCount,
      lineageCount: value.lineageCount,
      warningCount: value.warningCount
    })
  } : { count: 0 }
}, () => ingestLegacyProductSnapshot(target, snapshot));

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
