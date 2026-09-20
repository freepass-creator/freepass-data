import { randomUUID } from 'node:crypto';
import type { LegacyProductSnapshot } from '../adapters/legacy-freepasserp3.js';
import { normalizeLegacyProduct } from '../adapters/legacy-normalizer.js';
import { buildLegacyCandidateLineage } from '../adapters/legacy-lineage.js';
import type { SourceDefinition } from '../domain/source.js';
import type { SourceStore } from '../ports/source-store.js';

export const LEGACY_PRODUCT_SOURCE: SourceDefinition = {
  sourceId: 'freepasserp3/firestore/products',
  kind: 'FIRESTORE',
  displayName: 'Legacy FreePass ERP3 Firestore products',
  authorityScope: ['catalog:legacy-source'],
  expectedFreshnessSeconds: null,
  health: 'UNKNOWN',
  enabled: true
};

function candidateStatus(issues: string[], hasModel: boolean, hasTerms: boolean) {
  if (!hasModel || !hasTerms) return 'REJECTED' as const;
  return issues.length ? 'WARNING' as const : 'VALID' as const;
}

export async function ingestLegacyProductSnapshot(
  sourceStore: SourceStore,
  snapshot: LegacyProductSnapshot,
  now = new Date().toISOString()
) {
  const runId = `run_${randomUUID()}`;
  await sourceStore.upsertSource(LEGACY_PRODUCT_SOURCE);
  await sourceStore.beginRun({
    runId,
    sourceId: LEGACY_PRODUCT_SOURCE.sourceId,
    status: 'RUNNING',
    startedAt: now,
    rawCount: 0,
    candidateCount: 0,
    warningCount: 0
  });

  let rawCount = 0;
  let candidateCount = 0;
  let warningCount = 0;

  try {
    for (const raw of snapshot.records) {
      const rawRecordId = `${runId}:${raw.sourceRecordId}`;
      await sourceStore.appendRaw({
        rawRecordId,
        runId,
        sourceId: raw.sourceId,
        sourceRecordId: raw.sourceRecordId,
        sourceFingerprint: raw.fingerprint,
        observedAt: raw.observedAt,
        payload: raw.data
      });
      rawCount += 1;

      const candidate = normalizeLegacyProduct(raw);
      const status = candidateStatus(
        candidate.issues,
        Boolean(candidate.model),
        candidate.priceTerms.length > 0
      );
      if (status !== 'VALID') warningCount += 1;

      const candidateId = `${runId}:${raw.sourceRecordId}`;
      await sourceStore.appendCandidate({
        candidateId,
        runId,
        sourceId: raw.sourceId,
        sourceRecordId: raw.sourceRecordId,
        sourceFingerprint: raw.fingerprint,
        status,
        candidate
      });
      for (const lineage of buildLegacyCandidateLineage(raw, candidate, runId, candidateId)) {
        await sourceStore.appendLineage(lineage);
      }
      candidateCount += 1;
    }

    await sourceStore.completeRun({
      runId,
      completedAt: now,
      observedAt: snapshot.checkpoint.observedAt,
      checkpoint: snapshot.checkpoint,
      rawCount,
      candidateCount,
      warningCount
    });
    return await sourceStore.getRun(runId);
  } catch (error) {
    await sourceStore.failRun({
      runId,
      completedAt: now,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}
