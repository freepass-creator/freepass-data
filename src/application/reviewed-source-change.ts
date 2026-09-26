import { randomUUID } from 'node:crypto';
import {
  assertCommandWriter,
  assertFieldAuthority,
  resolveFieldAuthority
} from '../domain/authority.js';
import {
  assertCatalogWriterOwnership,
  resolveExecutionWriter
} from '../domain/writer-ownership.js';
import type {
  Money,
  Offer,
  PriceTerm,
  Product,
  VehicleAsset,
  VehicleModel
} from '../domain/catalog.js';
import type { CatalogCandidate } from '../domain/catalog-candidate.js';
import type { CanonicalSourceBinding } from '../domain/canonicalization.js';
import type { FieldLineageRecord } from '../domain/lineage.js';
import type {
  ApplyReviewedSourceChangeInput,
  ReviewedSourceChangeReceipt,
  SourceChangeDiff,
  SourceChangeReview
} from '../domain/source-change.js';
import type {
  NormalizedCandidateRecord,
  SourceHead,
  SourceRun
} from '../domain/source.js';
import type {
  CatalogStore,
  CatalogTransaction
} from '../ports/catalog-store.js';
import { stableDigest, stableValue } from '../shared/stable-digest.js';

export class ReviewedSourceChangeRejectedError extends Error {
  readonly code = 'REVIEWED_SOURCE_CHANGE_REJECTED';
}

export class ReviewedSourceChangeConflictError extends Error {
  readonly code = 'REVIEWED_SOURCE_CHANGE_CONFLICT';
}

export class ReviewedSourceChangeBlockedError extends Error {
  readonly code = 'REVIEWED_SOURCE_CHANGE_BLOCKED';

  constructor(readonly blockedChanges: SourceChangeDiff[]) {
    super('Source change contains structural/identity changes that require separate commands');
  }
}

export class ReviewedSourceChangeApprovalMismatchError extends Error {
  readonly code = 'REVIEWED_SOURCE_CHANGE_APPROVAL_MISMATCH';
}

export class ReviewedSourceChangeIdempotencyConflictError extends Error {
  readonly code = 'REVIEWED_SOURCE_CHANGE_IDEMPOTENCY_CONFLICT';
}

type ReviewReader = Pick<
  CatalogStore,
  | 'getSourceBinding'
  | 'getCandidate'
  | 'getSourceRun'
  | 'getSourceHead'
  | 'getVehicleModel'
  | 'getVehicleAsset'
  | 'getProduct'
  | 'getOffer'
>;

type SourceChangeOperation =
  | {
      kind: 'OFFER_MONTHLY_RENT';
      changeId: string;
      termKey: string;
      value: Money;
      authorityFieldPath: string;
    }
  | {
      kind: 'OFFER_DEPOSIT_STATE';
      changeId: string;
      termKey: string;
      value: PriceTerm['depositState'];
      authorityFieldPath: string;
    }
  | {
      kind: 'OFFER_DEPOSIT';
      changeId: string;
      termKey: string;
      value: Money | null;
      authorityFieldPath: string;
    }
  | {
      kind: 'OFFER_MILEAGE_LIMIT';
      changeId: string;
      termKey: string;
      value: number | null;
      authorityFieldPath: string;
    }
  | {
      kind: 'ASSET_ODOMETER';
      changeId: string;
      value: number;
      authorityFieldPath: string;
    };

type SourceChangeOperationDraft =
  | {
      kind: 'OFFER_MONTHLY_RENT';
      termKey: string;
      value: Money;
    }
  | {
      kind: 'OFFER_DEPOSIT_STATE';
      termKey: string;
      value: PriceTerm['depositState'];
    }
  | {
      kind: 'OFFER_DEPOSIT';
      termKey: string;
      value: Money | null;
    }
  | {
      kind: 'OFFER_MILEAGE_LIMIT';
      termKey: string;
      value: number | null;
    }
  | {
      kind: 'ASSET_ODOMETER';
      value: number;
    };

type OfferSourceChangeOperation = Exclude<
  SourceChangeOperation,
  { kind: 'ASSET_ODOMETER' }
>;

function isOfferOperation(
  operation: SourceChangeOperation
): operation is OfferSourceChangeOperation {
  return operation.kind !== 'ASSET_ODOMETER';
}

type LoadedState = {
  binding: CanonicalSourceBinding;
  candidateRecord: NormalizedCandidateRecord;
  run: SourceRun;
  head: SourceHead;
  model: VehicleModel;
  asset: VehicleAsset | null;
  product: Product;
  offer: Offer;
};

function sameValue(a: unknown, b: unknown) {
  return JSON.stringify(stableValue(a)) === JSON.stringify(stableValue(b));
}
function sourceRevision(head: SourceHead) {
  return head.checkpoint.sourceRevision ?? head.checkpoint.checksum ?? undefined;
}

