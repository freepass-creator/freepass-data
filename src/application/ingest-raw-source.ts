import { stableDigest } from '../shared/stable-digest.js';
import type { SourceRun } from '../domain/source.js';
import {
  sourceLane,
  validateSourceIntakeBatch,
  type SourceIntakeBatch,
} from '../domain/source-intake.js';
import type { SourceIngestionStore } from '../ports/source-store.js';

function preparedBatch(input: SourceIntakeBatch) {
  validateSourceIntakeBatch(input);

  const records = input.records
    .map((record) => ({
      sourceRecordId: record.sourceRecordId.trim(),
      sourceFingerprint:
        record.sourceFingerprint?.toLowerCase() ??
        stableDigest(record.payload),
      payload: structuredClone(record.payload),
    }))
    .sort((a, b) => a.sourceRecordId.localeCompare(b.sourceRecordId));

  const batchDigest = stableDigest({
    laneId: input.laneId,
    sourceId: input.source.sourceId.trim(),
    observedAt: input.observedAt,
    sourceRevision: input.sourceRevision ?? null,
    upstreamChecksum: input.checksum?.toLowerCase() ?? null,
    coverage: input.coverage,
    records: records.map((record) => [
      record.sourceRecordId,
      record.sourceFingerprint,
    ]),
  });

  return { records, batchDigest };
}

export async function ingestRawSourceBatch(
  store: SourceIngestionStore,
  input: SourceIntakeBatch,
  now = new Date().toISOString()
): Promise<SourceRun> {
  if (!Number.isFinite(Date.parse(now))) {
    throw new Error('INVALID_SOURCE_INTAKE_COMPLETED_AT');
  }

  const lane = sourceLane(input.laneId);
  const { records, batchDigest } = preparedBatch(input);
  const sourceId = input.source.sourceId.trim();
  const sourceChecksum = input.checksum?.toLowerCase() ?? batchDigest;
  const runId = `run_${stableDigest({
    sourceId,
    laneId: input.laneId,
    observedAt: input.observedAt,
    sourceRevision: input.sourceRevision ?? null,
    sourceChecksum,
    batchDigest,
  }).slice(0, 40)}`;

  const existing = await store.getRun(runId);
  if (existing) {
    if (
      existing.status === 'COMPLETED' &&
      existing.sourceId === sourceId &&
      existing.observedAt === input.observedAt &&
      existing.checkpoint?.checksum === sourceChecksum
    ) {
      return existing;
    }
    throw new Error('SOURCE_INTAKE_RUN_ALREADY_EXISTS');
  }

  await store.upsertSource({
    sourceId,
    kind: input.source.kind,
    displayName: input.source.displayName.trim(),
    authorityScope: [
      ...new Set([
        `source-lane:${lane.laneId}`,
        ...(input.source.authorityScope ?? []).map((value) => value.trim()),
      ]),
    ].sort(),
    expectedFreshnessSeconds: input.source.expectedFreshnessSeconds ?? null,
    health: 'UNKNOWN',
    enabled: true,
  });

  await store.beginRun({
    runId,
    sourceId,
    status: 'RUNNING',
    startedAt: now,
    coverage: structuredClone(input.coverage),
    headStatus: 'PENDING',
    rawCount: 0,
    candidateCount: 0,
    lineageCount: 0,
    warningCount: 0,
  });

  try {
    for (const record of records) {
      await store.appendRaw({
        rawRecordId: `${runId}:${record.sourceRecordId}`,
        runId,
        sourceId,
        sourceRecordId: record.sourceRecordId,
        sourceFingerprint: record.sourceFingerprint,
        observedAt: input.observedAt,
        intakeLaneId: input.laneId,
        sourceRevision: input.sourceRevision ?? null,
        sourceChecksum,
        payload: record.payload,
      });
    }

    await store.completeRun({
      runId,
      completedAt: now,
      observedAt: input.observedAt,
      checkpoint: {
        sourceId,
        sourceRevision: input.sourceRevision ?? null,
        checksum: sourceChecksum,
        observedAt: input.observedAt,
      },
      coverage: structuredClone(input.coverage),
      rawCount: records.length,
      candidateCount: 0,
      lineageCount: 0,
      warningCount: 0,
    });

    const completed = await store.getRun(runId);
    if (!completed) throw new Error('SOURCE_INTAKE_RUN_NOT_PERSISTED');
    return completed;
  } catch (error) {
    await store.failRun({
      runId,
      completedAt: now,
      error: error instanceof Error ? error.message : 'SOURCE_INTAKE_FAILED',
    });
    throw error;
  }
}
