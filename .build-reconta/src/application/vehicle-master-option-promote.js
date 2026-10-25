import { promoteVehicleMasterCompatibilityRule, promoteVehicleMasterNode, promoteVehicleMasterPriceRevision, } from './vehicle-master-ingestion.js';
import { prepareVehicleMasterCompatibilityRule, prepareVehicleMasterNode, prepareVehicleMasterPrice, } from './vehicle-master-promote-chain.js';
export async function promoteVehicleMasterOptionProposalSet(store, proposalSet) {
    const nodeResults = [];
    for (const option of proposalSet.options) {
        const record = await prepareVehicleMasterNode(store, option.node.record);
        nodeResults.push(await promoteVehicleMasterNode(store, {
            proposal: record,
            observations: option.node.observations,
            policy: option.node.policy,
            observedAt: record.updatedAt,
        }));
    }
    const options = [];
    for (let index = 0; index < proposalSet.options.length; index += 1) {
        const option = proposalSet.options[index];
        const node = nodeResults[index];
        let price = null;
        if (option.price) {
            const record = await prepareVehicleMasterPrice(store, option.price.record);
            price = await promoteVehicleMasterPriceRevision(store, {
                proposal: record,
                observations: option.price.observations,
                policy: option.price.policy,
                observedAt: record.updatedAt,
            });
        }
        const availabilityRecord = await prepareVehicleMasterCompatibilityRule(store, option.availability.record);
        const availability = await promoteVehicleMasterCompatibilityRule(store, {
            proposal: availabilityRecord,
            observations: option.availability.observations,
            policy: option.availability.policy,
            observedAt: availabilityRecord.updatedAt,
        });
        const dependencies = [];
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
