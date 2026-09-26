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

const observedAt = '2026-09-26T12:05:00.000Z';
const sourceDocumentId = 'official-includes-price-override';

type Seeded = {
  make: VehicleMasterNode;
  model: VehicleMasterNode;
  generation: VehicleMasterNode;
  phase: VehicleMasterNode;
  modelYear: VehicleMasterNode;
  powertrain: VehicleMasterNode;
  variant: VehicleMasterNode;
  trim: VehicleMasterNode;
  baseA: VehicleMasterNode;
  baseB: VehicleMasterNode;
  option: VehicleMasterNode;
};

async function seedSource(store: MemoryVehicleMasterStore) {
  await store.putSourceDocument(sealVehicleMasterSourceDocument({
    sourceDocumentId,
    sourceType: 'MANUFACTURER_OFFICIAL',
    sourceName: 'official includes semantics',
    sourceUrl: 'https://example.test/includes-price-override',
    publishedAt: observedAt,
    observedAt,
    effectiveFrom: null,
    effectiveTo: null,
    storagePath: 'vehicle-master/source-documents/test/includes-price-override.html',
    sha256: '1'.repeat(64),
    mimeType: 'text/html',
    metadata: {},
  }));
}

async function seed(store: MemoryVehicleMasterStore): Promise<Seeded> {
  const make = sealVehicleMasterNode({
    id: 'make_includes',
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
    id: 'model_includes',
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
    id: 'gen_includes',
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
    id: 'phase_includes',
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
    id: 'my_includes',
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
    id: 'pt_includes',
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
    id: 'variant_includes',
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

  const trim = sealVehicleMasterNode({
    id: 'trim_includes',
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

  const refs = {
    makeId: make.id,
    modelId: model.id,
    generationId: generation.id,
    phaseId: phase.id,
    modelYearId: modelYear.id,
  };

  const baseA = sealVehicleMasterNode({
    id: 'base_includes_a',
    nodeType: 'BASE_ITEM',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: 'LED 헤드램프',
    parentId: modelYear.id,
    refs,
    aliases: [],
    attributes: { category: '외장' },
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });

  const baseB = sealVehicleMasterNode({
    id: 'base_includes_b',
    nodeType: 'BASE_ITEM',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '스마트 크루즈',
    parentId: modelYear.id,
    refs,
    aliases: [],
    attributes: { category: 'ADAS' },
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });

  const option = sealVehicleMasterNode({
    id: 'opt_includes',
    nodeType: 'OPTION',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '드라이브 와이즈',
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

  for (const node of [
    make,
    model,
    generation,
    phase,
    modelYear,
    powertrain,
    variant,
    trim,
    baseA,
    baseB,
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
    trim,
    baseA,
    baseB,
    option,
  };
}

function includesRule(input: {
  id: string;
  subjectId: string;
  targetIds: string[];
  trimId: string;
  effect?: 'VALID' | 'INVALID' | 'UNKNOWN';
  ruleType?: 'INCLUDES' | 'EXCLUDES' | 'PRICE_OVERRIDE';
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}) {
  return sealVehicleMasterCompatibilityRule({
    id: input.id,
    revision: 1,
    subjectId: input.subjectId,
    ruleType: input.ruleType ?? 'INCLUDES',
    targetIds: input.targetIds,
    scope: { trimId: input.trimId },
    condition: { evidence: 'ok' },
    effect:
      input.effect ??
      (input.ruleType === 'EXCLUDES' ? 'INVALID' : 'VALID'),
    priority: 50,
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

describe('vehicle master INCLUDES and PRICE_OVERRIDE semantics', () => {
  it('approves TRIM→BASE_ITEM INCLUDES', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    const result = await promote(store, includesRule({
      id: 'rule_includes_valid',
      subjectId: s.trim.id,
      targetIds: [s.baseA.id],
      trimId: s.trim.id,
    }));

    expect(result.decision.status).toBe('APPROVED');
    expect(result.canonicalWrite).toBe('CREATED');
  });

  it('requires TRIM as INCLUDES subject', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    const result = await promote(store, includesRule({
      id: 'rule_includes_bad_subject',
      subjectId: s.option.id,
      targetIds: [s.baseA.id],
      trimId: s.trim.id,
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_INCLUDES_SUBJECT_TYPE_MISMATCH',
        detail: 'OPTION!=TRIM',
      }),
    ]));
  });

  it('requires BASE_ITEM targets for INCLUDES', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    const result = await promote(store, includesRule({
      id: 'rule_includes_bad_target',
      subjectId: s.trim.id,
      targetIds: [s.option.id],
      trimId: s.trim.id,
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_INCLUDES_TARGET_TYPE_MISMATCH',
        fieldPath: `targetIds.${s.option.id}`,
        detail: 'OPTION!=BASE_ITEM',
      }),
    ]));
  });

  it('requires VALID effect for INCLUDES', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    const result = await promote(store, includesRule({
      id: 'rule_includes_bad_effect',
      subjectId: s.trim.id,
      targetIds: [s.baseA.id],
      trimId: s.trim.id,
      effect: 'INVALID',
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_INCLUDES_EFFECT_MISMATCH',
        detail: 'INVALID!=VALID',
      }),
    ]));
  });

  it('blocks semantic duplicate INCLUDES under another ID', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(includesRule({
      id: 'rule_includes_existing',
      subjectId: s.trim.id,
      targetIds: [s.baseA.id, s.baseB.id],
      trimId: s.trim.id,
    }));

    const result = await promote(store, includesRule({
      id: 'rule_includes_duplicate',
      subjectId: s.trim.id,
      targetIds: [s.baseB.id, s.baseA.id],
      trimId: s.trim.id,
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_INCLUDES_DUPLICATE',
        detail: 'rule_includes_existing',
      }),
    ]));
  });

  it('blocks new INCLUDES when an overlapping EXCLUDES exists for any target', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(includesRule({
      id: 'rule_excludes_existing',
      subjectId: s.trim.id,
      targetIds: [s.baseA.id],
      trimId: s.trim.id,
      ruleType: 'EXCLUDES',
    }));

    const result = await promote(store, includesRule({
      id: 'rule_includes_conflict',
      subjectId: s.trim.id,
      targetIds: [s.baseA.id, s.baseB.id],
      trimId: s.trim.id,
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_INCLUDES_CONFLICT',
        fieldPath: `targetIds.${s.baseA.id}`,
        detail: 'rule_excludes_existing',
      }),
    ]));
  });

  it('blocks new EXCLUDES when an overlapping INCLUDES exists', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(includesRule({
      id: 'rule_includes_existing',
      subjectId: s.trim.id,
      targetIds: [s.baseA.id],
      trimId: s.trim.id,
    }));

    const result = await promote(store, includesRule({
      id: 'rule_excludes_new',
      subjectId: s.trim.id,
      targetIds: [s.baseA.id],
      trimId: s.trim.id,
      ruleType: 'EXCLUDES',
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_INCLUDES_CONFLICT',
        fieldPath: `targetIds.${s.baseA.id}`,
        detail: 'rule_includes_existing',
      }),
    ]));
  });

  it('allows INCLUDES and EXCLUDES history when periods do not overlap', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    await store.putCompatibilityRule(includesRule({
      id: 'rule_includes_history',
      subjectId: s.trim.id,
      targetIds: [s.baseA.id],
      trimId: s.trim.id,
      effectiveFrom: '2025-01-01T00:00:00.000Z',
      effectiveTo: '2026-01-01T00:00:00.000Z',
    }));

    const result = await promote(store, includesRule({
      id: 'rule_excludes_current',
      subjectId: s.trim.id,
      targetIds: [s.baseA.id],
      trimId: s.trim.id,
      ruleType: 'EXCLUDES',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
    }));

    expect(result.decision.status).toBe('APPROVED');
    expect(result.canonicalWrite).toBe('CREATED');
  });

  it('fails PRICE_OVERRIDE closed until its Canonical contract is defined', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const s = await seed(store);

    const result = await promote(store, includesRule({
      id: 'rule_price_override_undefined',
      subjectId: s.trim.id,
      targetIds: [s.baseA.id],
      trimId: s.trim.id,
      ruleType: 'PRICE_OVERRIDE',
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_PRICE_OVERRIDE_UNDEFINED',
        fieldPath: 'ruleType',
      }),
    ]));
    expect(result.canonicalWrite).toBeNull();
  });
});
