import type {
  NormalizedCandidateRecord,
  RawRecord,
  SourceDefinition,
  SourceHead,
  SourceRun
} from '../domain/source.js';
import { canAdvanceSourceHead } from '../domain/source.js';
import type { SourceStore } from '../ports/source-store.js';
import type { FieldLineageRecord } from '../domain/lineage.js';

const copy = <T>(value: T): T => structuredClone(value);

export class MemorySourceStore implements SourceStore {
  private sources = new Map<string, SourceDefinition>();
  private runs = new Map<string, SourceRun>();
  private raw = new Map<string, RawRecord>();
  private candidates = new Map<string, NormalizedCandidateRecord>();
  private lineage = new Map<string, FieldLineageRecord>();
  private heads = new Map<string, SourceHead>();

  async upsertSource(source: SourceDefinition) { this.sources.set(source.sourceId, copy(source)); }
  async getSource(sourceId: string) { return copy(this.sources.get(sourceId) ?? null); }

  async beginRun(run: SourceRun) {
    if (this.runs.has(run.runId)) throw new Error(`Source run already exists: ${run.runId}`);
    this.runs.set(run.runId, copy(run));
  }

  async appendRaw(record: RawRecord) {
    if (this.raw.has(record.rawRecordId)) throw new Error(`Raw record is immutable: ${record.rawRecordId}`);
    this.raw.set(record.rawRecordId, copy(record));
  }

  async appendCandidate(record: NormalizedCandidateRecord) {
    if (this.candidates.has(record.candidateId)) throw new Error(`Candidate is immutable: ${record.candidateId}`);
    this.candidates.set(record.candidateId, copy(record));
  }

  async appendLineage(record: FieldLineageRecord) {
    if (this.lineage.has(record.lineageRecordId)) throw new Error(`Lineage record is immutable: ${record.lineageRecordId}`);
    this.lineage.set(record.lineageRecordId, copy(record));
  }

  async completeRun(input: Parameters<SourceStore['completeRun']>[0]) {
    const run = this.runs.get(input.runId);
    if (!run) throw new Error(`Source run not found: ${input.runId}`);

    const currentHead = this.heads.get(run.sourceId);
    if (run.status === 'COMPLETED') {
      return {
        acceptedAsHead: run.headStatus === 'CURRENT',
        headRunId: currentHead?.runId ?? null
      };
    }

    const eligible = input.coverage.completeness === 'COMPLETE';
    const newerThanHead = canAdvanceSourceHead(input.observedAt, currentHead?.observedAt);
    const acceptedAsHead = eligible && newerThanHead;

    Object.assign(run, {
      status: 'COMPLETED',
      completedAt: input.completedAt,
      observedAt: input.observedAt,
      checkpoint: input.checkpoint,
      coverage: input.coverage,
      headStatus: acceptedAsHead ? 'CURRENT' : eligible ? 'STALE' : 'INELIGIBLE',
      rawCount: input.rawCount,
      candidateCount: input.candidateCount,
      lineageCount: input.lineageCount,
      warningCount: input.warningCount
    });

    if (acceptedAsHead) {
      if (currentHead) {
        const previous = this.runs.get(currentHead.runId);
        if (previous?.headStatus === 'CURRENT') previous.headStatus = 'STALE';
      }
      this.heads.set(run.sourceId, {
        sourceId: run.sourceId,
        runId: run.runId,
        observedAt: input.observedAt,
        acceptedAt: input.completedAt,
        checkpoint: copy(input.checkpoint),
        coverage: copy(input.coverage)
      });
    }

    return {
      acceptedAsHead,
      headRunId: acceptedAsHead ? run.runId : currentHead?.runId ?? null
    };
  }

  async failRun(input: Parameters<SourceStore['failRun']>[0]) {
    const run = this.runs.get(input.runId);
    if (!run) throw new Error(`Source run not found: ${input.runId}`);
    Object.assign(run, { status: 'FAILED', completedAt: input.completedAt, error: input.error });
  }

  async getRun(runId: string) { return copy(this.runs.get(runId) ?? null); }
  async getSourceHead(sourceId: string) { return copy(this.heads.get(sourceId) ?? null); }
  async listRaw(runId: string) {
    return copy([...this.raw.values()].filter((x) => x.runId === runId));
  }
  async listCandidates(runId: string) {
    return copy([...this.candidates.values()].filter((x) => x.runId === runId));
  }
  async listLineage(runId: string) {
    return copy([...this.lineage.values()].filter((x) => x.runId === runId));
  }
}
