import {
  deterministicVehicleMasterId,
  deterministicVehicleMasterRecordId,
  sealVehicleMasterCompatibilityRule,
  sealVehicleMasterNode,
  sealVehicleMasterPriceRevision,
  type VehicleMasterCompatibilityRule,
  type VehicleMasterNode,
  type VehicleMasterPriceRevision,
} from '../domain/vehicle-master.js';
import type {
  VehicleMasterReconciledOption,
  VehicleMasterReconciledTrim,
} from './vehicle-master-reconcile.js';
import type {
  VehicleMasterCanonicalProposalUnit,
  VehicleMasterTrimProposalSet,
} from './vehicle-master-canonical-builder.js';
import type {
  VehicleMasterEvidencePolicy,
  VehicleMasterFieldObservation,
} from './vehicle-master-ingestion.js';

export type VehicleMasterStructuralSelection = {
  kind: 'SEATS' | 'DRIVETRAIN';
  name: string;
  price: number | null;
  sourceDocumentIds: string[];
};

export type VehicleMasterUnresolvedCondition = {
  optionName: string;
  relation: 'REQUIRES' | 'EXCLUDES';
  targetLabel: string;
  raw: string;
  sourceDocumentIds: string[];
};

export type VehicleMasterOptionProposal = {
  source: VehicleMasterReconciledOption;
  node: VehicleMasterCanonicalProposalUnit<VehicleMasterNode>;
  price: VehicleMasterCanonicalProposalUnit<VehicleMasterPriceRevision> | null;
  availability: VehicleMasterCanonicalProposalUnit<VehicleMasterCompatibilityRule>;
  dependencies: VehicleMasterCanonicalProposalUnit<VehicleMasterCompatibilityRule>[];
};

