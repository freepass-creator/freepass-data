import {
  deterministicVehicleMasterId,
  deterministicVehicleMasterRecordId,
  sealVehicleMasterNode,
  sealVehicleMasterPriceRevision,
  type VehicleMasterNode,
  type VehicleMasterPriceRevision,
  type VehicleMasterStatus,
} from '../domain/vehicle-master.js';
import {
  canonicalDrivetrain,
  canonicalPowertrainIdentity,
  canonicalSeatCount,
  canonicalTrimIdentity,
} from '../domain/vehicle-master-normalization.js';
import type {
  VehicleMasterReconciledTrim,
} from './vehicle-master-reconcile.js';
import type {
  VehicleMasterEvidencePolicy,
  VehicleMasterFieldObservation,
} from './vehicle-master-ingestion.js';

export type VehicleMasterCanonicalAnchor = {
  makeId: string;
  modelId: string;
  generationId: string;
  phaseId: string;
};

export type VehicleMasterCanonicalProposalUnit<T> = {
  record: T;
  observations: VehicleMasterFieldObservation[];
  policy: VehicleMasterEvidencePolicy;
};

export type VehicleMasterTrimProposalSet = {
  modelYear: VehicleMasterCanonicalProposalUnit<VehicleMasterNode>;
  powertrain: VehicleMasterCanonicalProposalUnit<VehicleMasterNode>;
  variant: VehicleMasterCanonicalProposalUnit<VehicleMasterNode>;
  trim: VehicleMasterCanonicalProposalUnit<VehicleMasterNode>;
  basePrice: VehicleMasterCanonicalProposalUnit<VehicleMasterPriceRevision>;
};

export {
  canonicalPowertrainIdentity,
  canonicalTrimIdentity,
} from '../domain/vehicle-master-normalization.js';

function observations(
  fieldPath: string,
  value: unknown,
  sourceDocumentIds: readonly string[]
): VehicleMasterFieldObservation[] {
  return [...new Set(sourceDocumentIds)].sort().map((sourceDocumentId) => ({
    fieldPath,
    value,
    sourceDocumentId,
  }));
}

function statusFor(record: VehicleMasterReconciledTrim): VehicleMasterStatus {
  return record.conflicts.length ||
    canonicalSeatCount(record.seats) === null ||
    canonicalDrivetrain(record.drivetrain) === null
    ? 'HOLD'
    : 'ACTIVE';
}