function sameIssues(actual: string[], approved?: string[]) {
  const a = [...actual].sort();
  const b = [...(approved ?? [])].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function assertCandidateSemantics(candidateRecord: NormalizedCandidateRecord) {
  const candidate = candidateRecord.candidate;
  if (candidateRecord.status === 'REJECTED') {
    throw new ReviewedSourceChangeRejectedError('Rejected candidate cannot update Canonical');
  }
  if (
    (candidateRecord.status === 'VALID' && candidate.issues.length > 0) ||
    (candidateRecord.status === 'WARNING' && candidate.issues.length === 0)
  ) {
    throw new ReviewedSourceChangeRejectedError(
      'Candidate validation status and issue evidence are inconsistent'
    );
  }
  if (
    candidate.sourceRecordId !== candidateRecord.sourceRecordId ||
    candidate.sourceFingerprint !== candidateRecord.sourceFingerprint
  ) {
    throw new ReviewedSourceChangeRejectedError(
      'Candidate envelope and normalized payload source identity do not match'
    );
  }

  const seen = new Set<string>();
  for (const term of candidate.priceTerms) {
    if (seen.has(term.termKey)) {
      throw new ReviewedSourceChangeRejectedError(
        `Duplicate PriceTerm key: ${term.termKey}`
      );
    }
    seen.add(term.termKey);

    if (!Number.isInteger(term.termMonths) || term.termMonths < 1) {
      throw new ReviewedSourceChangeRejectedError(
        `Invalid termMonths for ${term.termKey}`
      );
    }
    if (
      term.monthlyRent.currency !== 'KRW' ||
      !Number.isInteger(term.monthlyRent.amount) ||
      term.monthlyRent.amount < 0
    ) {
      throw new ReviewedSourceChangeRejectedError(
        `Invalid monthlyRent for ${term.termKey}`
      );
    }
    if (
      term.mileageLimitKmPerYear !== undefined &&
      term.mileageLimitKmPerYear !== null &&
      (!Number.isInteger(term.mileageLimitKmPerYear) || term.mileageLimitKmPerYear < 0)
    ) {
      throw new ReviewedSourceChangeRejectedError(
        `Invalid mileage limit for ${term.termKey}`
      );
    }
    if (term.depositState === 'KNOWN') {
      if (
        !term.deposit ||
        term.deposit.currency !== 'KRW' ||
        !Number.isInteger(term.deposit.amount) ||
        term.deposit.amount <= 0
      ) {
        throw new ReviewedSourceChangeRejectedError(
          `KNOWN deposit requires a positive KRW amount for ${term.termKey}`
        );
      }
    } else if (term.depositState === 'ZERO') {
      if (
        !term.deposit ||
        term.deposit.currency !== 'KRW' ||
        term.deposit.amount !== 0
      ) {
        throw new ReviewedSourceChangeRejectedError(
          `ZERO deposit requires KRW 0 for ${term.termKey}`
        );
      }
    } else if (term.deposit !== undefined && term.deposit !== null) {
      throw new ReviewedSourceChangeRejectedError(
        `${term.depositState} deposit must not contain an amount for ${term.termKey}`
      );
    }
  }
}

async function loadState(
  reader: ReviewReader,
  bindingId: string,
  candidateId: string
): Promise<LoadedState> {
  const binding = await reader.getSourceBinding(bindingId);
  if (!binding) {
    throw new ReviewedSourceChangeRejectedError(`Source binding not found: ${bindingId}`);
  }

  const candidateRecord = await reader.getCandidate(candidateId);
  if (!candidateRecord) {
    throw new ReviewedSourceChangeRejectedError(`Candidate not found: ${candidateId}`);
  }
  assertCandidateSemantics(candidateRecord);

  if (
    candidateRecord.sourceId !== binding.sourceId ||
    candidateRecord.sourceRecordId !== binding.sourceRecordId
  ) {
    throw new ReviewedSourceChangeRejectedError(
      'Candidate source identity does not match the existing binding'
    );
  }

  const [run, head, model, product, offer, asset] = await Promise.all([
    reader.getSourceRun(candidateRecord.runId),
    reader.getSourceHead(candidateRecord.sourceId),
    reader.getVehicleModel(binding.vehicleModelId),
    reader.getProduct(binding.productId),
    reader.getOffer(binding.offerId),
    binding.vehicleAssetId
      ? reader.getVehicleAsset(binding.vehicleAssetId)
      : Promise.resolve(null)
  ]);

  if (!run || run.status !== 'COMPLETED') {
    throw new ReviewedSourceChangeRejectedError('Candidate source run is not completed');
  }
  if (
    run.sourceId !== candidateRecord.sourceId ||
    run.checkpoint?.sourceId !== candidateRecord.sourceId
  ) {
    throw new ReviewedSourceChangeRejectedError('Candidate source run identity is inconsistent');
  }
  if (
    !head ||
    head.sourceId !== candidateRecord.sourceId ||
    head.checkpoint.sourceId !== candidateRecord.sourceId ||
    head.coverage.completeness !== 'COMPLETE' ||
    head.runId !== candidateRecord.runId ||
    run.headStatus !== 'CURRENT'
  ) {
    throw new ReviewedSourceChangeRejectedError(
      'Candidate is not from the accepted current source head'
    );
  }
  if (!model || !product || !offer) {
    throw new ReviewedSourceChangeRejectedError(
      'Existing Canonical entities for the binding are incomplete'
    );
  }
  if (
    product.vehicleModelId !== model.id ||
    offer.productId !== product.id ||
    product.id !== binding.productId ||
    offer.id !== binding.offerId
  ) {
    throw new ReviewedSourceChangeRejectedError(
      'Existing Canonical binding relationships are inconsistent'
    );
  }
  if (binding.vehicleAssetId) {
    if (!asset || product.vehicleAssetId !== asset.id) {
      throw new ReviewedSourceChangeRejectedError(
        'Existing VehicleAsset binding relationship is inconsistent'
      );
    }
  } else if (product.vehicleAssetId) {
    throw new ReviewedSourceChangeRejectedError(
      'Product has a VehicleAsset that is not represented in the source binding'
    );
  }

  return {
    binding,
    candidateRecord,
    run,
    head,
    model,
    asset,
    product,
    offer
  };
}

function changeId(input: {
  entityType: string;
  entityId: string;
  fieldPath: string;
  before: unknown;
  after: unknown;
}) {
  return 'chg_' + stableDigest([
    input.entityType,
    input.entityId,
    input.fieldPath,
    stable(input.before),
    stable(input.after)
  ]).slice(0, 32);
}

function buildChanges(state: LoadedState) {
  const { candidateRecord, model, asset, product, offer } = state;
  const candidate = candidateRecord.candidate;
  const diffs: SourceChangeDiff[] = [];
  const operations = new Map<string, SourceChangeOperation>();

  const blocked = (
    entityType: SourceChangeDiff['entityType'],
    entityId: string,
    fieldPath: string,
    before: unknown,
    after: unknown,
    reasonCode: string
  ) => {
    if (sameValue(before, after)) return;
    const id = changeId({ entityType, entityId, fieldPath, before, after });
    diffs.push({
      changeId: id,
      classification: 'BLOCKED',
      entityType,
      entityId,
      fieldPath,
      before: structuredClone(before),
      after: structuredClone(after),
      reasonCode
    });
  };

  const reviewable = (
    entityType: 'offer' | 'vehicle_asset',
    entityId: string,
    fieldPath: string,
    before: unknown,
    after: unknown,
    reasonCode: string,
    authorityFieldPath: string,
    operation: SourceChangeOperationDraft
  ) => {
    if (sameValue(before, after)) return;
    const aggregate = entityType === 'offer' ? 'offer' : 'vehicle_asset';
    const rule = resolveFieldAuthority(aggregate, authorityFieldPath);
    const refreshAllowed = Boolean(rule) && rule!.sourceRefresh !== 'SOURCE_REFRESH_BLOCKED';
    const id = changeId({ entityType, entityId, fieldPath, before, after });
    diffs.push({
      changeId: id,
      classification: refreshAllowed ? 'REVIEWABLE' : 'BLOCKED',
      entityType,
      entityId,
      fieldPath,
      before: structuredClone(before),
      after: structuredClone(after),
      reasonCode: refreshAllowed
        ? reasonCode
        : rule
          ? 'SOURCE_REFRESH_BLOCKED'
          : 'NO_FIELD_AUTHORITY_RULE',
      authorityRuleId: rule?.ruleId ?? null
    });
    if (refreshAllowed) {
      operations.set(id, {
        ...operation,
        changeId: id,
        authorityFieldPath
      } as SourceChangeOperation);
    }
  };

  const blockedIfProvided = (
    entityType: SourceChangeDiff['entityType'],
    entityId: string,
    fieldPath: string,
    candidateValue: unknown,
    currentValue: unknown,
    reasonCode: string
  ) => {
    if (candidateValue !== undefined && candidateValue !== null) {
      blocked(entityType, entityId, fieldPath, currentValue, candidateValue, reasonCode);
    }
  };

  blockedIfProvided(
    'vehicle_model', model.id, 'maker',
    candidate.maker, model.maker, 'VEHICLE_IDENTITY_CHANGE'
  );
  blockedIfProvided(
    'vehicle_model', model.id, 'model',
    candidate.model, model.model, 'VEHICLE_IDENTITY_CHANGE'
  );
  blockedIfProvided(
    'vehicle_model', model.id, 'subModel',
    candidate.subModel, model.subModel ?? null, 'SHARED_MODEL_CHANGE_REQUIRES_SEPARATE_COMMAND'
  );
  blockedIfProvided(
    'vehicle_model', model.id, 'trim',
    candidate.trimName, model.trim ?? null, 'SHARED_MODEL_CHANGE_REQUIRES_SEPARATE_COMMAND'
  );
  blockedIfProvided(
    'vehicle_model', model.id, 'fuel',
    candidate.fuelType, model.fuel ?? null, 'SHARED_MODEL_CHANGE_REQUIRES_SEPARATE_COMMAND'
  );
  blockedIfProvided(
    'vehicle_model', model.id, 'drive',
    candidate.driveType, model.drive ?? null, 'SHARED_MODEL_CHANGE_REQUIRES_SEPARATE_COMMAND'
  );
  if (candidate.seats !== undefined) {
    blocked(
      'vehicle_model', model.id, 'seats',
      model.seats ?? null, candidate.seats, 'SHARED_MODEL_CHANGE_REQUIRES_SEPARATE_COMMAND'
    );
  }

  if (candidate.commercialType !== undefined) {
    blocked(
      'product', product.id, 'commercialType',
      product.commercialType, candidate.commercialType, 'COMMERCIAL_TYPE_CHANGE_REQUIRES_SEPARATE_COMMAND'
    );
  }

  if (candidate.providerCompanyCode) {
    if (state.binding.sourceSupplierCode === undefined) {
      blocked(
        'offer',
        offer.id,
        'sourceSupplierCode',
        null,
        candidate.providerCompanyCode,
        'SOURCE_SUPPLIER_MAPPING_EVIDENCE_MISSING'
      );
    } else {
      blocked(
        'offer',
        offer.id,
        'sourceSupplierCode',
        state.binding.sourceSupplierCode,
        candidate.providerCompanyCode,
        'SOURCE_SUPPLIER_MAPPING_CHANGE_REQUIRES_SEPARATE_COMMAND'
      );
    }
  }

  if (candidate.carNumber) {
    if (!asset) {
      blocked(
        'vehicle_asset',
        bindingPlaceholder(product.id),
        'plateNumber',
        null,
        candidate.carNumber,
        'VEHICLE_ASSET_IDENTITY_CHANGE_REQUIRES_SEPARATE_COMMAND'
      );
    } else {
      blocked(
        'vehicle_asset', asset.id, 'plateNumber',
        asset.plateNumber ?? null,
        candidate.carNumber,
        'VEHICLE_ASSET_IDENTITY_CHANGE_REQUIRES_SEPARATE_COMMAND'
      );
    }
  }

  if (candidate.mileageKm !== undefined) {
    if (!asset) {
      blocked(
        'vehicle_asset',
        bindingPlaceholder(product.id),
        'odometerKm',
        null,
        candidate.mileageKm,
        'VEHICLE_ASSET_REQUIRED'
      );
    } else {
      reviewable(
        'vehicle_asset',
        asset.id,
        'odometerKm',
        asset.odometerKm ?? null,
        candidate.mileageKm,
        'SOURCE_ODOMETER_CHANGE',
        'odometerKm',
        {
          kind: 'ASSET_ODOMETER',
          value: candidate.mileageKm
        }
      );
    }
  }

  const currentByTerm = new Map(offer.priceTerms.map((term) => [term.termKey, term]));
  const candidateByTerm = new Map(candidate.priceTerms.map((term) => [term.termKey, term]));
  const currentKeys = [...currentByTerm.keys()].sort();
  const candidateKeys = [...candidateByTerm.keys()].sort();

  if (!sameValue(currentKeys, candidateKeys)) {
    blocked(
      'offer',
      offer.id,
      'priceTerms.structure',
      currentKeys,
      candidateKeys,
      'PRICE_TERM_STRUCTURE_CHANGE_REQUIRES_SEPARATE_COMMAND'
    );
  }

  for (const termKey of currentKeys.filter((key) => candidateByTerm.has(key))) {
    const current = currentByTerm.get(termKey)!;
    const next = candidateByTerm.get(termKey)!;

    blocked(
      'offer',
      offer.id,
      `priceTerms.${termKey}.termMonths`,
      current.termMonths,
      next.termMonths,
      'PRICE_TERM_STRUCTURE_CHANGE_REQUIRES_SEPARATE_COMMAND'
    );
    blocked(
      'offer',
      offer.id,
      `priceTerms.${termKey}.monthlyRent.currency`,
      current.monthlyRent.currency,
      next.monthlyRent.currency,
      'CURRENCY_CHANGE_REQUIRES_SEPARATE_COMMAND'
    );
    if (current.deposit && next.deposit) {
      blocked(
        'offer',
        offer.id,
        `priceTerms.${termKey}.deposit.currency`,
        current.deposit.currency,
        next.deposit.currency,
        'CURRENCY_CHANGE_REQUIRES_SEPARATE_COMMAND'
      );
    }

    reviewable(
      'offer',
      offer.id,
      `priceTerms.${termKey}.monthlyRent`,
      current.monthlyRent,
      next.monthlyRent,
      'SOURCE_MONTHLY_RENT_CHANGE',
      `priceTerms.${termKey}.monthlyRent`,
      {
        kind: 'OFFER_MONTHLY_RENT',
        termKey,
        value: structuredClone(next.monthlyRent)
      }
    );
    reviewable(
      'offer',
      offer.id,
      `priceTerms.${termKey}.depositState`,
      current.depositState,
      next.depositState,
      'SOURCE_DEPOSIT_STATE_CHANGE',
      `priceTerms.${termKey}.depositState`,
      {
        kind: 'OFFER_DEPOSIT_STATE',
        termKey,
        value: next.depositState
      }
    );
    reviewable(
      'offer',
      offer.id,
      `priceTerms.${termKey}.deposit`,
      current.deposit ?? null,
      next.deposit ?? null,
      'SOURCE_DEPOSIT_CHANGE',
      `priceTerms.${termKey}.deposit`,
      {
        kind: 'OFFER_DEPOSIT',
        termKey,
        value: next.deposit ? structuredClone(next.deposit) : null
      }
    );
    reviewable(
      'offer',
      offer.id,
      `priceTerms.${termKey}.mileageLimitKmPerYear`,
      current.mileageLimitKmPerYear ?? null,
      next.mileageLimitKmPerYear ?? null,
      'SOURCE_MILEAGE_LIMIT_CHANGE',
      `priceTerms.${termKey}.mileageLimitKmPerYear`,
      {
        kind: 'OFFER_MILEAGE_LIMIT',
        termKey,
        value: next.mileageLimitKmPerYear ?? null
      }
    );
  }

  return { diffs, operations };
}

function bindingPlaceholder(productId: string) {
  return `unbound_asset_for_${productId}`;
}

function toReview(state: LoadedState, diffs: SourceChangeDiff[]): SourceChangeReview {
  return {
    bindingId: state.binding.bindingId,
    bindingRevision: state.binding.revision,
    candidateId: state.candidateRecord.candidateId,
    sourceId: state.binding.sourceId,
    sourceRecordId: state.binding.sourceRecordId,
    previousFingerprint: state.binding.sourceFingerprint,
    candidateFingerprint: state.candidateRecord.sourceFingerprint,
    sourceRunId: state.run.runId,
    vehicleModelRevision: state.model.revision,
    productRevision: state.product.revision,
    offerRevision: state.offer.revision,
    ...(state.asset ? { vehicleAssetRevision: state.asset.revision } : {}),
    candidateIssues: structuredClone(state.candidateRecord.candidate.issues),
    diffs: structuredClone(diffs),
    reviewableChangeIds: diffs
      .filter((item) => item.classification === 'REVIEWABLE')
      .map((item) => item.changeId)
      .sort(),
    blockedChangeIds: diffs
      .filter((item) => item.classification === 'BLOCKED')
      .map((item) => item.changeId)
      .sort()
  };
}

export async function reviewSourceChange(
  store: CatalogStore,
  bindingId: string,
  candidateId: string
): Promise<SourceChangeReview> {
  const state = await loadState(store, bindingId, candidateId);
  const { diffs } = buildChanges(state);
  return toReview(state, diffs);
}

function requestDigest(input: ApplyReviewedSourceChangeInput, writerId: string) {
  return stableDigest({
    commandType: 'APPLY_REVIEWED_SOURCE_CHANGE',
    bindingId: input.bindingId,
    candidateId: input.candidateId,
    expectedHeadRunId: input.expectedHeadRunId,
    expectedBindingRevision: input.expectedBindingRevision,
    expectedVehicleModelRevision: input.expectedVehicleModelRevision,
    expectedProductRevision: input.expectedProductRevision,
    expectedOfferRevision: input.expectedOfferRevision,
    expectedVehicleAssetRevision: input.expectedVehicleAssetRevision ?? null,
    approvedChangeIds: [...input.approvedChangeIds].sort(),
    approvedIssues: [...(input.approvedIssues ?? [])].sort(),
    actor: input.actor,
    writerId,
    reason: input.reason
  });
}

function assertExpectedRevisions(state: LoadedState, input: ApplyReviewedSourceChangeInput) {
  const mismatches: string[] = [];
  if (state.binding.revision !== input.expectedBindingRevision) {
    mismatches.push(`binding expected ${input.expectedBindingRevision}, actual ${state.binding.revision}`);
  }
  if (state.model.revision !== input.expectedVehicleModelRevision) {
    mismatches.push(
      `vehicle_model expected ${input.expectedVehicleModelRevision}, actual ${state.model.revision}`
    );
  }
  if (state.product.revision !== input.expectedProductRevision) {
    mismatches.push(
      `product expected ${input.expectedProductRevision}, actual ${state.product.revision}`
    );
  }
  if (state.offer.revision !== input.expectedOfferRevision) {
    mismatches.push(
      `offer expected ${input.expectedOfferRevision}, actual ${state.offer.revision}`
    );
  }
  if (state.asset) {
    if (input.expectedVehicleAssetRevision === undefined || input.expectedVehicleAssetRevision === null) {
      mismatches.push('vehicle_asset expected revision is required');
    } else if (state.asset.revision !== input.expectedVehicleAssetRevision) {
      mismatches.push(
        `vehicle_asset expected ${input.expectedVehicleAssetRevision}, actual ${state.asset.revision}`
      );
    }
  } else if (
    input.expectedVehicleAssetRevision !== undefined &&
    input.expectedVehicleAssetRevision !== null
  ) {
    mismatches.push('vehicle_asset revision supplied but binding has no asset');
  }

  if (mismatches.length) {
    throw new ReviewedSourceChangeConflictError(mismatches.join('; '));
  }
}

function exactSet(actual: string[], expected: string[]) {
  const a = [...new Set(actual)].sort();
  const b = [...new Set(expected)].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function nextOfferFromOperations(
  offer: Offer,
  operations: SourceChangeOperation[],
  now: string,
  input: ApplyReviewedSourceChangeInput,
  validationStatus: 'VALID' | 'WARNING',
  sourceRevisionValue?: string
) {
  if (!operations.some(isOfferOperation)) return offer;

  let terms = structuredClone(offer.priceTerms);
  for (const operation of operations) {
    if (!isOfferOperation(operation)) continue;
    terms = terms.map((term) => {
      if (term.termKey !== operation.termKey) return term;
      if (operation.kind === 'OFFER_MONTHLY_RENT') {
        return { ...term, monthlyRent: structuredClone(operation.value) };
      }
      if (operation.kind === 'OFFER_DEPOSIT_STATE') {
        return { ...term, depositState: operation.value };
      }
      if (operation.kind === 'OFFER_DEPOSIT') {
        const next = { ...term };
        if (operation.value) next.deposit = structuredClone(operation.value);
        else delete next.deposit;
        return next;
      }
      if (operation.kind === 'OFFER_MILEAGE_LIMIT') {
        const next = { ...term };
        if (operation.value === null) delete next.mileageLimitKmPerYear;
        else next.mileageLimitKmPerYear = operation.value;
        return next;
      }
      return term;
    });
  }

  const { sourceRevision: _previousSourceRevision, ...base } = offer;
  return {
    ...base,
    priceTerms: terms,
    revision: offer.revision + 1,
    validationStatus,
    updatedAt: now,
    updatedBy: input.actor,
    ...(sourceRevisionValue ? { sourceRevision: sourceRevisionValue } : {})
  };
}

function nextAssetFromOperations(
  asset: VehicleAsset | null,
  operations: SourceChangeOperation[],
  now: string,
  input: ApplyReviewedSourceChangeInput,
  validationStatus: 'VALID' | 'WARNING',
  sourceRevisionValue?: string
) {
  const odometer = operations.find(
    (item): item is Extract<SourceChangeOperation, { kind: 'ASSET_ODOMETER' }> =>
      item.kind === 'ASSET_ODOMETER'
  );
  if (!odometer) return asset;
  if (!asset) {
    throw new ReviewedSourceChangeRejectedError('VehicleAsset missing for odometer update');
  }

  const { sourceRevision: _previousSourceRevision, ...base } = asset;
  return {
    ...base,
    odometerKm: odometer.value,
    revision: asset.revision + 1,
    validationStatus,
    updatedAt: now,
    updatedBy: input.actor,
    ...(sourceRevisionValue ? { sourceRevision: sourceRevisionValue } : {})
  };
}

function buildRefreshLineage(input: {
  parents: FieldLineageRecord[];
  operations: SourceChangeOperation[];
  offerBefore: Offer;
  offerAfter: Offer;
  assetBefore: VehicleAsset | null;
  assetAfter: VehicleAsset | null;
}) {
  const records: FieldLineageRecord[] = [];

  const parentFor = (normalizedPath: string) =>
    input.parents.find(
      (item) =>
        item.stage === 'RAW_TO_NORMALIZED' &&
        item.normalized?.fieldPath === normalizedPath
    );

  const append = (
    parent: FieldLineageRecord | undefined,
    entityType: string,
    entityId: string,
    revision: number,
    fieldPath: string,
    value: unknown
  ) => {
    if (!parent || !parent.normalized) {
      throw new ReviewedSourceChangeRejectedError(
        `Missing normalized lineage for reviewed source change: ${fieldPath}`
      );
    }
    records.push({
      lineageRecordId: 'lin_' + stableDigest([
        parent.lineageRecordId,
        entityType,
        entityId,
        revision,
        fieldPath,
        'reviewed-source-change'
      ]).slice(0, 40),
      lineageId: parent.lineageId,
      stage: 'NORMALIZED_TO_CANONICAL',
      parentLineageRecordId: parent.lineageRecordId,
      runId: parent.runId,
      sourceId: parent.sourceId,
      sourceRecordId: parent.sourceRecordId,
      sourceFingerprint: parent.sourceFingerprint,
      observedAt: parent.observedAt,
      source: parent.source,
      normalized: parent.normalized,
      canonical: {
        entityType,
        entityId,
        revision,
        fieldPath,
        value: structuredClone(value)
      },
      transformId: 'reviewed-source-change',
      transformVersion: '1.0.0'
    });
  };

  for (const operation of input.operations) {
    if (operation.kind === 'OFFER_MONTHLY_RENT') {
      const term = input.offerAfter.priceTerms.find((x) => x.termKey === operation.termKey)!;
      append(
        parentFor(`priceTerms.${operation.termKey}.monthlyRent.amount`),
        'offer',
        input.offerAfter.id,
        input.offerAfter.revision,
        `priceTerms.${operation.termKey}.monthlyRent.amount`,
        term.monthlyRent.amount
      );
    } else if (operation.kind === 'OFFER_DEPOSIT_STATE') {
      const term = input.offerAfter.priceTerms.find((x) => x.termKey === operation.termKey)!;
      append(
        parentFor(`priceTerms.${operation.termKey}.depositState`),
        'offer',
        input.offerAfter.id,
        input.offerAfter.revision,
        `priceTerms.${operation.termKey}.depositState`,
        term.depositState
      );
    } else if (operation.kind === 'OFFER_DEPOSIT') {
      const term = input.offerAfter.priceTerms.find((x) => x.termKey === operation.termKey)!;
      if (term.deposit) {
        append(
          parentFor(`priceTerms.${operation.termKey}.deposit.amount`),
          'offer',
          input.offerAfter.id,
          input.offerAfter.revision,
          `priceTerms.${operation.termKey}.deposit.amount`,
          term.deposit.amount
        );
      }
    } else if (operation.kind === 'OFFER_MILEAGE_LIMIT') {
      const term = input.offerAfter.priceTerms.find((x) => x.termKey === operation.termKey)!;
      if (term.mileageLimitKmPerYear !== undefined) {
        append(
          parentFor(`priceTerms.${operation.termKey}.mileageLimitKmPerYear`),
          'offer',
          input.offerAfter.id,
          input.offerAfter.revision,
          `priceTerms.${operation.termKey}.mileageLimitKmPerYear`,
          term.mileageLimitKmPerYear
        );
      }
    } else if (operation.kind === 'ASSET_ODOMETER') {
      if (!input.assetAfter) {
        throw new ReviewedSourceChangeRejectedError('VehicleAsset missing after odometer update');
      }
      append(
        parentFor('mileageKm'),
        'vehicle_asset',
        input.assetAfter.id,
        input.assetAfter.revision,
        'odometerKm',
        input.assetAfter.odometerKm
      );
    }
  }

  return records;
}

export async function applyReviewedSourceChange(
  store: CatalogStore,
  input: ApplyReviewedSourceChangeInput,
  now = new Date().toISOString()
): Promise<ReviewedSourceChangeReceipt> {
  assertCommandWriter('APPLY_REVIEWED_SOURCE_CHANGE', input.actor);
  if (!input.reason.trim()) {
    throw new ReviewedSourceChangeRejectedError('reason is required');
  }

  const writer = resolveExecutionWriter(input.actor, input.writer);
  const requestHash = requestDigest(input, writer.id);

  return store.transact(async (tx: CatalogTransaction) => {
    assertCatalogWriterOwnership(
      await tx.getCatalogWriterOwnership(),
      writer
    );
    const existing = await tx.getReviewedSourceChangeReceipt(input.idempotencyKey);
    if (existing) {
      if (existing.requestDigest !== requestHash) {
        throw new ReviewedSourceChangeIdempotencyConflictError(
          `Idempotency key ${input.idempotencyKey} was reused with different source-change input`
        );
      }
      return existing;
    }

    const state = await loadState(tx as unknown as ReviewReader, input.bindingId, input.candidateId);
    if (state.head.runId !== input.expectedHeadRunId) {
      throw new ReviewedSourceChangeConflictError(
        `Expected source head ${input.expectedHeadRunId}, actual ${state.head.runId}`
      );
    }
    assertExpectedRevisions(state, input);

    if (!sameIssues(state.candidateRecord.candidate.issues, input.approvedIssues)) {
      throw new ReviewedSourceChangeApprovalMismatchError(
        'Candidate issues must be explicitly and exactly approved'
      );
    }

    const { diffs, operations } = buildChanges(state);
    const review = toReview(state, diffs);
    const blocked = review.diffs.filter((item) => item.classification === 'BLOCKED');
    if (blocked.length) {
      throw new ReviewedSourceChangeBlockedError(blocked);
    }
    if (!exactSet(input.approvedChangeIds, review.reviewableChangeIds)) {
      throw new ReviewedSourceChangeApprovalMismatchError(
        'Approved change IDs must exactly match the current reviewable diff set'
      );
    }

    const selectedOperations = review.reviewableChangeIds.map((id) => {
      const operation = operations.get(id);
      if (!operation) {
        throw new ReviewedSourceChangeRejectedError(
          `Missing source-change operation for approved change ${id}`
        );
      }
      return operation;
    });

    for (const operation of selectedOperations) {
      const aggregate = operation.kind === 'ASSET_ODOMETER' ? 'vehicle_asset' : 'offer';
      const authority = assertFieldAuthority({
        aggregate,
        fieldPath: operation.authorityFieldPath,
        command: 'APPLY_REVIEWED_SOURCE_CHANGE',
        actor: input.actor
      });
      if (authority.sourceRefresh === 'SOURCE_REFRESH_BLOCKED') {
        throw new ReviewedSourceChangeBlockedError([
          review.diffs.find((item) => item.changeId === operation.changeId)!
        ]);
      }
    }

    const revisionValue = sourceRevision(state.head);
    const validationStatus =
      state.candidateRecord.status === 'WARNING' ? 'WARNING' as const : 'VALID' as const;
    const nextOffer = nextOfferFromOperations(
      state.offer,
      selectedOperations,
      now,
      input,
      validationStatus,
      revisionValue
    );
    const nextAsset = nextAssetFromOperations(
      state.asset,
      selectedOperations,
      now,
      input,
      validationStatus,
      revisionValue
    );

    const offerChanged = nextOffer !== state.offer;
    const assetChanged = nextAsset !== state.asset;

    const parents = await tx.listLineageForCandidate(state.candidateRecord.candidateId);
    const refreshLineage = buildRefreshLineage({
      parents,
      operations: selectedOperations,
      offerBefore: state.offer,
      offerAfter: nextOffer,
      assetBefore: state.asset,
      assetAfter: nextAsset
    });

    if (offerChanged) {
      await tx.putOffer(nextOffer);
      await tx.appendRevision({
        revisionRecordId: 'rev_' + stableDigest([
          input.commandId,
          'offer',
          nextOffer.id,
          nextOffer.revision
        ]).slice(0, 32),
        entityType: 'offer',
        entityId: nextOffer.id,
        revision: nextOffer.revision,
        previousRevision: state.offer.revision,
        snapshot: nextOffer,
        actor: input.actor,
        reason: input.reason,
        origin: 'SOURCE_REFRESH',
        commandId: input.commandId,
        occurredAt: now,
        sourceBindingId: state.binding.bindingId,
        sourceRunId: state.run.runId
      });
      await tx.appendAudit({
        eventId: randomUUID(),
        commandId: input.commandId,
        actor: input.actor,
        entityType: 'offer',
        entityId: nextOffer.id,
        action: 'REVIEWED_SOURCE_CHANGE_APPLIED',
        before: state.offer,
        after: nextOffer,
        reason: input.reason,
        writerId: writer.id,
        revisionBefore: state.offer.revision,
        revisionAfter: nextOffer.revision,
        occurredAt: now
      });
    }

    if (assetChanged && nextAsset && state.asset) {
      await tx.updateVehicleAsset(nextAsset);
      await tx.appendRevision({
        revisionRecordId: 'rev_' + stableDigest([
          input.commandId,
          'vehicle_asset',
          nextAsset.id,
          nextAsset.revision
        ]).slice(0, 32),
        entityType: 'vehicle_asset',
        entityId: nextAsset.id,
        revision: nextAsset.revision,
        previousRevision: state.asset.revision,
        snapshot: nextAsset,
        actor: input.actor,
        reason: input.reason,
        origin: 'SOURCE_REFRESH',
        commandId: input.commandId,
        occurredAt: now,
        sourceBindingId: state.binding.bindingId,
        sourceRunId: state.run.runId
      });
      await tx.appendAudit({
        eventId: randomUUID(),
        commandId: input.commandId,
        actor: input.actor,
        entityType: 'vehicle_asset',
        entityId: nextAsset.id,
        action: 'REVIEWED_SOURCE_CHANGE_APPLIED',
        before: state.asset,
        after: nextAsset,
        reason: input.reason,
        writerId: writer.id,
        revisionBefore: state.asset.revision,
        revisionAfter: nextAsset.revision,
        occurredAt: now
      });
    }

    for (const record of refreshLineage) {
      await tx.appendLineage(record);
    }

    const bindingNeedsAdvance =
      state.binding.sourceFingerprint !== state.candidateRecord.sourceFingerprint ||
      state.binding.sourceRunId !== state.run.runId;

    const nextBinding: CanonicalSourceBinding = bindingNeedsAdvance
      ? {
          ...state.binding,
          sourceFingerprint: state.candidateRecord.sourceFingerprint,
          sourceRunId: state.run.runId,
          sourceObservedAt: state.head.observedAt,
          sourceCheckpointRevision: state.head.checkpoint.sourceRevision ?? null,
          sourceCheckpointChecksum: state.head.checkpoint.checksum ?? null,
          sourceSupplierCode:
            state.candidateRecord.candidate.providerCompanyCode ??
            state.binding.sourceSupplierCode ??
            null,
          revision: state.binding.revision + 1,
          updatedAt: now,
          updatedBy: input.actor
        }
      : state.binding;

    if (bindingNeedsAdvance) {
      await tx.updateSourceBinding(nextBinding);
      await tx.appendAudit({
        eventId: randomUUID(),
        commandId: input.commandId,
        actor: input.actor,
        entityType: 'canonical_binding',
        entityId: nextBinding.bindingId,
        action: 'SOURCE_BINDING_ADVANCED',
        before: state.binding,
        after: nextBinding,
        reason: input.reason,
        writerId: writer.id,
        revisionBefore: state.binding.revision,
        revisionAfter: nextBinding.revision,
        occurredAt: now
      });
    }

    if (offerChanged || assetChanged) {
      await tx.appendOutbox({
        eventId: randomUUID(),
        eventType: 'catalog.source-change.applied',
        entityType: 'product',
        entityId: state.product.id,
        sourceRevision: state.binding.revision,
        targetRevision: nextBinding.revision,
        commandId: input.commandId,
        correlationId: input.commandId,
        causationId: state.run.runId,
        occurredAt: now,
        status: 'PENDING',
        attempts: 0
      });
    }

    const receipt: ReviewedSourceChangeReceipt = {
      idempotencyKey: input.idempotencyKey,
      commandId: input.commandId,
      status: offerChanged || assetChanged ? 'CANONICAL_COMMITTED' : 'NO_CHANGE',
      requestDigest: requestHash,
      bindingId: nextBinding.bindingId,
      bindingRevision: nextBinding.revision,
      sourceRunId: state.run.runId,
      sourceFingerprint: state.candidateRecord.sourceFingerprint,
      writerId: writer.id,
      appliedChangeIds: [...review.reviewableChangeIds],
      offerId: nextOffer.id,
      offerRevision: nextOffer.revision,
      ...(nextAsset
        ? {
            vehicleAssetId: nextAsset.id,
            vehicleAssetRevision: nextAsset.revision
          }
        : {}),
      committedAt: now
    };
    await tx.putReviewedSourceChangeReceipt(receipt);
    return receipt;
  });
}
