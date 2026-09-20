import type { ActorRef } from './catalog.js';

export type CatalogEntityType =
  | 'vehicle_model'
  | 'vehicle_asset'
  | 'product'
  | 'offer'
  | 'policy';

export type RevisionOrigin =
  | 'CANONICALIZATION'
  | 'MANUAL_COMMAND'
  | 'SOURCE_REFRESH'
  | 'OVERRIDE'
  | 'ROLLBACK'
  | 'MIGRATION';

export type EntityRevisionRecord = {
  revisionRecordId: string;
  entityType: CatalogEntityType;
  entityId: string;
  revision: number;
  previousRevision: number | null;
  snapshot: unknown;
  actor: ActorRef;
  reason: string;
  origin: RevisionOrigin;
  commandId: string;
  occurredAt: string;
  sourceBindingId?: string | null;
  sourceRunId?: string | null;
};
