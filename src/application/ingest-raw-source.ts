import { stableDigest } from '../shared/stable-digest.js';
import type { SourceRun, RawRecord, NormalizedCandidateRecord } from '../domain/source.js';
import type { FieldLineageRecord } from '../domain/lineage.js';
import {
  sourceLane,
  validateSourceIntakeBatch,
  type SourceIntakeBatch,
} from '../domain/source-intake.js';
import type { SourceIngestionStore } from '../ports/source-store.js';

export function preparedBatch(input: SourceIntakeBatch) {
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

/** Shared deterministic identity for offline planning and actual intake. */
export function prepareRawSourceBatch(input: SourceIntakeBatch) {
  const { records, batchDigest } = preparedBatch(input);
  const sourceId = input.source.sourceId.trim();
  const sourceChecksum = input.checksum?.toLowerCase() ?? batchDigest;
  const runId = `run_${stableDigest({ sourceId, laneId: input.laneId, observedAt: input.observedAt,
    sourceRevision: input.sourceRevision ?? null, sourceChecksum, batchDigest }).slice(0, 40)}`;
  const rawRecords: RawRecord[] = records.map(record => ({ rawRecordId: `${runId}:${record.sourceRecordId}`,
    runId, sourceId, sourceRecordId: record.sourceRecordId, sourceFingerprint: record.sourceFingerprint,
    observedAt: input.observedAt, intakeLaneId: input.laneId, sourceRevision: input.sourceRevision ?? null,
    sourceChecksum, payload: record.payload }));
  return { runId, sourceId, sourceChecksum, rawRecords };
}

export async function ingestRawSourceBatch(
  store: SourceIngestionStore,
  input: SourceIntakeBatch,
  now = new Date().toISOString(),
  normalize?: (raw: RawRecord) => { record: NormalizedCandidateRecord; lineage: FieldLineageRecord[] }
): Promise<SourceRun> {
  if (!Number.isFinite(Date.parse(now))) {
    throw new Error('INVALID_SOURCE_INTAKE_COMPLETED_AT');
  }

  const lane = sourceLane(input.laneId);
  const { rawRecords, sourceId, sourceChecksum, runId } = prepareRawSourceBatch(input);

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

  const previousHead = await store.getSourceHead(sourceId);
  // Preserve first observation even after an absence/reappearance; all evidence stays in existing RAW/runs.
  const firstSeen = new Map<string, string>();
  const firstRun = new Map<string, string | null>();
  const wanted = new Set(rawRecords.map(x => x.sourceRecordId));
  const visited = new Set<string>();
  let historyRunId: string | null = previousHead?.runId ?? null;
  while (normalize && historyRunId && wanted.size) {
    if (visited.has(historyRunId)) throw new Error('SOURCE_HISTORY_CYCLE');
    visited.add(historyRunId);
    for (const prior of await store.listRaw(historyRunId)) {
      if (wanted.has(prior.sourceRecordId)) {
        firstSeen.set(prior.sourceRecordId, prior.firstObservedAt ?? prior.observedAt);
        // Older RAW has no firstRunId: if it was itself a re-observation, the first run is unknown (not this run).
        firstRun.set(prior.sourceRecordId, prior.firstRunId !== undefined ? prior.firstRunId
          : prior.firstObservedAt && prior.firstObservedAt !== prior.observedAt ? null : prior.runId);
        wanted.delete(prior.sourceRecordId);
      }
    }
    historyRunId = (await store.getRun(historyRunId))?.previousHeadRunId ?? null;
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
    previousHeadRunId: previousHead?.runId ?? null,
    startedAt: now,
    coverage: structuredClone(input.coverage),
    headStatus: 'PENDING',
    rawCount: 0,
    candidateCount: 0,
    lineageCount: 0,
    warningCount: 0,
  });

  try {
    let candidateCount = 0, lineageCount = 0, warningCount = 0;
    for (const raw of rawRecords) {
      if (normalize) {
        const prior = firstSeen.get(raw.sourceRecordId);
        raw.firstObservedAt = prior && Date.parse(prior) < Date.parse(raw.observedAt) ? prior : raw.observedAt;
        // An earlier run at the same observation time is still the earlier run (e.g. a re-capture with a new revision).
        raw.firstRunId = prior && Date.parse(prior) <= Date.parse(raw.observedAt) ? firstRun.get(raw.sourceRecordId) ?? null : raw.runId;
      }
      await store.appendRaw(raw);
      if (normalize) {
        const normalized = normalize(structuredClone(raw));
        await store.appendCandidate(normalized.record);
        for (const item of normalized.lineage) await store.appendLineage(item);
        candidateCount++;
        lineageCount += normalized.lineage.length;
        if (normalized.record.status !== 'VALID') warningCount++;
      }
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
      rawCount: rawRecords.length,
      candidateCount,
      lineageCount,
      warningCount,
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
