import type { ActorRef } from './catalog.js';

export type DataAccessMode = 'READ' | 'WRITE';
export type DataAccessPhase = 'STARTED' | 'SUCCEEDED' | 'DENIED' | 'FAILED';

export type DataAccessResource = {
  kind: 'CATALOG' | 'PROJECTION' | 'HEALTH' | 'COMMAND' | 'SOURCE' | 'STORAGE' | 'SYSTEM';
  name: string;
  entityType?: string;
  entityId?: string;
  projectionId?: string;
};

export type DataAccessContext = {
  actor: ActorRef;
  clientId: string;
  purpose: string;
  requestId?: string;
  correlationId?: string;
};

export type DataAccessResultEvidence = {
  count?: number;
  digest?: string;
  inputDigest?: string;
  releaseId?: string;
  manifestId?: string;
  revision?: number;
};

export type DataAccessEvent = {
  contractVersion: 'data-access-event-v1';
  eventId: string;
  operationId: string;
  mode: DataAccessMode;
  phase: DataAccessPhase;
  operation: string;
  actor: ActorRef;
  clientId: string;
  purpose: string;
  resource: DataAccessResource;
  requestId?: string;
  correlationId?: string;
  requestDigest?: string;
  result?: DataAccessResultEvidence;
  reasonCode?: string;
  startedAt: string;
  occurredAt: string;
};

export class DataAccessAuditUnavailableError extends Error {
  readonly code = 'DATA_ACCESS_AUDIT_UNAVAILABLE';
}

export class DataAccessDeniedError extends Error {
  readonly code = 'DATA_ACCESS_DENIED';
}
