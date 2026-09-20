import { createHash, randomUUID } from 'node:crypto';
import type {
  ActorRef,
  Offer,
  Product,
  VehicleAsset,
  VehicleModel
} from '../domain/catalog.js';
import type { CatalogCandidate } from '../domain/catalog-candidate.js';
import type {
  CanonicalSourceBinding,
  CanonicalizationDecision,
  CanonicalizationReceipt,
  IdentityResolution
} from '../domain/canonicalization.js';
import type { FieldLineageRecord } from '../domain/lineage.js';
import type { CatalogStore } from '../ports/catalog-store.js';

export type CanonicalizeCatalogCandidateInput = {
  commandId: string;
  idempotencyKey: string;
  candidateId: string;
  expectedHeadRunId: string;
  decision: CanonicalizationDecision;
  actor: ActorRef;
  reason: string;
};

export class CanonicalizationRejectedError extends Error {
  readonly code = 'CANONICALIZATION_REJECTED';
}

export class CanonicalizationConflictError extends Error {
  readonly code = 'CANONICALIZATION_CONFLICT';
}

export class CanonicalizationIdempotencyConflictError extends Error {
  readonly code = 'CANONICALIZATION_IDEMPOTENCY_CONFLICT';
}

export class SourceChangedReviewRequiredError extends Error {
  readonly code = 'SOURCE_CHANGED_REVIEW_REQUIRED';
}

function stableHash(value: unknown) {
  const stable = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(stable);
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, stable(child)])
      );
    }
    return input;
  };
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function opaqueId(prefix: string, ...parts: string[]) {
  return `${prefix}_${stableHash(parts).slice(0, 24)}`;
}

function requestDigest(input: CanonicalizeCatalogCandidateInput) {
  return stableHash({
    commandType: 'CANONICALIZE_CATALOG_CANDIDATE',
    candidateId: input.candidateId,
    expectedHeadRunId: input.expectedHeadRunId,
    decision: input.decision,
    actor: {
      id: input.actor.id,
      kind: input.actor.kind,
      organizationId: input.actor.organizationId ?? null
    },
    reason: input.reason
  });
}

