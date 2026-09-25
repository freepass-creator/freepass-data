import {
  deterministicVehicleMasterId,
  deterministicVehicleMasterRecordId,
  sealVehicleMasterCompatibilityRule,
  sealVehicleMasterNode,
  type VehicleMasterCompatibilityRule,
  type VehicleMasterNode,
} from '../domain/vehicle-master.js';
import type { VehicleMasterReconciledTrim } from './vehicle-master-reconcile.js';
import type {
  VehicleMasterCanonicalProposalUnit,
  VehicleMasterTrimProposalSet,
} from './vehicle-master-canonical-builder.js';
import type {
  VehicleMasterEvidencePolicy,
  VehicleMasterFieldObservation,
} from './vehicle-master-ingestion.js';

export type VehicleMasterBaseItemProposal = {
  node: VehicleMasterCanonicalProposalUnit<VehicleMasterNode>;
  inclusion: VehicleMasterCanonicalProposalUnit<VehicleMasterCompatibilityRule>;
};

export type VehicleMasterBaseItemProposalSet = {
  items: VehicleMasterBaseItemProposal[];
};

function normalized(value: string) {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[()[\]{}]/g, ' ')
    .replace(/[^0-9a-z가-힣.]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

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

function policy(requiredFieldPaths: string[]): VehicleMasterEvidencePolicy {
  return {
    requiredFieldPaths,
    minCorroboratingSourcesWithoutOfficial: 2,
  };
}

export function buildVehicleMasterBaseItemProposalSet(input: {
  reconciled: VehicleMasterReconciledTrim;
  trimProposalSet: VehicleMasterTrimProposalSet;
  observedAt: string;
  revision?: number;
}): VehicleMasterBaseItemProposalSet {
  const revision = input.revision ?? 1;
  const trim = input.trimProposalSet.trim.record;
  const modelYearId = input.trimProposalSet.modelYear.record.id;
  const refs = {
    makeId: trim.refs.makeId ?? null,
    modelId: trim.refs.modelId ?? null,
    generationId: trim.refs.generationId ?? null,
    phaseId: trim.refs.phaseId ?? null,
    modelYearId,
  };

  const details = input.reconciled.baseItemDetails ?? [];
  const items = details.map((item) => {
    const nodeId = deterministicVehicleMasterId('BASE_ITEM', {
      modelYearId,
      category: item.category ?? null,
      identity: normalized(item.name),
    });
    const node = sealVehicleMasterNode({
      id: nodeId,
      nodeType: 'BASE_ITEM',
      status: 'ACTIVE',
      revision,
      canonicalName: item.name,
      parentId: modelYearId,
      refs,
      aliases: [],
      attributes: {
        category: item.category,
      },
      sourceEvidenceIds: item.sourceDocumentIds,
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: input.observedAt,
      updatedAt: input.observedAt,
    });

    const inclusion = sealVehicleMasterCompatibilityRule({
      id: deterministicVehicleMasterRecordId('rule', {
        subjectId: trim.id,
        ruleType: 'INCLUDES',
        targetId: nodeId,
        trimId: trim.id,
      }),
      revision,
      subjectId: trim.id,
      ruleType: 'INCLUDES',
      targetIds: [nodeId],
      scope: { trimId: trim.id },
      condition: {
        sourceLabel: item.name,
        category: item.category,
      },
      effect: 'VALID',
      priority: 50,
      sourceEvidenceIds: item.sourceDocumentIds,
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: input.observedAt,
      updatedAt: input.observedAt,
    });

    return {
      node: {
        record: node,
        observations: observations('canonicalName', item.name, item.sourceDocumentIds),
        policy: policy(['canonicalName']),
      },
      inclusion: {
        record: inclusion,
        observations: observations(
          'condition.sourceLabel',
          item.name,
          item.sourceDocumentIds
        ),
        policy: policy(['condition.sourceLabel']),
      },
    };
  });

  return { items };
}
