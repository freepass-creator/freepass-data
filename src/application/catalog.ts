import { createHash, randomUUID } from 'node:crypto';
import type { ActorRef, ErpPublicProduct, Money, Offer, ProjectionRelease } from '../domain/catalog.js';
import { assertFieldAuthority } from '../domain/authority.js';
import type { CatalogStore, OutboxStore, ProjectionStore } from '../ports/catalog-store.js';

export type UpdateOfferPriceInput = {
  commandId: string; idempotencyKey: string; offerId: string; expectedRevision: number;
  termKey: string; monthlyRent: Money; reason: string; actor: ActorRef;
};
export class RevisionConflictError extends Error {
  readonly code = 'REVISION_CONFLICT';
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Expected revision ${expectedRevision}, actual ${actualRevision}`);
  }
}
export class EntityNotFoundError extends Error { readonly code = 'ENTITY_NOT_FOUND'; }
export class InvalidCommandError extends Error { readonly code = 'INVALID_COMMAND'; }
export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor(readonly idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was already used with a different request payload`);
  }
}

function revisionRecordId(
  commandId: string,
  entityType: string,
  entityId: string,
  revision: number
) {
  return 'rev_' + createHash('sha256')
    .update([commandId, entityType, entityId, String(revision)].join('|'))
    .digest('hex')
    .slice(0, 32);
}

function updateOfferPriceDigest(input: UpdateOfferPriceInput) {
  return createHash('sha256').update(JSON.stringify({
    commandType: 'UPDATE_OFFER_PRICE',
    offerId: input.offerId,
    expectedRevision: input.expectedRevision,
    termKey: input.termKey,
    monthlyRent: {
      amount: input.monthlyRent.amount,
      currency: input.monthlyRent.currency
    },
    reason: input.reason,
    actor: {
      id: input.actor.id,
      kind: input.actor.kind,
      organizationId: input.actor.organizationId ?? null
    }
  })).digest('hex');
}

function replacePriceTerm(offer: Offer, termKey: string, monthlyRent: Money): Offer {
  if (!offer.priceTerms.some((term) => term.termKey === termKey)) {
    throw new InvalidCommandError(`Offer ${offer.id} has no PriceTerm key ${termKey}; adding a commercial condition is a separate command.`);
  }
  return {...offer, priceTerms: offer.priceTerms.map((term) => term.termKey === termKey ? {...term, monthlyRent} : term)};
}

export async function updateOfferPrice(store: CatalogStore, input: UpdateOfferPriceInput, now = new Date().toISOString()) {
  if (input.monthlyRent.currency !== 'KRW' || !Number.isInteger(input.monthlyRent.amount) || input.monthlyRent.amount < 0) {
    throw new InvalidCommandError('monthlyRent must be a non-negative integer KRW amount');
  }
  if (!input.reason.trim()) throw new InvalidCommandError('reason is required');
  const authority = assertFieldAuthority({
    aggregate: 'offer',
    fieldPath: `priceTerms.${input.termKey}.monthlyRent`,
    command: 'UPDATE_OFFER_PRICE',
    actor: input.actor
  });
  const requestDigest = updateOfferPriceDigest(input);

  return store.transact(async (tx) => {
    const existingReceipt = await tx.getCommandReceipt(input.idempotencyKey);
    if (existingReceipt) {
      if (!existingReceipt.requestDigest || existingReceipt.requestDigest !== requestDigest) {
        throw new IdempotencyConflictError(input.idempotencyKey);
      }
      return existingReceipt;
    }
    const current = await tx.getOffer(input.offerId);
    if (!current) throw new EntityNotFoundError(`Offer not found: ${input.offerId}`);
    if (current.revision !== input.expectedRevision) throw new RevisionConflictError(input.expectedRevision, current.revision);

    const next: Offer = {
      ...replacePriceTerm(current, input.termKey, input.monthlyRent),
      revision: current.revision + 1, updatedAt: now, updatedBy: input.actor
    };
    const receipt = {
      idempotencyKey: input.idempotencyKey, commandId: input.commandId,
      status: 'CANONICAL_COMMITTED' as const, entityType: 'offer', entityId: current.id,
      revision: next.revision, committedAt: now, requestDigest,
      authorityRuleId: authority.ruleId
    };
    await tx.putOffer(next);
    await tx.appendRevision({
      revisionRecordId: revisionRecordId(
        input.commandId,
        'offer',
        current.id,
        next.revision
      ),
      entityType: 'offer',
      entityId: current.id,
      revision: next.revision,
      previousRevision: current.revision,
      snapshot: next,
      actor: input.actor,
      reason: input.reason,
      origin: 'MANUAL_COMMAND',
      commandId: input.commandId,
      occurredAt: now
    });
    await tx.appendAudit({
      eventId: randomUUID(), commandId: input.commandId, actor: input.actor,
      entityType: 'offer', entityId: current.id, action: 'OFFER_PRICE_UPDATED',
      before: current, after: next, reason: input.reason,
      authorityRuleId: authority.ruleId,
      revisionBefore: current.revision, revisionAfter: next.revision, occurredAt: now
    });
    await tx.appendOutbox({
      eventId: randomUUID(), eventType: 'catalog.offer.changed', entityType: 'offer', entityId: current.id,
      sourceRevision: current.revision, targetRevision: next.revision, commandId: input.commandId,
      correlationId: input.commandId, causationId: input.commandId, occurredAt: now, status: 'PENDING', attempts: 0
    });
    await tx.putCommandReceipt(receipt);
    return receipt;
  });
}

