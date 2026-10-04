import { createHash, randomUUID } from 'node:crypto';
import type { ActorRef, CommandReceipt, Product, VehicleModel } from '../domain/catalog.js';
import { assertFieldAuthority } from '../domain/authority.js';
import { assertCatalogWriterOwnership, resolveExecutionWriter, type ExecutionWriterRef } from '../domain/writer-ownership.js';
import type { CatalogStore } from '../ports/catalog-store.js';
import { stableDigest } from '../shared/stable-digest.js';
import { EntityNotFoundError, IdempotencyConflictError, InvalidCommandError, RevisionConflictError } from './catalog.js';

/**
 * Renames a Canonical VehicleModel's 세부모델/세부트림 to the current F03 name («값 하나»). Source refresh blocks these
 * shared-model fields (SHARED_MODEL_CHANGE_REQUIRES_SEPARATE_COMMAND); this is that separate, reviewed command.
 * Products that copy the model's displayName are updated in the same transaction.
 */
export type RenameVehicleModelInput = {
  commandId: string; idempotencyKey: string;
  vehicleModelId: string; expectedRevision: number;
  subModel?: string; trim?: string;
  /** Every Product that references this model, with its expected revision (displayName follows the model). */
  products: Array<{ productId: string; expectedRevision: number }>;
  reason: string; actor: ActorRef; writer?: ExecutionWriterRef;
};

const text = (v: unknown) => String(v ?? '').trim();
const revisionId = (commandId: string, entityType: string, entityId: string, revision: number) =>
  'rev_' + createHash('sha256').update([commandId, entityType, entityId, String(revision)].join('|')).digest('hex').slice(0, 32);

export async function renameVehicleModel(store: CatalogStore, input: RenameVehicleModelInput,
  now = new Date().toISOString()): Promise<CommandReceipt> {
  if (!input.reason.trim()) throw new InvalidCommandError('reason is required');
  if (input.subModel === undefined && input.trim === undefined) throw new InvalidCommandError('subModel or trim is required');
  for (const v of [input.subModel, input.trim]) if (v !== undefined && !text(v)) throw new InvalidCommandError('names must be non-empty');
  const fields = [...(input.subModel !== undefined ? ['subModel'] : []), ...(input.trim !== undefined ? ['trim'] : [])];
  const authority = fields.map((fieldPath) => assertFieldAuthority({ aggregate: 'vehicle_model', fieldPath,
    command: 'RENAME_VEHICLE_MODEL', actor: input.actor }))[0]!;
  const writer = resolveExecutionWriter(input.actor, input.writer);
  const requestDigest = stableDigest({ commandType: 'RENAME_VEHICLE_MODEL', ...input, writerId: writer.id });

  return store.transact(async (tx) => {
    assertCatalogWriterOwnership(await tx.getCatalogWriterOwnership(), writer);
    const existing = await tx.getCommandReceipt(input.idempotencyKey);
    if (existing) {
      if (existing.requestDigest !== requestDigest) throw new IdempotencyConflictError(input.idempotencyKey);
      return existing;
    }
    const current = await tx.getVehicleModel(input.vehicleModelId);
    if (!current) throw new EntityNotFoundError(`VehicleModel not found: ${input.vehicleModelId}`);
    if (current.revision !== input.expectedRevision) throw new RevisionConflictError(input.expectedRevision, current.revision);
    const subModel = input.subModel !== undefined ? text(input.subModel) : current.subModel ?? null;
    const trim = input.trim !== undefined ? text(input.trim) : current.trim ?? null;
    if (subModel === (current.subModel ?? null) && trim === (current.trim ?? null)) throw new InvalidCommandError('no-op rename');
    const displayName = [current.maker, current.model, subModel, trim].filter(Boolean).join(' ');
    const next: VehicleModel = { ...current, subModel, trim, displayName, revision: current.revision + 1, updatedAt: now, updatedBy: input.actor };

    const products: Array<[Product, Product]> = [];
    for (const ref of input.products) {
      const product = await tx.getProduct(ref.productId);
      if (!product || product.vehicleModelId !== current.id) throw new InvalidCommandError(`product ${ref.productId} does not reference the model`);
      if (product.revision !== ref.expectedRevision) throw new RevisionConflictError(ref.expectedRevision, product.revision);
      products.push([product, { ...product, displayName, revision: product.revision + 1, updatedAt: now, updatedBy: input.actor }]);
    }

    await tx.putVehicleModel(next);
    await tx.appendRevision({ revisionRecordId: revisionId(input.commandId, 'vehicle_model', current.id, next.revision),
      entityType: 'vehicle_model', entityId: current.id, revision: next.revision, previousRevision: current.revision,
      snapshot: next, actor: input.actor, reason: input.reason, origin: 'MANUAL_COMMAND', commandId: input.commandId, occurredAt: now });
    await tx.appendAudit({ eventId: randomUUID(), commandId: input.commandId, actor: input.actor, entityType: 'vehicle_model',
      entityId: current.id, action: 'VEHICLE_MODEL_RENAMED', before: current, after: next, reason: input.reason, writerId: writer.id,
      authorityRuleId: authority.ruleId, revisionBefore: current.revision, revisionAfter: next.revision, occurredAt: now });
    for (const [before, after] of products) {
      await tx.putProduct(after);
      await tx.appendRevision({ revisionRecordId: revisionId(input.commandId, 'product', before.id, after.revision),
        entityType: 'product', entityId: before.id, revision: after.revision, previousRevision: before.revision,
        snapshot: after, actor: input.actor, reason: input.reason, origin: 'MANUAL_COMMAND', commandId: input.commandId, occurredAt: now });
    }
    await tx.appendOutbox({ eventId: randomUUID(), eventType: 'catalog.vehicle-model.changed', entityType: 'vehicle_model',
      entityId: current.id, sourceRevision: current.revision, targetRevision: next.revision, commandId: input.commandId,
      correlationId: input.commandId, causationId: input.commandId, occurredAt: now, status: 'PENDING', attempts: 0 });
    const receipt: CommandReceipt = { idempotencyKey: input.idempotencyKey, commandId: input.commandId, status: 'CANONICAL_COMMITTED',
      entityType: 'vehicle_model', entityId: current.id, revision: next.revision, committedAt: now, requestDigest,
      writerId: writer.id, authorityRuleId: authority.ruleId };
    await tx.putCommandReceipt(receipt);
    return receipt;
  });
}
