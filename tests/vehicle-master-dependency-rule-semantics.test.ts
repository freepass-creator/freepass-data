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

const observedAt = '2026-09-26T10:40:00.000Z';
const sourceDocumentId = 'official-dependency-rule-semantics';

type Seeded = {
  make: VehicleMasterNode;
  model: VehicleMasterNode;
  generation: VehicleMasterNode;
  phase: VehicleMasterNode;
  modelYear: VehicleMasterNode;
  powertrain: VehicleMasterNode;
  variant: VehicleMasterNode;
  trimA: VehicleMasterNode;
  trimB: VehicleMasterNode;
  optionA: VehicleMasterNode;
  optionB: VehicleMasterNode;
};

async function seedSource(store: MemoryVehicleMasterStore) {
  await store.putSourceDocument(sealVehicleMasterSourceDocument({
    sourceDocumentId,
    sourceType: 'MANUFACTURER_OFFICIAL',
    sourceName: 'official dependency rule semantics',
    sourceUrl: 'https://example.test/dependency-rule-semantics',
    publishedAt: observedAt,
    observedAt,
    effectiveFrom: null,
    effectiveTo: null,
    storagePath: 'vehicle-master/source-documents/test/dependency-rule-semantics.html',
    sha256: 'e'.repeat(64),
    mimeType: 'text/html',
    metadata: {},
  }));
}

