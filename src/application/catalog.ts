import { createHash, randomUUID } from 'node:crypto';
import { stableDigest, stableRecordSetDigest, stableValue } from '../shared/stable-digest.js';
import { readActiveProjectionEvidence, verifyProjectionReleaseIntegrity } from './projection-integrity.js';
import type {
  ActorRef,
  ErpPublicProduct,
  Money,
  Offer,
  Product,
  ProjectionRelease,
  VehicleAsset,
  VehicleModel
} from '../domain/catalog.js';
import { assertFieldAuthority } from '../domain/authority.js';
import {
  assertCatalogWriterOwnership,
  resolveExecutionWriter,
  type ExecutionWriterRef
} from '../domain/writer-ownership.js';
import type { CatalogStore, OutboxStore, ProjectionStore } from '../ports/catalog-store.js';
import type { CatalogEntityType, EntityRevisionRecord } from '../domain/history.js';
import type { FieldLineageRecord } from '../domain/lineage.js';
import type {
  ProjectionCanonicalInput,
  ProjectionFieldLineageRecord,
  ProjectionReleaseManifest
} from '../domain/projection-evidence.js';

export type UpdateOfferPriceInput = {
  commandId: string; idempotencyKey: string; offerId: string; expectedRevision: number;
  termKey: string; monthlyRent: Money; reason: string; actor: ActorRef;
  writer?: ExecutionWriterRef;
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

function updateOfferPriceDigest(input: UpdateOfferPriceInput, writerId: string) {
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
    },
    writerId
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
  const writer = resolveExecutionWriter(input.actor, input.writer);
  const requestDigest = updateOfferPriceDigest(input, writer.id);

  return store.transact(async (tx) => {
    assertCatalogWriterOwnership(
      await tx.getCatalogWriterOwnership(),
      writer
    );
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
      writerId: writer.id,
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
      writerId: writer.id,
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
  return offer.priceTerms
    .filter((term) =>
      term.depositState === 'KNOWN' ||
      term.depositState === 'ZERO' ||
      term.depositState === 'NOT_APPLICABLE'
    )
    .sort((a, b) =>
      a.termMonths - b.termMonths ||
      (a.mileageLimitKmPerYear ?? -1) - (b.mileageLimitKmPerYear ?? -1) ||
      a.termKey.localeCompare(b.termKey)
    );
}

function canonicalInputKey(entityType: CatalogEntityType, entityId: string, revision: number) {
  return `${entityType}|${entityId}|${revision}`;
}

function fieldEvidenceKey(
  entityType: CatalogEntityType,
  entityId: string,
  revision: number,
  fieldPath: string
) {
  return `${canonicalInputKey(entityType, entityId, revision)}|${fieldPath}`;
}

function sameEvidenceValue(a: unknown, b: unknown) {
  return JSON.stringify(stableValue(a)) === JSON.stringify(stableValue(b));
}

function buildProjectionEvidenceContext(input: {
  releaseId: string;
  sourceLineage: FieldLineageRecord[];
  revisionHistory: EntityRevisionRecord[];
}) {
  const lineageByField = new Map<string, FieldLineageRecord[]>();
  for (const item of input.sourceLineage) {
    const canonical = item.canonical;
    if (!canonical || item.stage !== 'NORMALIZED_TO_CANONICAL') continue;
    const key = fieldEvidenceKey(
      canonical.entityType as CatalogEntityType,
      canonical.entityId,
      canonical.revision,
      canonical.fieldPath
    );
    const list = lineageByField.get(key) ?? [];
    list.push(item);
    lineageByField.set(key, list);
  }

  const revisionByEntity = new Map<string, EntityRevisionRecord>();
  for (const record of input.revisionHistory) {
    revisionByEntity.set(
      canonicalInputKey(record.entityType, record.entityId, record.revision),
      record
    );
  }

  const canonicalInputs = new Map<string, ProjectionCanonicalInput>();
  const evidence: ProjectionFieldLineageRecord[] = [];

  const requireRevision = (
    entityType: CatalogEntityType,
    entity: VehicleModel | VehicleAsset | Product | Offer
  ) => {
    const key = canonicalInputKey(entityType, entity.id, entity.revision);
    const record = revisionByEntity.get(key);
    if (!record) {
      throw new Error(
        `Projection release cannot use ${entityType} ${entity.id} r${entity.revision} without a revision snapshot`
      );
    }
    if (!sameEvidenceValue(record.snapshot, entity)) {
      throw new Error(
        `Projection release detected snapshot drift for ${entityType} ${entity.id} r${entity.revision}`
      );
    }
    canonicalInputs.set(key, {
      entityType,
      entityId: entity.id,
      revision: entity.revision,
      validationStatus: entity.validationStatus
    });
    return record;
  };

  const addField = (inputField: {
    entityType: CatalogEntityType;
    entityId: string;
    revision: number;
    fieldPath: string;
    canonicalValue: unknown;
    projectionFieldPath: string;
    projectionValue: unknown;
  }) => {
    const key = fieldEvidenceKey(
      inputField.entityType,
      inputField.entityId,
      inputField.revision,
      inputField.fieldPath
    );
    const parent = (lineageByField.get(key) ?? []).find((item) =>
      sameEvidenceValue(item.canonical?.value, inputField.canonicalValue)
    );
    const revisionRecord = revisionByEntity.get(
      canonicalInputKey(
        inputField.entityType,
        inputField.entityId,
        inputField.revision
      )
    );
    if (!parent && !revisionRecord) {
      throw new Error(
        `Projection field has no Canonical evidence: ${key}`
      );
    }

    const lineageRecordId = 'plin_' + stableDigest([
      input.releaseId,
      key,
      inputField.projectionFieldPath
    ]).slice(0, 40);

    evidence.push({
      lineageRecordId,
      stage: 'CANONICAL_TO_PROJECTION',
      projectionId: 'erp-public',
      releaseId: input.releaseId,
      canonical: {
        entityType: inputField.entityType,
        entityId: inputField.entityId,
        revision: inputField.revision,
        fieldPath: inputField.fieldPath,
        value: structuredClone(inputField.canonicalValue)
      },
      projection: {
        fieldPath: inputField.projectionFieldPath,
        value: structuredClone(inputField.projectionValue)
      },
      evidenceOrigin: parent ? 'SOURCE_LINEAGE' : 'REVISION_HISTORY',
      ...(parent ? { parentLineageRecordId: parent.lineageRecordId } : {}),
      ...(revisionRecord ? { revisionRecordId: revisionRecord.revisionRecordId } : {})
    });
  };

  return { canonicalInputs, evidence, requireRevision, addField };
}

export async function buildErpPublicProjection(
  catalog: CatalogStore, projections: ProjectionStore, now = new Date().toISOString()
): Promise<ProjectionRelease<ErpPublicProduct>> {
  const releaseId = `rel_${randomUUID()}`;
  const [models, assets, products, offers, sourceLineage, revisionHistory] = await Promise.all([
    catalog.listVehicleModels(),
    catalog.listVehicleAssets(),
    catalog.listProducts(),
    catalog.listOffers(),
    catalog.listLineageByStage('NORMALIZED_TO_CANONICAL'),
    catalog.listRevisionHistory()
  ]);

  const modelById = new Map(models.map((x) => [x.id, x]));
  const assetById = new Map(assets.map((x) => [x.id, x]));
  const offersByProduct = new Map<string, Offer[]>();
  for (const offer of offers.filter((x) => activeOffer(x, now)).sort((a, b) => a.id.localeCompare(b.id))) {
    const list = offersByProduct.get(offer.productId) ?? [];
    list.push(offer);
    offersByProduct.set(offer.productId, list);
  }

  const evidenceContext = buildProjectionEvidenceContext({
    releaseId,
    sourceLineage,
    revisionHistory
  });

  const data: ErpPublicProduct[] = [];
  for (const product of [...products].sort((a, b) => a.id.localeCompare(b.id))) {
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

    evidenceContext.requireRevision('product', product);
    evidenceContext.requireRevision('vehicle_model', model);
    if (asset) evidenceContext.requireRevision('vehicle_asset', asset);
    for (const { offer } of productOffers) evidenceContext.requireRevision('offer', offer);

    const productPath = `products.${product.id}`;
    evidenceContext.addField({
      entityType: 'product',
      entityId: product.id,
      revision: product.revision,
      fieldPath: 'id',
      canonicalValue: product.id,
      projectionFieldPath: `${productPath}.productId`,
      projectionValue: product.id
    });
    evidenceContext.addField({
      entityType: 'product',
      entityId: product.id,
      revision: product.revision,
      fieldPath: 'revision',
      canonicalValue: product.revision,
      projectionFieldPath: `${productPath}.productRevision`,
      projectionValue: product.revision
    });
    evidenceContext.addField({
      entityType: 'product',
      entityId: product.id,
      revision: product.revision,
      fieldPath: 'vehicleModelId',
      canonicalValue: product.vehicleModelId,
      projectionFieldPath: `${productPath}.vehicleModelId`,
      projectionValue: model.id
    });
    if (product.vehicleAssetId) {
      evidenceContext.addField({
        entityType: 'product',
        entityId: product.id,
        revision: product.revision,
        fieldPath: 'vehicleAssetId',
        canonicalValue: product.vehicleAssetId,
        projectionFieldPath: `${productPath}.vehicleAssetId`,
        projectionValue: product.vehicleAssetId
      });
    }
    evidenceContext.addField({
      entityType: 'product',
      entityId: product.id,
      revision: product.revision,
      fieldPath: 'displayName',
      canonicalValue: product.displayName,
      projectionFieldPath: `${productPath}.displayName`,
      projectionValue: product.displayName
    });
    evidenceContext.addField({
      entityType: 'product',
      entityId: product.id,
      revision: product.revision,
      fieldPath: 'commercialType',
      canonicalValue: product.commercialType,
      projectionFieldPath: `${productPath}.commercialType`,
      projectionValue: product.commercialType
    });

    const vehiclePath = `${productPath}.vehicle`;
    const modelFields: Array<[string, unknown, string]> = [
      ['maker', model.maker, 'maker'],
      ['model', model.model, 'model']
    ];
    if (model.generation !== undefined) modelFields.push(['generation', model.generation, 'generation']);
    if (model.subModel !== undefined) modelFields.push(['subModel', model.subModel, 'subModel']);
    if (model.trim !== undefined) modelFields.push(['trim', model.trim, 'trim']);
    if (model.fuel !== undefined) modelFields.push(['fuel', model.fuel, 'fuel']);
    if (model.drive !== undefined) modelFields.push(['drive', model.drive, 'drive']);
    if (model.seats !== undefined) modelFields.push(['seats', model.seats, 'seats']);
    for (const [fieldPath, value, projected] of modelFields) {
      evidenceContext.addField({
        entityType: 'vehicle_model',
        entityId: model.id,
        revision: model.revision,
        fieldPath,
        canonicalValue: value,
        projectionFieldPath: `${vehiclePath}.${projected}`,
        projectionValue: value
      });
    }

    if (asset) {
      const assetFields: Array<[string, unknown, string]> = [
        ['status', asset.status, 'assetStatus']
      ];
      if (asset.plateNumber !== undefined) assetFields.push(['plateNumber', asset.plateNumber, 'plateNumber']);
      if (asset.odometerKm !== undefined) assetFields.push(['odometerKm', asset.odometerKm, 'odometerKm']);
      for (const [fieldPath, value, projected] of assetFields) {
        evidenceContext.addField({
          entityType: 'vehicle_asset',
          entityId: asset.id,
          revision: asset.revision,
          fieldPath,
          canonicalValue: value,
          projectionFieldPath: `${vehiclePath}.${projected}`,
          projectionValue: value
        });
      }
    }

    for (const { offer, terms } of productOffers) {
      const offerPath = `${productPath}.offers.${offer.id}`;
      const offerFields: Array<[string, unknown, string]> = [
        ['id', offer.id, 'offerId'],
        ['supplierId', offer.supplierId, 'supplierId'],
        ['revision', offer.revision, 'offerRevision']
      ];
      if (offer.policyId !== undefined) offerFields.push(['policyId', offer.policyId, 'policyId']);
      for (const [fieldPath, value, projected] of offerFields) {
        evidenceContext.addField({
          entityType: 'offer',
          entityId: offer.id,
          revision: offer.revision,
          fieldPath,
          canonicalValue: value,
          projectionFieldPath: `${offerPath}.${projected}`,
          projectionValue: value
        });
      }

      for (const term of terms) {
        const canonicalPrefix = `priceTerms.${term.termKey}`;
        const projectionPrefix = `${offerPath}.priceTerms.${term.termKey}`;
        const termFields: Array<[string, unknown, string, unknown]> = [
          [`${canonicalPrefix}.termKey`, term.termKey, `${projectionPrefix}.termKey`, term.termKey],
          [`${canonicalPrefix}.termMonths`, term.termMonths, `${projectionPrefix}.termMonths`, term.termMonths],
          [`${canonicalPrefix}.monthlyRent.amount`, term.monthlyRent.amount, `${projectionPrefix}.monthlyRent.amount`, term.monthlyRent.amount],
          [`${canonicalPrefix}.monthlyRent.currency`, term.monthlyRent.currency, `${projectionPrefix}.monthlyRent.currency`, term.monthlyRent.currency],
          [`${canonicalPrefix}.depositState`, term.depositState, `${projectionPrefix}.depositState`, term.depositState]
        ];
        if (term.deposit) {
          termFields.push(
            [`${canonicalPrefix}.deposit.amount`, term.deposit.amount, `${projectionPrefix}.deposit.amount`, term.deposit.amount],
            [`${canonicalPrefix}.deposit.currency`, term.deposit.currency, `${projectionPrefix}.deposit.currency`, term.deposit.currency]
          );
        }
        if (term.mileageLimitKmPerYear !== undefined && term.mileageLimitKmPerYear !== null) {
          termFields.push([
            `${canonicalPrefix}.mileageLimitKmPerYear`,
            term.mileageLimitKmPerYear,
            `${projectionPrefix}.mileageLimitKmPerYear`,
            term.mileageLimitKmPerYear
          ]);
        }
        for (const [canonicalFieldPath, canonicalValue, projectionFieldPath, projectionValue] of termFields) {
          evidenceContext.addField({
            entityType: 'offer',
            entityId: offer.id,
            revision: offer.revision,
            fieldPath: canonicalFieldPath,
            canonicalValue,
            projectionFieldPath,
            projectionValue
          });
        }
      }
    }

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

  const canonicalInputs = [...evidenceContext.canonicalInputs.values()]
    .sort((a, b) =>
      a.entityType.localeCompare(b.entityType) ||
      a.entityId.localeCompare(b.entityId) ||
      a.revision - b.revision
    );
  const inputDigest = stableDigest(canonicalInputs);
  const dataDigest = stableDigest(data);
  const canonicalRevision = Math.max(0, ...canonicalInputs.map((x) => x.revision));
  const currentEvidence = await readActiveProjectionEvidence(
    projections,
    'erp-public'
  );
  const currentActive = currentEvidence.release;
  if (
    currentActive &&
    currentActive.status === 'ACTIVE' &&
    currentActive.inputDigest === inputDigest &&
    currentActive.dataDigest === dataDigest &&
    currentEvidence.manifest
  ) {
    const integrity = verifyProjectionReleaseIntegrity(
      currentActive,
      currentEvidence.manifest,
      currentEvidence.lineage
    );
    if (integrity.valid) {
      return currentActive;
    }
  }

  const fieldEvidenceDigest = stableRecordSetDigest(evidenceContext.evidence);
  const manifestId = `manifest_${releaseId}`;
  const manifest: ProjectionReleaseManifest = {
    manifestId,
    releaseId,
    projectionId: 'erp-public',
    schemaVersion: '1.0.0',
    generatedAt: now,
    canonicalInputs,
    productCount: data.length,
    offerCount: data.reduce((sum, product) => sum + product.offers.length, 0),
    fieldEvidenceCount: evidenceContext.evidence.length,
    fieldEvidenceDigest,
    inputDigest,
    dataDigest
  };
  const release: ProjectionRelease<ErpPublicProduct> = {
    releaseId,
    projectionId: 'erp-public',
    schemaVersion: '1.0.0',
    canonicalRevision,
    manifestId,
    inputDigest,
    dataDigest,
    status: 'BUILDING',
    generatedAt: now,
    data
  };

  await projections.stage(release);
  await projections.stageEvidence({
    manifest,
    lineage: evidenceContext.evidence
  });
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
    if (event.eventType.startsWith('catalog.')) {
      const existingDelivery = await projections.getDeliveryReceipt(event.eventId);
      if (!existingDelivery) {
        const release = await buildErpPublicProjection(
          catalog,
          projections,
          now.toISOString()
        );
        await projections.putDeliveryReceipt({
          eventId: event.eventId,
          eventType: event.eventType,
          projectionId: release.projectionId,
          releaseId: release.releaseId,
          inputDigest: release.inputDigest,
          dataDigest: release.dataDigest,
          targetRevision: event.targetRevision,
          processedAt: now.toISOString()
        });
      }
    }
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
