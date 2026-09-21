import type { ActorRef } from './catalog.js';

export type ExecutionWriterRef = {
  id: string;
  kind: 'SERVICE';
};

export type WriterOwnershipMode =
  | 'SHARED_MIGRATION'
  | 'EXCLUSIVE';

export type CatalogWriterOwnership = {
  scope: 'catalog';
  revision: number;
  mode: WriterOwnershipMode;
  primaryWriterId: string;
  allowedWriterIds: string[];
  previousWriterIds: string[];
  effectiveAt: string;
  updatedAt: string;
  updatedBy: ActorRef;
  reason: string;
};

export type TransferCatalogWriterOwnershipInput = {
  commandId: string;
  idempotencyKey: string;
  expectedRevision: number;
  toWriterId: string;
  actor: ActorRef;
  writer?: ExecutionWriterRef;
  reason: string;
};

export type WriterOwnershipTransferReceipt = {
  idempotencyKey: string;
  commandId: string;
  status: 'TRANSFERRED' | 'NO_CHANGE';
  requestDigest: string;
  scope: 'catalog';
  previousRevision: number;
  revision: number;
  previousWriterIds: string[];
  primaryWriterId: string;
  writerId: string;
  committedAt: string;
};

export const DEFAULT_CATALOG_EXECUTION_WRITER: ExecutionWriterRef = {
  id: 'service:freepass-data',
  kind: 'SERVICE'
};

export const LEGACY_CATALOG_WRITER_OWNERSHIP: CatalogWriterOwnership = {
  scope: 'catalog',
  revision: 0,
  mode: 'SHARED_MIGRATION',
  primaryWriterId: 'service:freepass-data',
  allowedWriterIds: [
    'service:freepass-data',
    'service:freepass-admin'
  ],
  previousWriterIds: [],
  effectiveAt: '1970-01-01T00:00:00.000Z',
  updatedAt: '1970-01-01T00:00:00.000Z',
  updatedBy: {
    id: 'service:freepass-data',
    kind: 'SERVICE'
  },
  reason: 'implicit pre-transfer compatibility baseline'
};

export class WriterOwnershipDeniedError extends Error {
  readonly code = 'WRITER_OWNERSHIP_DENIED';

  constructor(
    readonly writerId: string,
    readonly ownershipRevision: number,
    readonly primaryWriterId: string,
    readonly mode: WriterOwnershipMode,
    readonly reason: string
  ) {
    super(
      `Writer ${writerId} denied by catalog ownership r${ownershipRevision}: ${reason}`
    );
  }
}

export class WriterOwnershipConflictError extends Error {
  readonly code = 'WRITER_OWNERSHIP_CONFLICT';

  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(
      `Expected writer ownership revision ${expectedRevision}, actual ${actualRevision}`
    );
  }
}

export class WriterOwnershipTransferRejectedError extends Error {
  readonly code = 'WRITER_OWNERSHIP_TRANSFER_REJECTED';
}

export class WriterOwnershipTransferIdempotencyConflictError extends Error {
  readonly code = 'WRITER_OWNERSHIP_TRANSFER_IDEMPOTENCY_CONFLICT';
}

export function resolveExecutionWriter(
  actor: ActorRef,
  writer?: ExecutionWriterRef
): ExecutionWriterRef {
  if (writer) return writer;
  if (actor.kind === 'SERVICE') {
    return {
      id: actor.id,
      kind: 'SERVICE'
    };
  }
  return DEFAULT_CATALOG_EXECUTION_WRITER;
}

export function effectiveCatalogWriterOwnership(
  stored: CatalogWriterOwnership | null
): CatalogWriterOwnership {
  return stored ?? structuredClone(LEGACY_CATALOG_WRITER_OWNERSHIP);
}

export function assertCatalogWriterOwnership(
  stored: CatalogWriterOwnership | null,
  writer: ExecutionWriterRef
): CatalogWriterOwnership {
  const ownership = effectiveCatalogWriterOwnership(stored);

  if (ownership.mode === 'EXCLUSIVE') {
    if (writer.id !== ownership.primaryWriterId) {
      throw new WriterOwnershipDeniedError(
        writer.id,
        ownership.revision,
        ownership.primaryWriterId,
        ownership.mode,
        'writer is not the exclusive Catalog writer'
      );
    }
    return ownership;
  }

  if (!ownership.allowedWriterIds.includes(writer.id)) {
    throw new WriterOwnershipDeniedError(
      writer.id,
      ownership.revision,
      ownership.primaryWriterId,
      ownership.mode,
      'writer is not in the migration writer allowlist'
    );
  }
  return ownership;
}

export function assertWriterOwnershipTransferActor(
  actor: ActorRef,
  writer: ExecutionWriterRef
) {
  const actorAllowed =
    actor.kind === 'USER' ||
    (actor.kind === 'SERVICE' && actor.id === 'service:freepass-data');

  if (!actorAllowed) {
    throw new WriterOwnershipTransferRejectedError(
      'ownership transfer requires a USER actor or service:freepass-data actor'
    );
  }
  if (writer.id !== 'service:freepass-data') {
    throw new WriterOwnershipTransferRejectedError(
      'ownership transfer must execute through service:freepass-data'
    );
  }
}
