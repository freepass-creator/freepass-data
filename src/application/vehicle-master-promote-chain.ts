import {
  deterministicVehicleMasterRecordId,
  sealVehicleMasterNode,
  sealVehicleMasterPriceRevision,
  type VehicleMasterNode,
  type VehicleMasterPriceRevision,
} from '../domain/vehicle-master.js';
import { stableDigest } from '../shared/stable-digest.js';
import type { VehicleMasterStore } from '../ports/vehicle-master-store.js';
import type { VehicleMasterTrimProposalSet } from './vehicle-master-canonical-builder.js';
import {
  promoteVehicleMasterNode,
  promoteVehicleMasterPriceRevision,
  type PromoteVehicleMasterNodeResult,
  type PromoteVehicleMasterPriceResult,
} from './vehicle-master-ingestion.js';

export type VehicleMasterTrimPromotionResult = {
  modelYear: PromoteVehicleMasterNodeResult;
  powertrain: PromoteVehicleMasterNodeResult;
  variant: PromoteVehicleMasterNodeResult;
  trim: PromoteVehicleMasterNodeResult;
  basePrice: PromoteVehicleMasterPriceResult;
};

function substantiveNode(record: VehicleMasterNode) {
  const {
    schemaVersion: _schemaVersion,
    revision: _revision,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    contentHash: _contentHash,
    ...substantive
  } = record;
  return substantive;
}

async function prepareNode(
  store: VehicleMasterStore,
  candidate: VehicleMasterNode
): Promise<VehicleMasterNode> {
  const existing = await store.getNode(candidate.id);
  if (!existing) return candidate;
  if (existing.contentHash === candidate.contentHash) return existing;

  if (stableDigest(substantiveNode(existing)) === stableDigest(substantiveNode(candidate))) {
    return existing;
  }

  if (existing.status !== 'HOLD' && candidate.status === 'HOLD') {
    return existing;
  }

  const {
    schemaVersion: _schemaVersion,
    contentHash: _contentHash,
    revision: _revision,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...base
  } = candidate;

  return sealVehicleMasterNode({
    ...base,
    revision: existing.revision + 1,
    createdAt: existing.createdAt,
    updatedAt: candidate.updatedAt,
  });
}

function samePriceFacts(a: VehicleMasterPriceRevision, b: VehicleMasterPriceRevision) {
  return (
    a.targetId === b.targetId &&
    a.priceType === b.priceType &&
    a.amount === b.amount &&
    a.currency === b.currency &&
    (a.effectiveFrom ?? null) === (b.effectiveFrom ?? null) &&
    (a.effectiveTo ?? null) === (b.effectiveTo ?? null)
  );
}

async function preparePrice(
  store: VehicleMasterStore,
  candidate: VehicleMasterPriceRevision
): Promise<VehicleMasterPriceRevision> {
  const existing = (await store.listPriceRevisionsByTarget(candidate.targetId))
    .filter((item) => item.priceType === candidate.priceType)
    .sort((a, b) => a.revision - b.revision || a.id.localeCompare(b.id));

  const same = existing.find((item) => samePriceFacts(item, candidate));
  if (same) return same;

  const nextRevision = (existing.at(-1)?.revision ?? 0) + 1;
  if (!existing.length && candidate.revision === 1) return candidate;

  const {
    schemaVersion: _schemaVersion,
    contentHash: _contentHash,
    revision: _revision,
    id: _id,
    ...base
  } = candidate;
  const id = deterministicVehicleMasterRecordId('price', {
    targetId: candidate.targetId,
    priceType: candidate.priceType,
    effectiveFrom: candidate.effectiveFrom ?? null,
    revision: nextRevision,
  });

  return sealVehicleMasterPriceRevision({
    ...base,
    id,
    revision: nextRevision,
  });
}

export async function promoteVehicleMasterTrimProposalSet(
  store: VehicleMasterStore,
  proposalSet: VehicleMasterTrimProposalSet
): Promise<VehicleMasterTrimPromotionResult> {
  const modelYearRecord = await prepareNode(store, proposalSet.modelYear.record);
  const modelYear = await promoteVehicleMasterNode(store, {
    proposal: modelYearRecord,
    observations: proposalSet.modelYear.observations,
    policy: proposalSet.modelYear.policy,
    observedAt: modelYearRecord.updatedAt,
  });

  const powertrainRecord = await prepareNode(store, proposalSet.powertrain.record);
  const powertrain = await promoteVehicleMasterNode(store, {
    proposal: powertrainRecord,
    observations: proposalSet.powertrain.observations,
    policy: proposalSet.powertrain.policy,
    observedAt: powertrainRecord.updatedAt,
  });

  const variantRecord = await prepareNode(store, proposalSet.variant.record);
  const variant = await promoteVehicleMasterNode(store, {
    proposal: variantRecord,
    observations: proposalSet.variant.observations,
    policy: proposalSet.variant.policy,
    observedAt: variantRecord.updatedAt,
  });

  const trimRecord = await prepareNode(store, proposalSet.trim.record);
  const trim = await promoteVehicleMasterNode(store, {
    proposal: trimRecord,
    observations: proposalSet.trim.observations,
    policy: proposalSet.trim.policy,
    observedAt: trimRecord.updatedAt,
  });

  const priceRecord = await preparePrice(store, proposalSet.basePrice.record);
  const basePrice = await promoteVehicleMasterPriceRevision(store, {
    proposal: priceRecord,
    observations: proposalSet.basePrice.observations,
    policy: proposalSet.basePrice.policy,
    observedAt: priceRecord.updatedAt,
  });

  return { modelYear, powertrain, variant, trim, basePrice };
}
