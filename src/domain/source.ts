import type { CatalogCandidate } from './catalog-candidate.js';

export type SourceCheckpoint = {
  sourceId: string;
  sourceRevision?: string | null;
  checksum?: string | null;
  observedAt: string;
};

export type SourceCoverageMode = 'FULL' | 'DELTA' | 'PARTIAL' | 'UNKNOWN';
export type SourceCompleteness = 'COMPLETE' | 'INCOMPLETE' | 'UNKNOWN';
export type SourceRunHeadStatus = 'PENDING' | 'CURRENT' | 'STALE' | 'INELIGIBLE';

export type SourceCoverage = {
  mode: SourceCoverageMode;
  completeness: SourceCompleteness;
  scope?: string | null;
  note?: string | null;
};

export type SourceKind = 'FIRESTORE' | 'GOOGLE_SHEET' | 'API' | 'FILE' | 'MANUAL';
export type SourceHealth = 'UNKNOWN' | 'HEALTHY' | 'DEGRADED' | 'ERROR';

export type SourceDefinition = {
  sourceId: string;
  kind: SourceKind;
  displayName: string;
  authorityScope: string[];
  expectedFreshnessSeconds?: number | null;
  health: SourceHealth;
  enabled: boolean;
};

export type SourceRun = {
  runId: string;
  sourceId: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED';
  startedAt: string;
  completedAt?: string | null;
  observedAt?: string | null;
  checkpoint?: SourceCheckpoint | null;
  coverage: SourceCoverage;
  headStatus: SourceRunHeadStatus;
  rawCount: number;
  candidateCount: number;
  lineageCount?: number;
  warningCount: number;
  error?: string | null;
};

export type SourceHead = {
  sourceId: string;
  runId: string;
  observedAt: string;
  acceptedAt: string;
  checkpoint: SourceCheckpoint;
  coverage: SourceCoverage;
};

export function isNewerSourceObservation(candidateObservedAt: string, currentObservedAt: string): boolean {
  const candidate = Date.parse(candidateObservedAt);
  const current = Date.parse(currentObservedAt);
  if (!Number.isFinite(candidate) || !Number.isFinite(current)) return false;
  return candidate > current;
}

export function canAssertSourceAbsence(run: SourceRun): boolean {
  return run.status === 'COMPLETED'
    && run.coverage.mode === 'FULL'
    && run.coverage.completeness === 'COMPLETE'
    && run.headStatus === 'CURRENT';
}

export type RawRecord = {
  rawRecordId: string;
  runId: string;
  sourceId: string;
  sourceRecordId: string;
  sourceFingerprint: string;
  observedAt: string;
  payload: Record<string, unknown>;
};

export type NormalizedCandidateRecord = {
  candidateId: string;
  runId: string;
  sourceId: string;
  sourceRecordId: string;
  sourceFingerprint: string;
  status: 'VALID' | 'WARNING' | 'REJECTED';
  candidate: CatalogCandidate;
};
