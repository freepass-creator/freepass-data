import type {
  NormalizedCandidateRecord,
  RawRecord,
  SourceDefinition,
  SourceRun
} from '../domain/source.js';
import type { SourceCheckpoint } from '../migration/shadow.js';
import type { FieldLineageRecord } from '../domain/lineage.js';

export interface SourceStore {
  upsertSource(source: SourceDefinition): Promise<void>;
  getSource(sourceId: string): Promise<SourceDefinition | null>;

  beginRun(run: SourceRun): Promise<void>;
  appendRaw(record: RawRecord): Promise<void>;
  appendCandidate(record: NormalizedCandidateRecord): Promise<void>;
  appendLineage(record: FieldLineageRecord): Promise<void>;
  completeRun(input: {
    runId: string;
    completedAt: string;
    observedAt: string;
    checkpoint: SourceCheckpoint;
    rawCount: number;
    candidateCount: number;
    lineageCount: number;
    warningCount: number;
  }): Promise<void>;
  failRun(input: { runId: string; completedAt: string; error: string }): Promise<void>;

  getRun(runId: string): Promise<SourceRun | null>;
  listRaw(runId: string): Promise<RawRecord[]>;
  listCandidates(runId: string): Promise<NormalizedCandidateRecord[]>;
  listLineage(runId: string): Promise<FieldLineageRecord[]>;
}
