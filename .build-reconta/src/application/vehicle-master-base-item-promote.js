import { promoteVehicleMasterCompatibilityRule, promoteVehicleMasterNode, } from './vehicle-master-ingestion.js';
import { prepareVehicleMasterCompatibilityRule, prepareVehicleMasterNode, } from './vehicle-master-promote-chain.js';
export async function promoteVehicleMasterBaseItemProposalSet(store, proposalSet) {
    const nodeResults = [];
    for (const item of proposalSet.items) {
        const node = await prepareVehicleMasterNode(store, item.node.record);
        nodeResults.push(await promoteVehicleMasterNode(store, {
            proposal: node,
            observations: item.node.observations,
            policy: item.node.policy,
            observedAt: node.updatedAt,
        }));
    }
    const items = [];
    for (let index = 0; index < proposalSet.items.length; index += 1) {
        const item = proposalSet.items[index];
        const inclusion = await prepareVehicleMasterCompatibilityRule(store, item.inclusion.record);
        const inclusionResult = await promoteVehicleMasterCompatibilityRule(store, {
            proposal: inclusion,
            observations: item.inclusion.observations,
            policy: item.inclusion.policy,
            observedAt: inclusion.updatedAt,
        });
        items.push({
            node: nodeResults[index],
            inclusion: inclusionResult,
        });
    }
    return { items };
}