function activeOffer(offer: Offer, now: string) {
  if (offer.status !== 'ACTIVE' || offer.validationStatus === 'INVALID') return false;
  if (offer.validFrom && offer.validFrom > now) return false;
  if (offer.validUntil && offer.validUntil <= now) return false;
  return true;
}

function publicPriceTerms(offer: Offer) {
  return offer.priceTerms.filter((term) =>
    term.depositState === 'KNOWN' ||
    term.depositState === 'ZERO' ||
    term.depositState === 'NOT_APPLICABLE'
  );
}

export async function buildErpPublicProjection(
  catalog: CatalogStore, projections: ProjectionStore, now = new Date().toISOString()
): Promise<ProjectionRelease<ErpPublicProduct>> {
  const [models, assets, products, offers] = await Promise.all([
    catalog.listVehicleModels(), catalog.listVehicleAssets(), catalog.listProducts(), catalog.listOffers()
  ]);
  const modelById = new Map(models.map((x) => [x.id, x]));
  const assetById = new Map(assets.map((x) => [x.id, x]));
  const offersByProduct = new Map<string, Offer[]>();
  for (const offer of offers.filter((x) => activeOffer(x, now))) {
    const list = offersByProduct.get(offer.productId) ?? [];
    list.push(offer);
    offersByProduct.set(offer.productId, list);
  }

  const data: ErpPublicProduct[] = [];
  for (const product of products) {
    if (product.status !== 'ACTIVE' || product.validationStatus === 'INVALID') continue;
    const model = modelById.get(product.vehicleModelId);
    if (!model || model.validationStatus === 'INVALID') continue;
    const asset = product.vehicleAssetId ? assetById.get(product.vehicleAssetId) : undefined;
    if (product.vehicleAssetId && !asset) continue;
    if (asset && asset.status !== 'AVAILABLE') continue;

    const productOffers = (offersByProduct.get(product.id) ?? [])
      .map((offer) => ({ offer, terms: publicPriceTerms(offer) }))
      .filter(({ terms }) => terms.length > 0);
    if (!productOffers.length) continue;

    data.push({
      productId: product.id,
      productRevision: product.revision,
      vehicleModelId: model.id,
      ...(product.vehicleAssetId ? {vehicleAssetId: product.vehicleAssetId} : {}),
      displayName: product.displayName,
      commercialType: product.commercialType,
      vehicle: {
        maker: model.maker, model: model.model,
        ...(model.generation !== undefined ? {generation: model.generation} : {}),
        ...(model.subModel !== undefined ? {subModel: model.subModel} : {}),
        ...(model.trim !== undefined ? {trim: model.trim} : {}),
        ...(model.fuel !== undefined ? {fuel: model.fuel} : {}),
        ...(model.drive !== undefined ? {drive: model.drive} : {}),
        ...(model.seats !== undefined ? {seats: model.seats} : {}),
        ...(asset ? {
          assetStatus: asset.status,
          ...(asset.plateNumber !== undefined ? {plateNumber: asset.plateNumber} : {}),
          ...(asset.odometerKm !== undefined ? {odometerKm: asset.odometerKm} : {})
        } : {})
      },
      offers: productOffers.map(({ offer, terms }) => ({
        offerId: offer.id,
        supplierId: offer.supplierId,
        offerRevision: offer.revision,
        ...(offer.policyId !== undefined ? {policyId: offer.policyId} : {}),
        priceTerms: terms
      }))
    });
  }

  const canonicalRevision = Math.max(0, ...models.map(x=>x.revision), ...assets.map(x=>x.revision), ...products.map(x=>x.revision), ...offers.map(x=>x.revision));
  const release: ProjectionRelease<ErpPublicProduct> = {
    releaseId: `rel_${randomUUID()}`, projectionId: 'erp-public', schemaVersion: '1.0.0',
    canonicalRevision, status: 'BUILDING', generatedAt: now, data
  };
  await projections.stage(release);
  await projections.markReady(release.releaseId);
  await projections.activate(release.releaseId);
  const active = await projections.getActive('erp-public');
  if (!active) throw new Error('Projection activation failed');
  return active;
}

function backoffMs(base: number, attempts: number) {
  const capped = Math.min(attempts, 8);
  return base * 2 ** capped + Math.floor(base * 0.2 * Math.random());
}
export async function processOneOutboxEvent(
  catalog: CatalogStore, outbox: OutboxStore, projections: ProjectionStore,
  options: {workerId: string; maxAttempts?: number; baseBackoffMs?: number; leaseMs?: number}, now = new Date()
): Promise<'IDLE'|'DONE'|'RETRY'|'DEAD_LETTER'> {
  const event = await outbox.claimNext({
    workerId: options.workerId, now: now.toISOString(),
    leaseUntil: new Date(now.getTime() + (options.leaseMs ?? 30000)).toISOString()
  });
  if (!event) return 'IDLE';
  const attempts = event.attempts + 1;
  try {
    if (event.eventType.startsWith('catalog.')) await buildErpPublicProjection(catalog, projections, now.toISOString());
    await outbox.markDone(event.eventId); return 'DONE';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (attempts >= (options.maxAttempts ?? 8)) {
      await outbox.moveToDeadLetter({eventId:event.eventId,attempts,error:message}); return 'DEAD_LETTER';
    }
    await outbox.markRetry({
      eventId:event.eventId,attempts,
      nextAttemptAt:new Date(now.getTime()+backoffMs(options.baseBackoffMs ?? 500,attempts)).toISOString(),
      error:message
    });
    return 'RETRY';
  }
}