async function seed(store: MemoryVehicleMasterStore): Promise<Seeded> {
  const make = sealVehicleMasterNode({
    id: 'make_dependency',
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
    id: 'model_dependency',
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
    id: 'gen_dependency',
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
    id: 'phase_dependency',
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
    id: 'my_dependency',
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
    id: 'pt_dependency',
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
    id: 'variant_dependency',
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
  const trimA = sealVehicleMasterNode({
    id: 'trim_dependency_a',
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
  const trimB = sealVehicleMasterNode({
    id: 'trim_dependency_b',
    nodeType: 'TRIM',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '노블레스',
    parentId: variant.id,
    refs: { ...variant.refs, variantId: variant.id },
    aliases: [],
    attributes: { identityKey: canonicalTrimIdentity('노블레스') },
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });

  const optionRefs = {
    makeId: make.id,
    modelId: model.id,
    generationId: generation.id,
    phaseId: phase.id,
    modelYearId: modelYear.id,
  };
  const optionA = sealVehicleMasterNode({
    id: 'opt_dependency_a',
    nodeType: 'OPTION',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '옵션 A',
    parentId: modelYear.id,
    refs: optionRefs,
    aliases: [],
    attributes: {},
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  const optionB = sealVehicleMasterNode({
    id: 'opt_dependency_b',
    nodeType: 'OPTION',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '옵션 B',
    parentId: modelYear.id,
    refs: optionRefs,
    aliases: [],
    attributes: {},
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });

  for (const node of [
    make,
    model,
    generation,
    phase,
    modelYear,
    powertrain,
    variant,
    trimA,
    trimB,
    optionA,
    optionB,
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
    trimA,
    trimB,
    optionA,
    optionB,
  };
}

function rule(input: {
  id: string;
  subjectId: string;
  targetId?: string;
  targetIds?: string[];
  trimId: string;
  ruleType: 'REQUIRES' | 'EXCLUDES';
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}) {
  return sealVehicleMasterCompatibilityRule({
    id: input.id,
    revision: 1,
    subjectId: input.subjectId,
    ruleType: input.ruleType,
    targetIds: input.targetIds ?? [input.targetId!],
    scope: { trimId: input.trimId },
    condition: { evidence: 'ok' },
    effect: input.ruleType === 'EXCLUDES' ? 'INVALID' : 'VALID',
    priority: 200,
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: input.effectiveFrom ?? null,
    effectiveTo: input.effectiveTo ?? null,
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

describe('vehicle master direct dependency-rule semantics', () => {
  it('keeps same-direction duplicate REQUIRES rule on HOLD', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(rule({
      id: 'rule_requires_existing',
      subjectId: s.optionA.id,
      targetId: s.optionB.id,
      trimId: s.trimA.id,
      ruleType: 'REQUIRES',
    }));

    const result = await promote(store, rule({
      id: 'rule_requires_duplicate',
      subjectId: s.optionA.id,
      targetId: s.optionB.id,
      trimId: s.trimA.id,
      ruleType: 'REQUIRES',
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_DEPENDENCY_DUPLICATE',
        detail: 'rule_requires_existing',
      }),
    ]));
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps direct REQUIRES versus EXCLUDES contradiction on HOLD', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(rule({
      id: 'rule_requires_existing',
      subjectId: s.optionA.id,
      targetId: s.optionB.id,
      trimId: s.trimA.id,
      ruleType: 'REQUIRES',
    }));

    const result = await promote(store, rule({
      id: 'rule_excludes_conflict',
      subjectId: s.optionA.id,
      targetId: s.optionB.id,
      trimId: s.trimA.id,
      ruleType: 'EXCLUDES',
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_DEPENDENCY_CONFLICT',
        fieldPath: `targetIds.${s.optionB.id}`,
        detail: 'rule_requires_existing',
      }),
    ]));
    expect(result.canonicalWrite).toBeNull();
  });

  it('catches a contradiction on any shared target in a multi-target dependency', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(rule({
      id: 'rule_multi_requires_existing',
      subjectId: s.optionA.id,
      targetIds: [s.optionB.id, s.trimA.id],
      trimId: s.trimA.id,
      ruleType: 'REQUIRES',
    }));

    const result = await promote(store, rule({
      id: 'rule_partial_excludes_conflict',
      subjectId: s.optionA.id,
      targetId: s.optionB.id,
      trimId: s.trimA.id,
      ruleType: 'EXCLUDES',
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_DEPENDENCY_CONFLICT',
        fieldPath: `targetIds.${s.optionB.id}`,
        detail: 'rule_multi_requires_existing',
      }),
    ]));
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps reverse-direction REQUIRES versus EXCLUDES contradiction on HOLD', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(rule({
      id: 'rule_reverse_excludes_existing',
      subjectId: s.optionB.id,
      targetId: s.optionA.id,
      trimId: s.trimA.id,
      ruleType: 'EXCLUDES',
    }));

    const result = await promote(store, rule({
      id: 'rule_forward_requires_conflict',
      subjectId: s.optionA.id,
      targetId: s.optionB.id,
      trimId: s.trimA.id,
      ruleType: 'REQUIRES',
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_DEPENDENCY_CONFLICT',
        fieldPath: `targetIds.${s.optionB.id}`,
        detail: 'rule_reverse_excludes_existing',
      }),
    ]));
    expect(result.canonicalWrite).toBeNull();
  });

  it('allows opposite dependency types in a different TRIM scope', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(rule({
      id: 'rule_scope_a_requires',
      subjectId: s.optionA.id,
      targetId: s.optionB.id,
      trimId: s.trimA.id,
      ruleType: 'REQUIRES',
    }));

    const result = await promote(store, rule({
      id: 'rule_scope_b_excludes',
      subjectId: s.optionA.id,
      targetId: s.optionB.id,
      trimId: s.trimB.id,
      ruleType: 'EXCLUDES',
    }));

    expect(result.decision.status).toBe('APPROVED');
    expect(result.canonicalWrite).toBe('CREATED');
  });

  it('allows contradictory-looking rules when their effective periods do not overlap', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(rule({
      id: 'rule_historical_requires',
      subjectId: s.optionA.id,
      targetId: s.optionB.id,
      trimId: s.trimA.id,
      ruleType: 'REQUIRES',
      effectiveFrom: '2025-01-01T00:00:00.000Z',
      effectiveTo: '2026-01-01T00:00:00.000Z',
    }));

    const result = await promote(store, rule({
      id: 'rule_current_excludes',
      subjectId: s.optionA.id,
      targetId: s.optionB.id,
      trimId: s.trimA.id,
      ruleType: 'EXCLUDES',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
    }));

    expect(result.decision.status).toBe('APPROVED');
    expect(result.canonicalWrite).toBe('CREATED');
  });

  it('does not treat reciprocal REQUIRES rules as a direct contradiction', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(rule({
      id: 'rule_a_requires_b',
      subjectId: s.optionA.id,
      targetId: s.optionB.id,
      trimId: s.trimA.id,
      ruleType: 'REQUIRES',
    }));

    const result = await promote(store, rule({
      id: 'rule_b_requires_a',
      subjectId: s.optionB.id,
      targetId: s.optionA.id,
      trimId: s.trimA.id,
      ruleType: 'REQUIRES',
    }));

    expect(result.decision.status).toBe('APPROVED');
    expect(result.canonicalWrite).toBe('CREATED');
  });
});
