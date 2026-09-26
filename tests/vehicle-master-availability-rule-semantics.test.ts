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

const observedAt = '2026-09-26T11:50:00.000Z';
const sourceDocumentId = 'official-availability-rule-semantics';

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
  option: VehicleMasterNode;
};

async function seedSource(store: MemoryVehicleMasterStore) {
  await store.putSourceDocument(sealVehicleMasterSourceDocument({
    sourceDocumentId,
    sourceType: 'MANUFACTURER_OFFICIAL',
    sourceName: 'official availability rule semantics',
    sourceUrl: 'https://example.test/availability-rule-semantics',
    publishedAt: observedAt,
    observedAt,
    effectiveFrom: null,
    effectiveTo: null,
    storagePath: 'vehicle-master/source-documents/test/availability-rule-semantics.html',
    sha256: 'f'.repeat(64),
    mimeType: 'text/html',
    metadata: {},
  }));
}

async function seed(store: MemoryVehicleMasterStore): Promise<Seeded> {
  const make = sealVehicleMasterNode({
    id: 'make_availability',
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
    id: 'model_availability',
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
    id: 'gen_availability',
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
    id: 'phase_availability',
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
    id: 'my_availability',
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
    id: 'pt_availability',
    nodeType: 'POWERTRAIN',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '2.5 가솔린 터보',
    parentId: modelYear.id,
    refs: {
      ...modelYear.refs,
      modelYearId: modelYear.id,
    },
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
    id: 'variant_availability',
    nodeType: 'VARIANT',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '5인승 2WD',
    parentId: powertrain.id,
    refs: {
      ...powertrain.refs,
      powertrainId: powertrain.id,
    },
    aliases: [],
    attributes: { seats: 5, drivetrain: '2WD' },
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  const trimA = sealVehicleMasterNode({
    id: 'trim_availability_a',
    nodeType: 'TRIM',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '프레스티지',
    parentId: variant.id,
    refs: {
      ...variant.refs,
      variantId: variant.id,
    },
    aliases: [],
    attributes: { identityKey: canonicalTrimIdentity('프레스티지') },
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  const trimB = sealVehicleMasterNode({
    id: 'trim_availability_b',
    nodeType: 'TRIM',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '노블레스',
    parentId: variant.id,
    refs: {
      ...variant.refs,
      variantId: variant.id,
    },
    aliases: [],
    attributes: { identityKey: canonicalTrimIdentity('노블레스') },
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  const option = sealVehicleMasterNode({
    id: 'opt_availability',
    nodeType: 'OPTION',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '드라이브 와이즈',
    parentId: modelYear.id,
    refs: {
      makeId: make.id,
      modelId: model.id,
      generationId: generation.id,
      phaseId: phase.id,
      modelYearId: modelYear.id,
    },
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
    option,
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
    option,
  };
}

function rule(input: {
  id: string;
  subjectId: string;
  trimId: string;
  ruleType: 'AVAILABLE_IF' | 'UNAVAILABLE_IF';
  condition: Record<string, unknown> | null;
  effect?: 'VALID' | 'INVALID' | 'UNKNOWN';
  targetIds?: string[];
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}) {
  return sealVehicleMasterCompatibilityRule({
    id: input.id,
    revision: 1,
    subjectId: input.subjectId,
    ruleType: input.ruleType,
    targetIds: input.targetIds ?? [],
    scope: { trimId: input.trimId },
    condition: input.condition,
    effect: input.effect ?? (input.ruleType === 'AVAILABLE_IF' ? 'VALID' : 'INVALID'),
    priority: 100,
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
      fieldPath: 'ruleType',
      value: proposal.ruleType,
      sourceDocumentId,
    }],
    policy: {
      requiredFieldPaths: ['ruleType'],
      minCorroboratingSourcesWithoutOfficial: 2,
    },
    observedAt,
  });
}

describe('vehicle master availability-rule semantics', () => {
  it('approves a well-formed AVAILABLE_IF rule', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    const result = await promote(store, rule({
      id: 'rule_available_valid',
      subjectId: s.option.id,
      trimId: s.trimA.id,
      ruleType: 'AVAILABLE_IF',
      condition: { sourceLabel: '드라이브 와이즈' },
    }));

    expect(result.decision.status).toBe('APPROVED');
    expect(result.canonicalWrite).toBe('CREATED');
  });

  it.each([
    null,
    {},
  ])('requires a non-empty condition for IF rules', async (condition) => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    const result = await promote(store, rule({
      id: `rule_condition_missing_${condition === null ? 'null' : 'empty'}`,
      subjectId: s.option.id,
      trimId: s.trimA.id,
      ruleType: 'AVAILABLE_IF',
      condition,
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_AVAILABILITY_CONDITION_REQUIRED',
        fieldPath: 'condition',
      }),
    ]));
    expect(result.canonicalWrite).toBeNull();
  });

  it('requires AVAILABLE_IF→VALID and UNAVAILABLE_IF→INVALID effects', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    const available = await promote(store, rule({
      id: 'rule_available_wrong_effect',
      subjectId: s.option.id,
      trimId: s.trimA.id,
      ruleType: 'AVAILABLE_IF',
      condition: { channel: 'retail' },
      effect: 'INVALID',
    }));
    expect(available.decision.status).toBe('HOLD');
    expect(available.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_AVAILABILITY_EFFECT_MISMATCH',
        detail: 'INVALID!=VALID',
      }),
    ]));

    const unavailable = await promote(store, rule({
      id: 'rule_unavailable_wrong_effect',
      subjectId: s.option.id,
      trimId: s.trimA.id,
      ruleType: 'UNAVAILABLE_IF',
      condition: { channel: 'fleet' },
      effect: 'VALID',
    }));
    expect(unavailable.decision.status).toBe('HOLD');
    expect(unavailable.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_AVAILABILITY_EFFECT_MISMATCH',
        detail: 'VALID!=INVALID',
      }),
    ]));
  });

  it('blocks the same availability rule under a different ID', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(rule({
      id: 'rule_available_existing',
      subjectId: s.option.id,
      trimId: s.trimA.id,
      ruleType: 'AVAILABLE_IF',
      condition: { channel: 'retail', market: 'KR' },
    }));

    const result = await promote(store, rule({
      id: 'rule_available_duplicate',
      subjectId: s.option.id,
      trimId: s.trimA.id,
      ruleType: 'AVAILABLE_IF',
      condition: { market: 'KR', channel: 'retail' },
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_AVAILABILITY_DUPLICATE',
        detail: 'rule_available_existing',
      }),
    ]));
    expect(result.canonicalWrite).toBeNull();
  });

  it('blocks AVAILABLE_IF and UNAVAILABLE_IF with identical semantics', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(rule({
      id: 'rule_available_existing',
      subjectId: s.option.id,
      trimId: s.trimA.id,
      ruleType: 'AVAILABLE_IF',
      condition: { creditBand: 'A' },
    }));

    const result = await promote(store, rule({
      id: 'rule_unavailable_conflict',
      subjectId: s.option.id,
      trimId: s.trimA.id,
      ruleType: 'UNAVAILABLE_IF',
      condition: { creditBand: 'A' },
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_AVAILABILITY_CONFLICT',
        detail: 'rule_available_existing',
      }),
    ]));
    expect(result.canonicalWrite).toBeNull();
  });

  it('allows opposite availability rule types when conditions differ', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(rule({
      id: 'rule_available_condition_a',
      subjectId: s.option.id,
      trimId: s.trimA.id,
      ruleType: 'AVAILABLE_IF',
      condition: { creditBand: 'A' },
    }));

    const result = await promote(store, rule({
      id: 'rule_unavailable_condition_b',
      subjectId: s.option.id,
      trimId: s.trimA.id,
      ruleType: 'UNAVAILABLE_IF',
      condition: { creditBand: 'B' },
    }));

    expect(result.decision.status).toBe('APPROVED');
    expect(result.canonicalWrite).toBe('CREATED');
  });

  it('allows identical conditions in different TRIM scopes', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(rule({
      id: 'rule_available_trim_a',
      subjectId: s.option.id,
      trimId: s.trimA.id,
      ruleType: 'AVAILABLE_IF',
      condition: { region: 'KR' },
    }));

    const result = await promote(store, rule({
      id: 'rule_unavailable_trim_b',
      subjectId: s.option.id,
      trimId: s.trimB.id,
      ruleType: 'UNAVAILABLE_IF',
      condition: { region: 'KR' },
    }));

    expect(result.decision.status).toBe('APPROVED');
    expect(result.canonicalWrite).toBe('CREATED');
  });

  it('allows opposite rules when their effective periods do not overlap', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(rule({
      id: 'rule_available_history',
      subjectId: s.option.id,
      trimId: s.trimA.id,
      ruleType: 'AVAILABLE_IF',
      condition: { market: 'KR' },
      effectiveFrom: '2025-01-01T00:00:00.000Z',
      effectiveTo: '2026-01-01T00:00:00.000Z',
    }));

    const result = await promote(store, rule({
      id: 'rule_unavailable_current',
      subjectId: s.option.id,
      trimId: s.trimA.id,
      ruleType: 'UNAVAILABLE_IF',
      condition: { market: 'KR' },
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
    }));

    expect(result.decision.status).toBe('APPROVED');
    expect(result.canonicalWrite).toBe('CREATED');
  });
});
