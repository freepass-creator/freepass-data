import type { SourceCheckpoint } from '../migration/shadow.js';
import type { LegacyCatalogCandidate } from '../adapters/legacy-normalizer.js';

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
  rawCount: number;
  candidateCount: number;
  lineageCount?: number;
  warningCount: number;
  error?: string | null;
};

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
  candidate: LegacyCatalogCandidate;
};
