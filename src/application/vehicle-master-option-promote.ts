import type { VehicleMasterStore } from '../ports/vehicle-master-store.js';
import type {
  VehicleMasterOptionProposalSet,
  VehicleMasterStructuralSelection,
  VehicleMasterUnresolvedCondition,
} from './vehicle-master-option-builder.js';
import {
  promoteVehicleMasterCompatibilityRule,
  promoteVehicleMasterNode,
  promoteVehicleMasterPriceRevision,
  type PromoteVehicleMasterNodeResult,
  type PromoteVehicleMasterPriceResult,
  type PromoteVehicleMasterRuleResult,
} from './vehicle-master-ingestion.js';
import {
  prepareVehicleMasterCompatibilityRule,
  prepareVehicleMasterNode,
  prepareVehicleMasterPrice,
} from './vehicle-master-promote-chain.js';

export type VehicleMasterOptionPromotion = {
  node: PromoteVehicleMasterNodeResult;
  price: PromoteVehicleMasterPriceResult | null;
  availability: PromoteVehicleMasterRuleResult;
  dependencies: PromoteVehicleMasterRuleResult[];
};

export type VehicleMasterOptionPromotionSetResult = {
  options: VehicleMasterOptionPromotion[];
  structuralSelections: VehicleMasterStructuralSelection[];
  unresolvedConditions: VehicleMasterUnresolvedCondition[];
};

export async function promoteVehicleMasterOptionProposalSet(
  store: VehicleMasterStore,
  proposalSet: VehicleMasterOptionProposalSet
): Promise<VehicleMasterOptionPromotionSetResult> {
  const nodeResults: PromoteVehicleMasterNodeResult[] = [];

  for (const option of proposalSet.options) {
    const record = await prepareVehicleMasterNode(store, option.node.record);
    nodeResults.push(await promoteVehicleMasterNode(store, {
      proposal: record,
      observations: option.node.observations,
      policy: option.node.policy,
      observedAt: record.updatedAt,
    }));
  }

  const options: VehicleMasterOptionPromotion[] = [];
  for (let index = 0; index < proposalSet.options.length; index += 1) {
    const option = proposalSet.options[index]!;
    const node = nodeResults[index]!;

    let price: PromoteVehicleMasterPriceResult | null = null;
    if (option.price) {
      const record = await prepareVehicleMasterPrice(store, option.price.record);
      price = await promoteVehicleMasterPriceRevision(store, {
        proposal: record,
        observations: option.price.observations,
        policy: option.price.policy,
        observedAt: record.updatedAt,
      });
    }

    const availabilityRecord = await prepareVehicleMasterCompatibilityRule(
      store,
      option.availability.record
    );
    const availability = await promoteVehicleMasterCompatibilityRule(store, {
      proposal: availabilityRecord,
      observations: option.availability.observations,
      policy: option.availability.policy,
      observedAt: availabilityRecord.updatedAt,
    });

    const dependencies: PromoteVehicleMasterRuleResult[] = [];
    for (const dependency of option.dependencies) {
      const record = await prepareVehicleMasterCompatibilityRule(store, dependency.record);
      dependencies.push(await promoteVehicleMasterCompatibilityRule(store, {
        proposal: record,
        observations: dependency.observations,
        policy: dependency.policy,
        observedAt: record.updatedAt,
      }));
    }

    options.push({ node, price, availability, dependencies });
  }

  return {
    options,
    structuralSelections: proposalSet.structuralSelections,
    unresolvedConditions: proposalSet.unresolvedConditions,
  };
}