function sameIssues(actual: string[], approved?: string[]) {
  const a = [...actual].sort();
  const b = [...(approved ?? [])].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function assertModelCompatible(model: VehicleModel, candidate: CatalogCandidate) {
  if (model.maker !== candidate.maker || model.model !== candidate.model) {
    throw new CanonicalizationConflictError(
      `Resolved VehicleModel ${model.id} does not match candidate maker/model`
    );
  }
  if (candidate.subModel && model.subModel && model.subModel !== candidate.subModel) {
    throw new CanonicalizationConflictError(
      `Resolved VehicleModel ${model.id} subModel conflicts with candidate subModel`
    );
  }
  if (candidate.trimName && model.trim && model.trim !== candidate.trimName) {
    throw new CanonicalizationConflictError(
      `Resolved VehicleModel ${model.id} trim conflicts with candidate trimName`
    );
  }
}

function sourceRevision(checkpoint: { sourceRevision?: string | null; checksum?: string | null }) {
  return checkpoint.sourceRevision ?? checkpoint.checksum ?? undefined;
}

function meta(input: {
  now: string;
  actor: ActorRef;
  lineageId: string;
  validationStatus: 'VALID' | 'WARNING';
  checkpoint: { sourceRevision?: string | null; checksum?: string | null };
}) {
  const revision = sourceRevision(input.checkpoint);
  return {
    schemaVersion: '1.0.0',
    revision: 1,
    validationStatus: input.validationStatus,
    createdAt: input.now,
    updatedAt: input.now,
    createdBy: input.actor,
    updatedBy: input.actor,
    lineageId: input.lineageId,
    ...(revision ? { sourceRevision: revision } : {})
  };
}

function canonicalTarget(
  normalizedPath: string,
  entities: {
    model: VehicleModel;
    asset?: VehicleAsset;
    product: Product;
    offer: Offer;
  }
): FieldLineageRecord['canonical'] | null {
  const modelFields: Record<string, [string, unknown]> = {
    maker: ['maker', entities.model.maker],
    model: ['model', entities.model.model],
    subModel: ['subModel', entities.model.subModel ?? null],
    trimName: ['trim', entities.model.trim ?? null],
    fuelType: ['fuel', entities.model.fuel ?? null],
    driveType: ['drive', entities.model.drive ?? null],
    seats: ['seats', entities.model.seats ?? null]
  };
  if (normalizedPath in modelFields) {
    const [fieldPath, value] = modelFields[normalizedPath]!;
    return {
      entityType: 'vehicle_model',
      entityId: entities.model.id,
      revision: entities.model.revision,
      fieldPath,
      value
    };
  }

  if (entities.asset) {
    if (normalizedPath === 'carNumber') {
      return {
        entityType: 'vehicle_asset',
        entityId: entities.asset.id,
        revision: entities.asset.revision,
        fieldPath: 'plateNumber',
        value: entities.asset.plateNumber ?? null
      };
    }
    if (normalizedPath === 'mileageKm') {
      return {
        entityType: 'vehicle_asset',
        entityId: entities.asset.id,
        revision: entities.asset.revision,
        fieldPath: 'odometerKm',
        value: entities.asset.odometerKm ?? null
      };
    }
    if (normalizedPath === 'vehicleStatusRaw') {
      return {
        entityType: 'vehicle_asset',
        entityId: entities.asset.id,
        revision: entities.asset.revision,
        fieldPath: 'status',
        value: entities.asset.status
      };
    }
  }

  if (normalizedPath === 'commercialType') {
    return {
      entityType: 'product',
      entityId: entities.product.id,
      revision: entities.product.revision,
      fieldPath: 'commercialType',
      value: entities.product.commercialType
    };
  }

  if (normalizedPath === 'providerCompanyCode') {
    return {
      entityType: 'offer',
      entityId: entities.offer.id,
      revision: entities.offer.revision,
      fieldPath: 'supplierId',
      value: entities.offer.supplierId
    };
  }

  if (normalizedPath.startsWith('priceTerms.')) {
    const canonicalPath = normalizedPath;
    const termKey = normalizedPath.split('.')[1];
    const term = entities.offer.priceTerms.find((item) => item.termKey === termKey);
    if (!term) return null;

    const suffix = normalizedPath.split('.').slice(2).join('.');
    let value: unknown = null;
    if (suffix === 'monthlyRent.amount') value = term.monthlyRent.amount;
    else if (suffix === 'depositState') value = term.depositState;
    else if (suffix === 'deposit.amount') value = term.deposit?.amount ?? null;
    else if (suffix === 'termMonths') value = term.termMonths;
    else if (suffix === 'mileageLimitKmPerYear') value = term.mileageLimitKmPerYear ?? null;
    else return null;

    return {
      entityType: 'offer',
      entityId: entities.offer.id,
      revision: entities.offer.revision,
      fieldPath: canonicalPath,
      value
    };
  }

  return null;
}

function requiredNormalizedPaths(candidate: CatalogCandidate) {
  const required = ['maker', 'model', 'commercialType'];
  if (candidate.subModel) required.push('subModel');
  if (candidate.trimName) required.push('trimName');
  if (candidate.fuelType) required.push('fuelType');
  if (candidate.driveType) required.push('driveType');
  if (candidate.seats !== undefined) required.push('seats');
  if (candidate.carNumber) required.push('carNumber');
  if (candidate.mileageKm !== undefined) required.push('mileageKm');

  for (const term of candidate.priceTerms) {
    const prefix = `priceTerms.${term.termKey}`;
    required.push(`${prefix}.monthlyRent.amount`);
    required.push(`${prefix}.depositState`);
    required.push(`${prefix}.termMonths`);
    if (term.deposit) required.push(`${prefix}.deposit.amount`);
    if (term.mileageLimitKmPerYear !== undefined && term.mileageLimitKmPerYear !== null) {
      required.push(`${prefix}.mileageLimitKmPerYear`);
    }
  }
  return required;
}

function assertCriticalLineage(
  candidate: CatalogCandidate,
  parents: FieldLineageRecord[]
) {
  const observed = new Set(
    parents
      .filter((item) => item.stage === 'RAW_TO_NORMALIZED')
      .map((item) => item.normalized?.fieldPath)
      .filter((value): value is string => Boolean(value))
  );
  const missing = requiredNormalizedPaths(candidate).filter((path) => !observed.has(path));
  if (missing.length) {
    throw new CanonicalizationRejectedError(
      `Missing normalized lineage for canonical fields: ${missing.join(', ')}`
    );
  }
}

function buildCanonicalLineage(
  parents: FieldLineageRecord[],
  entities: {
    model: VehicleModel;
    asset?: VehicleAsset;
    product: Product;
    offer: Offer;
  }
) {
  const out: FieldLineageRecord[] = [];
  for (const parent of parents) {
    const normalized = parent.normalized;
    if (!normalized) continue;
    const canonical = canonicalTarget(normalized.fieldPath, entities);
    if (!canonical) continue;

    out.push({
      lineageRecordId: `lin_${stableHash([
        parent.lineageRecordId,
        canonical.entityType,
        canonical.entityId,
        canonical.revision,
        canonical.fieldPath
      ])}`,
      lineageId: parent.lineageId,
      stage: 'NORMALIZED_TO_CANONICAL',
      parentLineageRecordId: parent.lineageRecordId,
      runId: parent.runId,
      sourceId: parent.sourceId,
      sourceRecordId: parent.sourceRecordId,
      sourceFingerprint: parent.sourceFingerprint,
      observedAt: parent.observedAt,
      source: parent.source,
      normalized,
      canonical,
      transformId: 'catalog-canonicalizer',
      transformVersion: '1.0.0'
    });
  }
  return out;
}

function assertIdentityId(resolution: IdentityResolution, prefix: string) {
  if (!resolution.id.startsWith(prefix + '_') || resolution.id.length < prefix.length + 4) {
    throw new CanonicalizationRejectedError(
      `Canonical identity ${resolution.id} must use opaque ${prefix}_... form`
    );
  }
}

export async function canonicalizeCatalogCandidate(
  store: CatalogStore,
  input: CanonicalizeCatalogCandidateInput,
  now = new Date().toISOString()
): Promise<CanonicalizationReceipt> {
  if (!input.reason.trim()) throw new CanonicalizationRejectedError('reason is required');
  if (!input.decision.supplierId.trim()) {
    throw new CanonicalizationRejectedError('reviewed supplierId is required');
  }
  assertIdentityId(input.decision.vehicleModel, 'vm');
  if (input.decision.vehicleAsset) assertIdentityId(input.decision.vehicleAsset, 'va');

  const digest = requestDigest(input);

  return store.transact(async (tx) => {
    const existingReceipt = await tx.getCanonicalizationReceipt(input.idempotencyKey);
    if (existingReceipt) {
      if (existingReceipt.requestDigest !== digest) {
        throw new CanonicalizationIdempotencyConflictError(
          `Idempotency key ${input.idempotencyKey} was reused with different canonicalization input`
        );
      }
      return existingReceipt;
    }

    const candidateRecord = await tx.getCandidate(input.candidateId);
    if (!candidateRecord) {
      throw new CanonicalizationRejectedError(`Candidate not found: ${input.candidateId}`);
    }

    const [run, head] = await Promise.all([
      tx.getSourceRun(candidateRecord.runId),
      tx.getSourceHead(candidateRecord.sourceId)
    ]);
    if (!run || run.status !== 'COMPLETED') {
      throw new CanonicalizationRejectedError('Candidate source run is not completed');
    }
    if (
      run.sourceId !== candidateRecord.sourceId ||
      run.checkpoint?.sourceId !== candidateRecord.sourceId
    ) {
      throw new CanonicalizationRejectedError('Candidate source run identity is inconsistent');
    }
    if (
      !head ||
      head.sourceId !== candidateRecord.sourceId ||
      head.checkpoint.sourceId !== candidateRecord.sourceId ||
      head.coverage.completeness !== 'COMPLETE' ||
      head.runId !== candidateRecord.runId ||
      run.headStatus !== 'CURRENT'
    ) {
      throw new CanonicalizationRejectedError('Candidate is not from the accepted current source head');
    }
    if (head.runId !== input.expectedHeadRunId) {
      throw new CanonicalizationConflictError(
        `Expected source head ${input.expectedHeadRunId}, actual ${head.runId}`
      );
    }
    if (candidateRecord.status === 'REJECTED') {
      throw new CanonicalizationRejectedError('Rejected candidate cannot become canonical');
    }

    const candidate = candidateRecord.candidate;
    if (
      (candidateRecord.status === 'VALID' && candidate.issues.length > 0) ||
      (candidateRecord.status === 'WARNING' && candidate.issues.length === 0)
    ) {
      throw new CanonicalizationRejectedError(
        'Candidate validation status and issue evidence are inconsistent'
      );
    }
    if (
      candidate.sourceRecordId !== candidateRecord.sourceRecordId ||
      candidate.sourceFingerprint !== candidateRecord.sourceFingerprint
    ) {
      throw new CanonicalizationRejectedError(
        'Candidate envelope and normalized payload source identity do not match'
      );
    }
    if (!candidate.maker || !candidate.model || !candidate.commercialType || !candidate.priceTerms.length) {
      throw new CanonicalizationRejectedError(
        'Canonicalization requires maker, model, commercialType and at least one PriceTerm'
      );
    }
    if (!sameIssues(candidate.issues, input.decision.approvedIssues)) {
      throw new CanonicalizationRejectedError(
        'Candidate warnings/issues must be explicitly and exactly approved'
      );
    }

    const bindingId = opaqueId(
      'bind',
      candidateRecord.sourceId,
      candidateRecord.sourceRecordId
    );
    const existingBinding = await tx.getSourceBinding(bindingId);
    if (existingBinding) {
      if (existingBinding.sourceFingerprint !== candidateRecord.sourceFingerprint) {
        throw new SourceChangedReviewRequiredError(
          'Source record changed after canonicalization; explicit re-review is required'
        );
      }
      const receipt: CanonicalizationReceipt = {
        idempotencyKey: input.idempotencyKey,
        commandId: input.commandId,
        status: 'NO_CHANGE',
        bindingId,
        sourceId: existingBinding.sourceId,
        sourceRecordId: existingBinding.sourceRecordId,
        sourceFingerprint: existingBinding.sourceFingerprint,
        sourceRunId: existingBinding.sourceRunId,
        productId: existingBinding.productId,
        offerId: existingBinding.offerId,
        committedAt: now,
        requestDigest: digest
      };
      await tx.putCanonicalizationReceipt(receipt);
      return receipt;
    }

    const modelResolution = input.decision.vehicleModel;
    const modelExisting = await tx.getVehicleModel(modelResolution.id);
    if (modelResolution.action === 'CREATE' && modelExisting) {
      throw new CanonicalizationConflictError(
        `VehicleModel already exists: ${modelResolution.id}`
      );
    }
    if (modelResolution.action === 'LINK' && !modelExisting) {
      throw new CanonicalizationConflictError(
        `VehicleModel to link does not exist: ${modelResolution.id}`
      );
    }

    const validationStatus = candidateRecord.status === 'WARNING' ? 'WARNING' as const : 'VALID' as const;
    const entityMeta = meta({
      now,
      actor: input.actor,
      lineageId: bindingId,
      validationStatus,
      checkpoint: head.checkpoint
    });

    const model: VehicleModel = modelExisting ?? {
      ...entityMeta,
      id: modelResolution.id,
      maker: candidate.maker,
      model: candidate.model,
      displayName: [candidate.maker, candidate.model, candidate.subModel, candidate.trimName]
        .filter(Boolean)
        .join(' '),
      ...(candidate.subModel ? { subModel: candidate.subModel } : {}),
      ...(candidate.trimName ? { trim: candidate.trimName } : {}),
      ...(candidate.fuelType ? { fuel: candidate.fuelType } : {}),
      ...(candidate.driveType ? { drive: candidate.driveType } : {}),
      ...(candidate.seats !== undefined ? { seats: candidate.seats } : {})
    };
    assertModelCompatible(model, candidate);

    let asset: VehicleAsset | undefined;
    if (candidate.carNumber) {
      const assetResolution = input.decision.vehicleAsset;
      if (!assetResolution) {
        throw new CanonicalizationRejectedError(
          'Candidate with carNumber requires an explicit VehicleAsset CREATE/LINK decision'
        );
      }
      const existingAsset = await tx.getVehicleAsset(assetResolution.id);
      if (assetResolution.action === 'CREATE') {
        if (existingAsset) {
          throw new CanonicalizationConflictError(
            `VehicleAsset already exists: ${assetResolution.id}`
          );
        }
        if (!assetResolution.status) {
          throw new CanonicalizationRejectedError(
            'Creating VehicleAsset requires an explicitly reviewed asset status'
          );
        }
        asset = {
          ...entityMeta,
          id: assetResolution.id,
          vehicleModelId: model.id,
          status: assetResolution.status,
          plateNumber: candidate.carNumber,
          ...(candidate.mileageKm !== undefined ? { odometerKm: candidate.mileageKm } : {})
        };
      } else {
        if (!existingAsset) {
          throw new CanonicalizationConflictError(
            `VehicleAsset to link does not exist: ${assetResolution.id}`
          );
        }
        if (
          existingAsset.vehicleModelId !== model.id ||
          (existingAsset.plateNumber && existingAsset.plateNumber !== candidate.carNumber)
        ) {
          throw new CanonicalizationConflictError(
            `Resolved VehicleAsset ${existingAsset.id} conflicts with candidate identity`
          );
        }
        asset = existingAsset;
      }
    } else if (input.decision.vehicleAsset) {
      throw new CanonicalizationRejectedError(
        'VehicleAsset decision is not allowed when candidate has no carNumber'
      );
    }

    const productId = opaqueId('prd', candidateRecord.sourceId, candidateRecord.sourceRecordId);
    const offerId = opaqueId('off', candidateRecord.sourceId, candidateRecord.sourceRecordId);

    const [productCollision, offerCollision, parentLineage] = await Promise.all([
      tx.getProduct(productId),
      tx.getOffer(offerId),
      tx.listLineageForCandidate(candidateRecord.candidateId)
    ]);
    assertCriticalLineage(candidate, parentLineage);
    if (productCollision || offerCollision) {
      throw new CanonicalizationConflictError(
        'Deterministic Product/Offer identity already exists without a source binding'
      );
    }

    const product: Product = {
      ...entityMeta,
      id: productId,
      vehicleModelId: model.id,
      ...(asset ? { vehicleAssetId: asset.id } : {}),
      commercialType: candidate.commercialType,
      status: 'ACTIVE',
      displayName: model.displayName
    };

    const offer: Offer = {
      ...entityMeta,
      id: offerId,
      productId: product.id,
      supplierId: input.decision.supplierId,
      status: 'ACTIVE',
      priceTerms: structuredClone(candidate.priceTerms)
    };

    const binding: CanonicalSourceBinding = {
      bindingId,
      sourceId: candidateRecord.sourceId,
      sourceRecordId: candidateRecord.sourceRecordId,
      sourceFingerprint: candidateRecord.sourceFingerprint,
      sourceRunId: run.runId,
      sourceObservedAt: head.observedAt,
      ...(head.checkpoint.sourceRevision
        ? { sourceCheckpointRevision: head.checkpoint.sourceRevision }
        : {}),
      ...(head.checkpoint.checksum
        ? { sourceCheckpointChecksum: head.checkpoint.checksum }
        : {}),
      vehicleModelId: model.id,
      ...(asset ? { vehicleAssetId: asset.id } : {}),
      productId: product.id,
      offerId: offer.id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: input.actor,
      updatedBy: input.actor
    };

    const canonicalLineage = buildCanonicalLineage(parentLineage, {
      model,
      ...(asset ? { asset } : {}),
      product,
      offer
    });

    if (modelResolution.action === 'CREATE') await tx.putVehicleModel(model);
    if (asset && input.decision.vehicleAsset?.action === 'CREATE') {
      await tx.putVehicleAsset(asset);
    }
    await tx.putProduct(product);
    await tx.putOffer(offer);
    await tx.putSourceBinding(binding);
    for (const lineage of canonicalLineage) await tx.appendLineage(lineage);

    await tx.appendAudit({
      eventId: randomUUID(),
      commandId: input.commandId,
      actor: input.actor,
      entityType: 'canonical_binding',
      entityId: binding.bindingId,
      action: 'CATALOG_CANDIDATE_CANONICALIZED',
      before: null,
      after: binding,
      reason: input.reason,
      revisionBefore: 0,
      revisionAfter: 1,
      occurredAt: now
    });
    await tx.appendOutbox({
      eventId: randomUUID(),
      eventType: 'catalog.canonicalized',
      entityType: 'product',
      entityId: product.id,
      sourceRevision: 0,
      targetRevision: 1,
      commandId: input.commandId,
      correlationId: input.commandId,
      causationId: input.commandId,
      occurredAt: now,
      status: 'PENDING',
      attempts: 0
    });

    const receipt: CanonicalizationReceipt = {
      idempotencyKey: input.idempotencyKey,
      commandId: input.commandId,
      status: 'CANONICAL_COMMITTED',
      bindingId,
      sourceId: candidateRecord.sourceId,
      sourceRecordId: candidateRecord.sourceRecordId,
      sourceFingerprint: candidateRecord.sourceFingerprint,
      sourceRunId: run.runId,
      productId: product.id,
      offerId: offer.id,
      committedAt: now,
      requestDigest: digest
    };
    await tx.putCanonicalizationReceipt(receipt);
    return receipt;
  });
}
