import { describe, expect, it } from 'vitest';
import {
  sealVehicleMasterCompatibilityRule,
  sealVehicleMasterNode,
  sealVehicleMasterSourceDocument,
  type VehicleMasterCompatibilityRule,
  type VehicleMasterNode,
} from '../src/domain/vehicle-master.js';
import {
  promoteVehicleMasterCompatibilityRule,
} from '../src/application/vehicle-master-ingestion.js';
import { MemoryVehicleMasterStore } from '../src/infra/vehicle-master-memory-store.js';
import {
  canonicalPowertrainIdentity,
  canonicalTrimIdentity,
} from '../src/domain/vehicle-master-normalization.js';

const observedAt = '2026-09-26T10:20:00.000Z';
const sourceDocumentId = 'official-option-group-semantics';

type Seeded = {
  make: VehicleMasterNode;
  model: VehicleMasterNode;
  generation: VehicleMasterNode;
  phase: VehicleMasterNode;
  modelYear: VehicleMasterNode;
  powertrain: VehicleMasterNode;
  variant: VehicleMasterNode;
  trim: VehicleMasterNode;
  group: VehicleMasterNode;
  optionA: VehicleMasterNode;
  optionB: VehicleMasterNode;
  packageNode: VehicleMasterNode;
  color: VehicleMasterNode;
  baseItem: VehicleMasterNode;
};

async function seedSource(store: MemoryVehicleMasterStore) {
  await store.putSourceDocument(sealVehicleMasterSourceDocument({
    sourceDocumentId,
    sourceType: 'MANUFACTURER_OFFICIAL',
    sourceName: 'official option-group semantics',
    sourceUrl: 'https://example.test/option-group-semantics',
    publishedAt: observedAt,
    observedAt,
    effectiveFrom: null,
    effectiveTo: null,
    storagePath: 'vehicle-master/source-documents/test/option-group-semantics.html',
    sha256: 'd'.repeat(64),
    mimeType: 'text/html',
    metadata: {},
  }));
}

