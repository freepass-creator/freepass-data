export const DEFAULT_CATALOG_EXECUTION_WRITER = {
    id: 'service:freepass-data',
    kind: 'SERVICE'
};
export const LEGACY_CATALOG_WRITER_OWNERSHIP = {
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
    writerId;
    ownershipRevision;
    primaryWriterId;
    mode;
    reason;
    code = 'WRITER_OWNERSHIP_DENIED';
    constructor(writerId, ownershipRevision, primaryWriterId, mode, reason) {
        super(`Writer ${writerId} denied by catalog ownership r${ownershipRevision}: ${reason}`);
        this.writerId = writerId;
        this.ownershipRevision = ownershipRevision;
        this.primaryWriterId = primaryWriterId;
        this.mode = mode;
        this.reason = reason;
    }
}
export class WriterOwnershipConflictError extends Error {
    expectedRevision;
    actualRevision;
    code = 'WRITER_OWNERSHIP_CONFLICT';
    constructor(expectedRevision, actualRevision) {
        super(`Expected writer ownership revision ${expectedRevision}, actual ${actualRevision}`);
        this.expectedRevision = expectedRevision;
        this.actualRevision = actualRevision;
    }
}
export class WriterOwnershipTransferRejectedError extends Error {
    code = 'WRITER_OWNERSHIP_TRANSFER_REJECTED';
}
export class WriterOwnershipTransferIdempotencyConflictError extends Error {
    code = 'WRITER_OWNERSHIP_TRANSFER_IDEMPOTENCY_CONFLICT';
}
export function resolveExecutionWriter(actor, writer) {
    if (writer)
        return writer;
    if (actor.kind === 'SERVICE') {
        return {
            id: actor.id,
            kind: 'SERVICE'
        };
    }
    return DEFAULT_CATALOG_EXECUTION_WRITER;
}
export function effectiveCatalogWriterOwnership(stored) {
    return stored ?? structuredClone(LEGACY_CATALOG_WRITER_OWNERSHIP);
}
export function assertCatalogWriterOwnership(stored, writer) {
    const ownership = effectiveCatalogWriterOwnership(stored);
    if (ownership.mode === 'EXCLUSIVE') {
        if (writer.id !== ownership.primaryWriterId) {
            throw new WriterOwnershipDeniedError(writer.id, ownership.revision, ownership.primaryWriterId, ownership.mode, 'writer is not the exclusive Catalog writer');
        }
        return ownership;
    }
    if (!ownership.allowedWriterIds.includes(writer.id)) {
        throw new WriterOwnershipDeniedError(writer.id, ownership.revision, ownership.primaryWriterId, ownership.mode, 'writer is not in the migration writer allowlist');
    }
    return ownership;
}
export function assertWriterOwnershipTransferActor(actor, writer) {
    const actorAllowed = actor.kind === 'USER' ||
        (actor.kind === 'SERVICE' && actor.id === 'service:freepass-data');
    if (!actorAllowed) {
        throw new WriterOwnershipTransferRejectedError('ownership transfer requires a USER actor or service:freepass-data actor');
    }
    if (writer.id !== 'service:freepass-data') {
        throw new WriterOwnershipTransferRejectedError('ownership transfer must execute through service:freepass-data');
    }
}