export function buildVehicleMasterTrimProposalSet(input: {
  anchor: VehicleMasterCanonicalAnchor;
  reconciled: VehicleMasterReconciledTrim;
  observedAt: string;
  revision?: number;
}): VehicleMasterTrimProposalSet {
  const revision = input.revision ?? 1;
  const { anchor, reconciled } = input;
  const sourceEvidenceIds = reconciled.sourceDocumentIds;
  const priceEffectiveFrom = reconciled.effectiveFrom;
  const status = statusFor(reconciled);
  const priceObservations: VehicleMasterFieldObservation[] = (reconciled.basePriceObservations ?? []).map((item) => ({
    fieldPath: 'amount', value: item.amount, sourceDocumentId: item.sourceDocumentId,
  }));
  const priceCurrencyObservations: VehicleMasterFieldObservation[] = (reconciled.basePriceObservations ?? []).map((item) => ({
    fieldPath: 'currency', value: item.currency, sourceDocumentId: item.sourceDocumentId,
  }));

  const modelYearId = deterministicVehicleMasterId('MODEL_YEAR', {
    phaseId: anchor.phaseId,
    modelYear: reconciled.modelYear,
  });
  const powertrainIdentity = canonicalPowertrainIdentity(reconciled.powertrainName);
  const powertrainId = deterministicVehicleMasterId('POWERTRAIN', {
    modelYearId,
    powertrainIdentity,
  });
  const variantSeats = canonicalSeatCount(reconciled.seats);
  const variantDrivetrain = canonicalDrivetrain(reconciled.drivetrain);
  const variantId = deterministicVehicleMasterId('VARIANT', {
    powertrainId,
    seats: variantSeats,
    drivetrain: variantDrivetrain,
  });
  const trimIdentity = canonicalTrimIdentity(reconciled.trimName);
  const trimId = deterministicVehicleMasterId('TRIM', {
    variantId,
    trimIdentity,
  });

  const commonRefs = {
    makeId: anchor.makeId,
    modelId: anchor.modelId,
    generationId: anchor.generationId,
    phaseId: anchor.phaseId,
  };

  const modelYear = sealVehicleMasterNode({
    id: modelYearId,
    nodeType: 'MODEL_YEAR',
    status: 'ACTIVE',
    revision,
    canonicalName: `${reconciled.modelYear}년형`,
    parentId: anchor.phaseId,
    refs: commonRefs,
    aliases: [String(reconciled.modelYear), `${reconciled.modelYear}MY`],
    attributes: { modelYear: reconciled.modelYear },
    sourceEvidenceIds,
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: input.observedAt,
    updatedAt: input.observedAt,
  });

  const powertrain = sealVehicleMasterNode({
    id: powertrainId,
    nodeType: 'POWERTRAIN',
    status: 'ACTIVE',
    revision,
    canonicalName: reconciled.powertrainName,
    parentId: modelYearId,
    refs: { ...commonRefs, modelYearId },
    aliases: [],
    attributes: {
      identityKey: powertrainIdentity,
      fuelType: reconciled.fuelType,
    },
    sourceEvidenceIds,
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: input.observedAt,
    updatedAt: input.observedAt,
  });

  const variant = sealVehicleMasterNode({
    id: variantId,
    nodeType: 'VARIANT',
    status,
    revision,
    canonicalName: [
      variantSeats === null ? '인승미상' : `${variantSeats}인승`,
      variantDrivetrain ?? '구동미상',
    ].join(' '),
    parentId: powertrainId,
    refs: { ...commonRefs, modelYearId, powertrainId },
    aliases: [],
    attributes: {
      seats: variantSeats,
      drivetrain: variantDrivetrain,
    },
    sourceEvidenceIds,
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: input.observedAt,
    updatedAt: input.observedAt,
  });

  const trim = sealVehicleMasterNode({
    id: trimId,
    nodeType: 'TRIM',
    status,
    revision,
    canonicalName: reconciled.trimName,
    parentId: variantId,
    refs: { ...commonRefs, modelYearId, powertrainId, variantId },
    aliases: [],
    attributes: {
      identityKey: trimIdentity,
      reconciliationConflicts: reconciled.conflicts,
    },
    sourceEvidenceIds,
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: input.observedAt,
    updatedAt: input.observedAt,
  });

  const priceId = deterministicVehicleMasterRecordId('price', {
    targetId: trimId,
    priceType: 'BASE',
    effectiveFrom: priceEffectiveFrom,
    revision,
  });
  const basePrice = sealVehicleMasterPriceRevision({
    id: priceId,
    targetId: trimId,
    priceType: 'BASE',
    amount: reconciled.basePrice,
    currency: reconciled.currency,
    revision,
    sourceEvidenceIds,
    sourceDocumentIds: sourceEvidenceIds,
    effectiveFrom: priceEffectiveFrom,
    effectiveTo: null,
    createdAt: input.observedAt,
    updatedAt: input.observedAt,
  });

  return {
    modelYear: {
      record: modelYear,
      observations: observations(
        'attributes.modelYear',
        reconciled.modelYear,
        reconciled.fieldEvidence.modelYear ?? []
      ),
      policy: {
        requiredFieldPaths: ['attributes.modelYear'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
    },
    powertrain: {
      record: powertrain,
      observations: observations(
        'attributes.identityKey',
        powertrainIdentity,
        reconciled.fieldEvidence.powertrainName ?? []
      ),
      policy: {
        requiredFieldPaths: ['attributes.identityKey'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
    },
    variant: {
      record: variant,
      observations: [
        ...observations(
          'attributes.seats',
          variantSeats,
          reconciled.fieldEvidence.seats ?? []
        ),
        ...observations(
          'attributes.drivetrain',
          variantDrivetrain,
          reconciled.fieldEvidence.drivetrain ?? []
        ),
      ],
      policy: {
        requiredFieldPaths: ['attributes.seats', 'attributes.drivetrain'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
    },
    trim: {
      record: trim,
      observations: observations(
        'canonicalName',
        reconciled.trimName,
        reconciled.fieldEvidence.trimName ?? []
      ),
      policy: {
        requiredFieldPaths: ['canonicalName'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
    },
    basePrice: {
      record: basePrice,
      observations: priceObservations.length
        ? [...priceObservations, ...priceCurrencyObservations]
        : [
            ...observations('amount', reconciled.basePrice, reconciled.fieldEvidence.basePrice ?? []),
            ...observations('currency', reconciled.currency, reconciled.fieldEvidence.currency ?? []),
          ],
      policy: {
        requiredFieldPaths: ['amount', 'currency'],
        minCorroboratingSourcesWithoutOfficial: 2,
      },
    },
  };
}