async function seed(store: MemoryVehicleMasterStore): Promise<Seeded> {
  const make = sealVehicleMasterNode({
    id: 'make_group',
    nodeType: 'MAKE',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '기아',
    parentId: null,
    refs: {},
    aliases: [],
    attributes: {},
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  const model = sealVehicleMasterNode({
    id: 'model_group',
    nodeType: 'MODEL',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '쏘렌토',
    parentId: make.id,
    refs: { makeId: make.id },
    aliases: [],
    attributes: {},
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  const generation = sealVehicleMasterNode({
    id: 'gen_group',
    nodeType: 'GENERATION',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: 'MQ4',
    parentId: model.id,
    refs: { makeId: make.id, modelId: model.id },
    aliases: [],
    attributes: {},
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  const phase = sealVehicleMasterNode({
    id: 'phase_group',
    nodeType: 'PHASE',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '더 뉴 쏘렌토',
    parentId: generation.id,
    refs: {
      makeId: make.id,
      modelId: model.id,
      generationId: generation.id,
    },
    aliases: [],
    attributes: {},
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  const modelYear = sealVehicleMasterNode({
    id: 'my_group',
    nodeType: 'MODEL_YEAR',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '2027년형',
    parentId: phase.id,
    refs: {
      makeId: make.id,
      modelId: model.id,
      generationId: generation.id,
      phaseId: phase.id,
    },
    aliases: ['2027MY'],
    attributes: { modelYear: 2027 },
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  const powertrain = sealVehicleMasterNode({
    id: 'pt_group',
    nodeType: 'POWERTRAIN',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '2.5 가솔린 터보',
    parentId: modelYear.id,
    refs: { ...modelYear.refs, modelYearId: modelYear.id },
    aliases: [],
    attributes: {
      identityKey: canonicalPowertrainIdentity('2.5 가솔린 터보'),
      fuelType: 'GASOLINE',
    },
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  const variant = sealVehicleMasterNode({
    id: 'variant_group',
    nodeType: 'VARIANT',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '5인승 2WD',
    parentId: powertrain.id,
    refs: { ...powertrain.refs, powertrainId: powertrain.id },
    aliases: [],
    attributes: { seats: 5, drivetrain: '2WD' },
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  const trim = sealVehicleMasterNode({
    id: 'trim_group',
    nodeType: 'TRIM',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '프레스티지',
    parentId: variant.id,
    refs: { ...variant.refs, variantId: variant.id },
    aliases: [],
    attributes: { identityKey: canonicalTrimIdentity('프레스티지') },
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });

  const refs = {
    makeId: make.id,
    modelId: model.id,
    generationId: generation.id,
    phaseId: phase.id,
    modelYearId: modelYear.id,
  };

  const mk = (
    id: string,
    nodeType: 'OPTION_GROUP' | 'OPTION' | 'PACKAGE' | 'COLOR' | 'BASE_ITEM',
    canonicalName: string
  ) => sealVehicleMasterNode({
    id,
    nodeType,
    status: 'ACTIVE',
    revision: 1,
    canonicalName,
    parentId: modelYear.id,
    refs,
    aliases: [],
    attributes: {},
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });

  const group = mk('og_group', 'OPTION_GROUP', '휠 선택');
  const optionA = mk('opt_group_a', 'OPTION', '18인치 휠');
  const optionB = mk('opt_group_b', 'OPTION', '20인치 휠');
  const packageNode = mk('pkg_group', 'PACKAGE', '스타일 패키지');
  const color = mk('color_group', 'COLOR', '화이트 펄');
  const baseItem = mk('base_group', 'BASE_ITEM', '기본 휠');

  for (const node of [
    make,
    model,
    generation,
    phase,
    modelYear,
    powertrain,
    variant,
    trim,
    group,
    optionA,
    optionB,
    packageNode,
    color,
    baseItem,
  ]) {
    await store.putNode(node);
  }

  return {
    make,
    model,
    generation,
    phase,
    modelYear,
    powertrain,
    variant,
    trim,
    group,
    optionA,
    optionB,
    packageNode,
    color,
    baseItem,
  };
}

function rule(input: {
  id: string;
  subjectId: string;
  ruleType: 'ONE_OF' | 'AT_LEAST_ONE' | 'MAX_SELECTION';
  targetIds: string[];
  trimId: string;
  maxSelection?: number;
}) {
  return sealVehicleMasterCompatibilityRule({
    id: input.id,
    revision: 1,
    subjectId: input.subjectId,
    ruleType: input.ruleType,
    targetIds: input.targetIds,
    scope: { trimId: input.trimId },
    condition: {
      evidence: 'ok',
      ...(input.maxSelection === undefined
        ? {}
        : { maxSelection: input.maxSelection }),
    },
    effect: 'VALID',
    priority: 100,
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
}

async function promote(
  store: MemoryVehicleMasterStore,
  proposal: VehicleMasterCompatibilityRule
) {
  return promoteVehicleMasterCompatibilityRule(store, {
    proposal,
    observations: [{
      fieldPath: 'condition.evidence',
      value: 'ok',
      sourceDocumentId,
    }],
    policy: {
      requiredFieldPaths: ['condition.evidence'],
      minCorroboratingSourcesWithoutOfficial: 2,
    },
    observedAt,
  });
}

describe('vehicle master option-group rule semantics', () => {
  it('approves ONE_OF for an OPTION_GROUP with selectable same-lineage targets', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    const result = await promote(store, rule({
      id: 'rule_group_one_of_valid',
      subjectId: s.group.id,
      ruleType: 'ONE_OF',
      targetIds: [s.optionA.id, s.optionB.id],
      trimId: s.trim.id,
    }));

    expect(result.decision.status).toBe('APPROVED');
    expect(result.canonicalWrite).toBe('CREATED');
  });

  it('keeps group rule on HOLD when subject is not OPTION_GROUP', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    const result = await promote(store, rule({
      id: 'rule_group_bad_subject',
      subjectId: s.optionA.id,
      ruleType: 'ONE_OF',
      targetIds: [s.optionA.id, s.optionB.id],
      trimId: s.trim.id,
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_GROUP_SUBJECT_TYPE_MISMATCH',
        detail: 'OPTION!=OPTION_GROUP',
      }),
    ]));
  });

  it('keeps group rule on HOLD when a target is not selectable', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    const result = await promote(store, rule({
      id: 'rule_group_base_target',
      subjectId: s.group.id,
      ruleType: 'AT_LEAST_ONE',
      targetIds: [s.optionA.id, s.baseItem.id],
      trimId: s.trim.id,
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_GROUP_TARGET_TYPE_MISMATCH',
        fieldPath: `targetIds.${s.baseItem.id}`,
        detail: 'BASE_ITEM',
      }),
    ]));
  });

  it('requires at least two targets for a selection group rule', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    const result = await promote(store, rule({
      id: 'rule_group_single_target',
      subjectId: s.group.id,
      ruleType: 'ONE_OF',
      targetIds: [s.optionA.id],
      trimId: s.trim.id,
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_GROUP_TARGET_COUNT_INVALID',
        detail: '1',
      }),
    ]));
  });

  it('requires a valid MAX_SELECTION cardinality', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    const missing = await promote(store, rule({
      id: 'rule_group_max_missing',
      subjectId: s.group.id,
      ruleType: 'MAX_SELECTION',
      targetIds: [s.optionA.id, s.optionB.id],
      trimId: s.trim.id,
    }));
    expect(missing.decision.status).toBe('HOLD');
    expect(missing.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_GROUP_MAX_SELECTION_INVALID',
        detail: 'MISSING',
      }),
    ]));

    const store2 = new MemoryVehicleMasterStore();
    await seedSource(store2);
    const s2 = await seed(store2);
    const tooLarge = await promote(store2, rule({
      id: 'rule_group_max_too_large',
      subjectId: s2.group.id,
      ruleType: 'MAX_SELECTION',
      targetIds: [s2.optionA.id, s2.optionB.id],
      trimId: s2.trim.id,
      maxSelection: 3,
    }));
    expect(tooLarge.decision.status).toBe('HOLD');
    expect(tooLarge.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_GROUP_MAX_SELECTION_INVALID',
        detail: '3',
      }),
    ]));
  });

  it('blocks a duplicate semantic group rule with another ID', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(rule({
      id: 'rule_group_existing',
      subjectId: s.group.id,
      ruleType: 'ONE_OF',
      targetIds: [s.optionA.id, s.optionB.id],
      trimId: s.trim.id,
    }));

    const result = await promote(store, rule({
      id: 'rule_group_duplicate',
      subjectId: s.group.id,
      ruleType: 'ONE_OF',
      targetIds: [s.optionB.id, s.optionA.id],
      trimId: s.trim.id,
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_GROUP_DUPLICATE',
        detail: 'rule_group_existing',
      }),
    ]));
  });

  it('blocks contradictory ONE_OF and MAX_SELECTION>1 on the same target set', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(rule({
      id: 'rule_group_one_of_existing',
      subjectId: s.group.id,
      ruleType: 'ONE_OF',
      targetIds: [s.optionA.id, s.optionB.id, s.packageNode.id],
      trimId: s.trim.id,
    }));

    const result = await promote(store, rule({
      id: 'rule_group_max_conflict',
      subjectId: s.group.id,
      ruleType: 'MAX_SELECTION',
      targetIds: [s.optionA.id, s.optionB.id, s.packageNode.id],
      trimId: s.trim.id,
      maxSelection: 2,
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_GROUP_CONSTRAINT_CONFLICT',
        detail: 'rule_group_one_of_existing',
      }),
    ]));
  });

  it('allows compatible ONE_OF plus MAX_SELECTION=1 and different target subsets', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(rule({
      id: 'rule_group_one_of_compatible',
      subjectId: s.group.id,
      ruleType: 'ONE_OF',
      targetIds: [s.optionA.id, s.optionB.id],
      trimId: s.trim.id,
    }));

    const compatible = await promote(store, rule({
      id: 'rule_group_max_one',
      subjectId: s.group.id,
      ruleType: 'MAX_SELECTION',
      targetIds: [s.optionA.id, s.optionB.id],
      trimId: s.trim.id,
      maxSelection: 1,
    }));
    expect(compatible.decision.status).toBe('APPROVED');

    const differentSubset = await promote(store, rule({
      id: 'rule_group_max_subset',
      subjectId: s.group.id,
      ruleType: 'MAX_SELECTION',
      targetIds: [s.optionA.id, s.color.id],
      trimId: s.trim.id,
      maxSelection: 2,
    }));
    expect(differentSubset.decision.status).toBe('APPROVED');
  });
});
