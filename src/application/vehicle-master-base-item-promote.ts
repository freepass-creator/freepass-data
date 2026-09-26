import type { VehicleMasterStore } from '../ports/vehicle-master-store.js';
import type {
  VehicleMasterBaseItemProposalSet,
} from './vehicle-master-base-item-builder.js';
import {
  promoteVehicleMasterCompatibilityRule,
  promoteVehicleMasterNode,
  type PromoteVehicleMasterNodeResult,
  type PromoteVehicleMasterRuleResult,
} from './vehicle-master-ingestion.js';
import {
  prepareVehicleMasterCompatibilityRule,
  prepareVehicleMasterNode,
} from './vehicle-master-promote-chain.js';

export type VehicleMasterBaseItemPromotion = {
  node: PromoteVehicleMasterNodeResult;
  inclusion: PromoteVehicleMasterRuleResult;
};

export type VehicleMasterBaseItemPromotionSetResult = {
  items: VehicleMasterBaseItemPromotion[];
};

export async function promoteVehicleMasterBaseItemProposalSet(
  store: VehicleMasterStore,
  proposalSet: VehicleMasterBaseItemProposalSet
): Promise<VehicleMasterBaseItemPromotionSetResult> {
  const nodeResults: PromoteVehicleMasterNodeResult[] = [];

  for (const item of proposalSet.items) {
    const node = await prepareVehicleMasterNode(store, item.node.record);
    nodeResults.push(await promoteVehicleMasterNode(store, {
      proposal: node,
      observations: item.node.observations,
      policy: item.node.policy,
      observedAt: node.updatedAt,
    }));
  }

  const items: VehicleMasterBaseItemPromotion[] = [];
  for (let index = 0; index < proposalSet.items.length; index += 1) {
    const item = proposalSet.items[index]!;
    const inclusion = await prepareVehicleMasterCompatibilityRule(
      store,
      item.inclusion.record
    );
    const inclusionResult = await promoteVehicleMasterCompatibilityRule(store, {
      proposal: inclusion,
      observations: item.inclusion.observations,
      policy: item.inclusion.policy,
      observedAt: inclusion.updatedAt,
    });
    items.push({
      node: nodeResults[index]!,
      inclusion: inclusionResult,
    });
  }

  return { items };
}
