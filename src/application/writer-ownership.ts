import { createHash, randomUUID } from 'node:crypto';
import type { CatalogStore } from '../ports/catalog-store.js';
import {
  assertWriterOwnershipTransferActor,
  effectiveCatalogWriterOwnership,
  resolveExecutionWriter,
  WriterOwnershipConflictError,
  WriterOwnershipTransferIdempotencyConflictError,
  WriterOwnershipTransferRejectedError,
  type TransferCatalogWriterOwnershipInput,
  type WriterOwnershipTransferReceipt
} from '../domain/writer-ownership.js';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)])
    );
  }
  return value;
}

function digest(value: unknown) {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}

export async function transferCatalogWriterOwnership(
  store: CatalogStore,
  input: TransferCatalogWriterOwnershipInput,
  now = new Date().toISOString()
): Promise<WriterOwnershipTransferReceipt> {
  if (!input.reason.trim()) {
    throw new WriterOwnershipTransferRejectedError('reason is required');
  }
  if (input.toWriterId !== 'service:freepass-data') {
    throw new WriterOwnershipTransferRejectedError(
      'Catalog ownership transfer baseline only supports service:freepass-data as the target'
    );
  }
  if (!Number.isFinite(Date.parse(now))) {
    throw new WriterOwnershipTransferRejectedError('transfer time is invalid');
  }

  const writer = resolveExecutionWriter(input.actor, input.writer);
  assertWriterOwnershipTransferActor(input.actor, writer);

  const requestDigest = digest({
    commandType: 'TRANSFER_CATALOG_WRITER_OWNERSHIP',
    expectedRevision: input.expectedRevision,
    toWriterId: input.toWriterId,
    actor: input.actor,
    writer,
    reason: input.reason
  });

  return store.transact(async (tx) => {
    const existing = await tx.getWriterOwnershipTransferReceipt(input.idempotencyKey);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        throw new WriterOwnershipTransferIdempotencyConflictError(
          `Idempotency key ${input.idempotencyKey} was reused with a different ownership transfer request`
        );
      }
      return existing;
    }

    const stored = await tx.getCatalogWriterOwnership();
    const current = effectiveCatalogWriterOwnership(stored);

    if (current.revision !== input.expectedRevision) {
      throw new WriterOwnershipConflictError(
        input.expectedRevision,
        current.revision
      );
    }

    if (
      current.mode === 'EXCLUSIVE' &&
      current.primaryWriterId === input.toWriterId
    ) {
      const receipt: WriterOwnershipTransferReceipt = {
        idempotencyKey: input.idempotencyKey,
        commandId: input.commandId,
        status: 'NO_CHANGE',
        requestDigest,
        scope: 'catalog',
        previousRevision: current.revision,
        revision: current.revision,
        previousWriterIds: structuredClone(current.previousWriterIds),
        primaryWriterId: current.primaryWriterId,
        writerId: writer.id,
        committedAt: now
      };
      await tx.putWriterOwnershipTransferReceipt(receipt);
      return receipt;
    }

    const previousWriterIds = [
      ...new Set([
        ...current.previousWriterIds,
        ...current.allowedWriterIds.filter((id) => id !== input.toWriterId),
        ...(current.primaryWriterId !== input.toWriterId
          ? [current.primaryWriterId]
          : [])
      ])
    ].sort();

    const next = {
      scope: 'catalog' as const,
      revision: current.revision + 1,
      mode: 'EXCLUSIVE' as const,
      primaryWriterId: input.toWriterId,
      allowedWriterIds: [input.toWriterId],
      previousWriterIds,
      effectiveAt: now,
      updatedAt: now,
      updatedBy: structuredClone(input.actor),
      reason: input.reason
    };

    if (stored) await tx.updateCatalogWriterOwnership(next);
    else await tx.putCatalogWriterOwnership(next);

    await tx.appendAudit({
      eventId: randomUUID(),
      commandId: input.commandId,
      actor: input.actor,
      writerId: writer.id,
      entityType: 'writer_ownership',
      entityId: 'catalog',
      action: 'CATALOG_WRITER_OWNERSHIP_TRANSFERRED',
      before: current,
      after: next,
      reason: input.reason,
      revisionBefore: current.revision,
      revisionAfter: next.revision,
      occurredAt: now
    });

    const receipt: WriterOwnershipTransferReceipt = {
      idempotencyKey: input.idempotencyKey,
      commandId: input.commandId,
      status: 'TRANSFERRED',
      requestDigest,
      scope: 'catalog',
      previousRevision: current.revision,
      revision: next.revision,
      previousWriterIds,
      primaryWriterId: next.primaryWriterId,
      writerId: writer.id,
      committedAt: now
    };
    await tx.putWriterOwnershipTransferReceipt(receipt);
    return receipt;
  });
}