export type VehicleMasterOptionProposalSet = {
  options: VehicleMasterOptionProposal[];
  structuralSelections: VehicleMasterStructuralSelection[];
  unresolvedConditions: VehicleMasterUnresolvedCondition[];
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

function nodeTypeFor(option: VehicleMasterReconciledOption): 'OPTION' | 'COLOR' {
  return option.kind === 'COLOR' ? 'COLOR' : 'OPTION';
}

function priceTypeFor(option: VehicleMasterReconciledOption): 'OPTION' | 'COLOR' {
  return option.kind === 'COLOR' ? 'COLOR' : 'OPTION';
}

export function buildVehicleMasterOptionProposalSet(input: {
  reconciled: VehicleMasterReconciledTrim;
  trimProposalSet: VehicleMasterTrimProposalSet;
  observedAt: string;
  revision?: number;
}): VehicleMasterOptionProposalSet {
  const revision = input.revision ?? 1;
  const trim = input.trimProposalSet.trim.record;
  const modelYearId = input.trimProposalSet.modelYear.record.id;
  const modelYearRefs = {
    makeId: trim.refs.makeId ?? null,
    modelId: trim.refs.modelId ?? null,
    generationId: trim.refs.generationId ?? null,
    phaseId: trim.refs.phaseId ?? null,
    modelYearId,
  };

  const structuralSelections: VehicleMasterStructuralSelection[] = [];
  const canonicalOptions = input.reconciled.options.filter((option) => {
    if (option.kind === 'SEATS' || option.kind === 'DRIVETRAIN') {
      structuralSelections.push({
        kind: option.kind,
        name: option.name,
        price: option.price,
        sourceDocumentIds: option.sourceDocumentIds,
      });
      return false;
    }
    return true;
  });

  const nodeIdByLabel = new Map<string, string>();
  for (const option of canonicalOptions) {
    const nodeType = nodeTypeFor(option);
    const id = deterministicVehicleMasterId(nodeType, {
      modelYearId,
      identity: normalized(option.name),
      selectionKind: option.kind,
    });
    nodeIdByLabel.set(normalized(option.name), id);
  }

  const unresolvedConditions: VehicleMasterUnresolvedCondition[] = [];
  const options: VehicleMasterOptionProposal[] = canonicalOptions.map((option) => {
    const nodeType = nodeTypeFor(option);
    const nodeId = nodeIdByLabel.get(normalized(option.name))!;
    const node = sealVehicleMasterNode({
      id: nodeId,
      nodeType,
      status: 'ACTIVE',
      revision,
      canonicalName: option.name,
      parentId: modelYearId,
      refs: modelYearRefs,
      aliases: [],
      attributes: {
        selectionKind: option.kind,
        note: option.note,
      },
      sourceEvidenceIds: option.sourceDocumentIds,
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: input.observedAt,
      updatedAt: input.observedAt,
    });

    const nodeUnit: VehicleMasterCanonicalProposalUnit<VehicleMasterNode> = {
      record: node,
      observations: observations('canonicalName', option.name, option.sourceDocumentIds),
      policy: policy(['canonicalName']),
    };

    let priceUnit: VehicleMasterCanonicalProposalUnit<VehicleMasterPriceRevision> | null = null;
    if (option.price !== null) {
      const price = sealVehicleMasterPriceRevision({
        id: deterministicVehicleMasterRecordId('price', {
          targetId: nodeId,
          priceType: priceTypeFor(option),
          effectiveFrom: input.reconciled.effectiveFrom,
          revision,
        }),
        targetId: nodeId,
        priceType: priceTypeFor(option),
        amount: option.price,
        currency: 'KRW',
        revision,
        sourceEvidenceIds: option.sourceDocumentIds,
        sourceDocumentIds: option.sourceDocumentIds,
        effectiveFrom: input.reconciled.effectiveFrom,
        effectiveTo: null,
        createdAt: input.observedAt,
        updatedAt: input.observedAt,
      });
      priceUnit = {
        record: price,
        observations: [
          ...observations('amount', option.price, option.sourceDocumentIds),
          ...observations('currency', 'KRW', option.sourceDocumentIds),
        ],
        policy: policy(['amount', 'currency']),
      };
    }

    const availability = sealVehicleMasterCompatibilityRule({
      id: deterministicVehicleMasterRecordId('rule', {
        subjectId: nodeId,
        ruleType: 'AVAILABLE_IF',
        trimId: trim.id,
      }),
      revision,
      subjectId: nodeId,
      ruleType: 'AVAILABLE_IF',
      targetIds: [],
      scope: { trimId: trim.id },
      condition: { sourceLabel: option.name },
      effect: 'VALID',
      priority: 100,
      sourceEvidenceIds: option.sourceDocumentIds,
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: input.observedAt,
      updatedAt: input.observedAt,
    });
    const availabilityUnit: VehicleMasterCanonicalProposalUnit<VehicleMasterCompatibilityRule> = {
      record: availability,
      observations: observations(
        'condition.sourceLabel',
        option.name,
        option.sourceDocumentIds
      ),
      policy: policy(['condition.sourceLabel']),
    };

    const dependencies: VehicleMasterCanonicalProposalUnit<VehicleMasterCompatibilityRule>[] = [];
    for (const condition of option.conditions) {
      const targetId = nodeIdByLabel.get(normalized(condition.targetLabel));
      if (!targetId) {
        unresolvedConditions.push({
          optionName: option.name,
          relation: condition.relation,
          targetLabel: condition.targetLabel,
          raw: condition.raw,
          sourceDocumentIds: option.sourceDocumentIds,
        });
        continue;
      }

      const rule = sealVehicleMasterCompatibilityRule({
        id: deterministicVehicleMasterRecordId('rule', {
          subjectId: nodeId,
          ruleType: condition.relation,
          targetId,
          trimId: trim.id,
        }),
        revision,
        subjectId: nodeId,
        ruleType: condition.relation,
        targetIds: [targetId],
        scope: { trimId: trim.id },
        condition: {
          targetLabel: condition.targetLabel,
          raw: condition.raw,
        },
        effect: condition.relation === 'EXCLUDES' ? 'INVALID' : 'VALID',
        priority: 200,
        sourceEvidenceIds: option.sourceDocumentIds,
        effectiveFrom: null,
        effectiveTo: null,
        createdAt: input.observedAt,
        updatedAt: input.observedAt,
      });
      dependencies.push({
        record: rule,
        observations: observations(
          'condition.targetLabel',
          condition.targetLabel,
          option.sourceDocumentIds
        ),
        policy: policy(['condition.targetLabel']),
      });
    }

    return {
      source: option,
      node: nodeUnit,
      price: priceUnit,
      availability: availabilityUnit,
      dependencies,
    };
  });

  return {
    options,
    structuralSelections: structuralSelections.sort((a, b) =>
      a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)
    ),
    unresolvedConditions,
  };
}
