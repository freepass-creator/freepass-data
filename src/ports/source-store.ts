import type {
  NormalizedCandidateRecord,
  RawRecord,
  SourceCheckpoint,
  SourceCoverage,
  SourceDefinition,
  SourceHead,
  SourceRun
} from '../domain/source.js';
import type { FieldLineageRecord } from '../domain/lineage.js';

/**
 * Source-run ingestion lifecycle only.
 *
 * This is not a second Canonical repository. Canonical mutations remain behind
 * CatalogStore/CatalogTransaction; both paths share the same physical source
 * evidence layout in infra.
 */
export interface SourceIngestionStore {
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
    coverage: SourceCoverage;
    rawCount: number;
    candidateCount: number;
    lineageCount: number;
    warningCount: number;
  }): Promise<{ acceptedAsHead: boolean; headRunId: string | null }>;
  failRun(input: { runId: string; completedAt: string; error: string }): Promise<void>;

  getRun(runId: string): Promise<SourceRun | null>;
  getSourceHead(sourceId: string): Promise<SourceHead | null>;
  listRaw(runId: string): Promise<RawRecord[]>;
  listCandidates(runId: string): Promise<NormalizedCandidateRecord[]>;
  listLineage(runId: string): Promise<FieldLineageRecord[]>;
}
