import { describe, expect, it } from 'vitest';
import {
  sealVehicleMasterCompatibilityRule,
  sealVehicleMasterNode,
  sealVehicleMasterPriceRevision,
  type VehicleMasterNode,
} from '../src/domain/vehicle-master.js';
import {
  auditVehicleMasterGraph,
  auditVehicleMasterStore,
} from '../src/application/vehicle-master-graph-audit.js';
import { MemoryVehicleMasterStore } from '../src/infra/vehicle-master-memory-store.js';
import {
  canonicalPowertrainIdentity,
  canonicalTrimIdentity,
} from '../src/domain/vehicle-master-normalization.js';

const at = '2026-09-26T12:30:00.000Z';

function cleanNodes() {
  const make = sealVehicleMasterNode({
    id: 'make_audit',
    nodeType: 'MAKE',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '기아',
    parentId: null,
    refs: {},
    aliases: ['Kia'],
    attributes: {},
    sourceEvidenceIds: ['official'],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const model = sealVehicleMasterNode({
    id: 'model_audit',
    nodeType: 'MODEL',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '쏘렌토',
    parentId: make.id,
    refs: { makeId: make.id },
    aliases: [],
    attributes: {},
    sourceEvidenceIds: ['official'],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const generation = sealVehicleMasterNode({
    id: 'gen_audit',
    nodeType: 'GENERATION',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: 'MQ4',
    parentId: model.id,
    refs: { makeId: make.id, modelId: model.id },
    aliases: [],
    attributes: {},
    sourceEvidenceIds: ['official'],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const phase = sealVehicleMasterNode({
    id: 'phase_audit',
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
    sourceEvidenceIds: ['official'],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const modelYear = sealVehicleMasterNode({
    id: 'my_audit',
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
    sourceEvidenceIds: ['official'],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const powertrain = sealVehicleMasterNode({
    id: 'pt_audit',
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
    sourceEvidenceIds: ['official'],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const variant = sealVehicleMasterNode({
    id: 'variant_audit',
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
    sourceEvidenceIds: ['official'],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const trim = sealVehicleMasterNode({
    id: 'trim_audit',
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
    sourceEvidenceIds: ['official'],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const base = sealVehicleMasterNode({
    id: 'base_audit',
    nodeType: 'BASE_ITEM',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: 'LED 헤드램프',
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
    sourceEvidenceIds: ['official'],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
  const option = sealVehicleMasterNode({
    id: 'opt_audit',
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
    sourceEvidenceIds: ['official'],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });

  return {
    list: [
      make,
      model,
      generation,
      phase,
      modelYear,
      powertrain,
      variant,
      trim,
      base,
      option,
    ],
    make,
    model,
    generation,
    phase,
    modelYear,
    powertrain,
    variant,
    trim,
    base,
    option,
  };
}

function cleanRule(
  trim: VehicleMasterNode,
  base: VehicleMasterNode
) {
  return sealVehicleMasterCompatibilityRule({
    id: 'rule_audit_includes',
    revision: 1,
    subjectId: trim.id,
    ruleType: 'INCLUDES',
    targetIds: [base.id],
    scope: { trimId: trim.id },
    condition: { sourceLabel: base.canonicalName },
    effect: 'VALID',
    priority: 50,
    sourceEvidenceIds: ['official'],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
}

function cleanPrice(trim: VehicleMasterNode) {
  return sealVehicleMasterPriceRevision({
    id: 'price_audit_base',
    targetId: trim.id,
    priceType: 'BASE',
    amount: 42000000,
    currency: 'KRW',
    revision: 1,
    sourceEvidenceIds: ['official'],
    sourceDocumentIds: ['official'],
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveTo: null,
    createdAt: at,
    updatedAt: at,
  });
}

describe('vehicle master graph audit', () => {
  it('returns PASS for a coherent canonical graph', () => {
    const n = cleanNodes();
    const report = auditVehicleMasterGraph({
      nodes: n.list,
      rules: [cleanRule(n.trim, n.base)],
      prices: [cleanPrice(n.trim)],
    });

    expect(report.status).toBe('PASS');
    expect(report.counts).toEqual({
      nodes: n.list.length,
      rules: 1,
      prices: 1,
      errors: 0,
      warnings: 0,
    });
    expect(report.issues).toEqual([]);
    expect(report.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('finds legacy structural, rule, duplicate, and price corruption', () => {
    const n = cleanNodes();

    const brokenModel = sealVehicleMasterNode({
      id: 'model_broken',
      nodeType: 'MODEL',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '스포티지',
      parentId: null,
      refs: { makeId: n.make.id },
      aliases: [],
      attributes: {},
      sourceEvidenceIds: ['legacy'],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: at,
      updatedAt: at,
    });

    const duplicateOption = sealVehicleMasterNode({
      id: 'opt_audit_duplicate',
      nodeType: 'OPTION',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '드라이브-와이즈',
      parentId: n.modelYear.id,
      refs: {
        makeId: n.make.id,
        modelId: n.model.id,
        generationId: n.generation.id,
        phaseId: n.phase.id,
        modelYearId: n.modelYear.id,
      },
      aliases: [],
      attributes: {},
      sourceEvidenceIds: ['legacy'],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: at,
      updatedAt: at,
    });

    const badRule = sealVehicleMasterCompatibilityRule({
      id: 'rule_bad_include',
      revision: 1,
      subjectId: n.option.id,
      ruleType: 'INCLUDES',
      targetIds: [n.option.id === n.base.id ? n.base.id : n.option.id],
      scope: { trimId: n.trim.id },
      condition: { evidence: 'legacy' },
      effect: 'INVALID',
      priority: 50,
      sourceEvidenceIds: ['legacy'],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: at,
      updatedAt: at,
    });

    const orphanPrice = sealVehicleMasterPriceRevision({
      id: 'price_orphan',
      targetId: 'trim_missing',
      priceType: 'BASE',
      amount: 1,
      currency: 'KRW',
      revision: 1,
      sourceEvidenceIds: ['legacy'],
      sourceDocumentIds: ['legacy'],
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
      createdAt: at,
      updatedAt: at,
    });

    const wrongTargetPrice = sealVehicleMasterPriceRevision({
      id: 'price_base_on_option',
      targetId: n.option.id,
      priceType: 'BASE',
      amount: 1,
      currency: 'KRW',
      revision: 1,
      sourceEvidenceIds: ['legacy'],
      sourceDocumentIds: ['legacy'],
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      effectiveTo: null,
      createdAt: at,
      updatedAt: at,
    });

    const report = auditVehicleMasterGraph({
      nodes: [...n.list, brokenModel, duplicateOption],
      rules: [badRule],
      prices: [orphanPrice, wrongTargetPrice],
    });

    expect(report.status).toBe('FAIL');
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'PARENT_ID_REQUIRED',
        entityKind: 'NODE',
        entityId: brokenModel.id,
      }),
      expect.objectContaining({
        code: 'SUPPLEMENTAL_DUPLICATE_IN_MODEL_YEAR',
        entityKind: 'NODE',
        entityId: duplicateOption.id,
        relatedId: n.option.id,
      }),
      expect.objectContaining({
        code: 'RULE_INCLUDES_SUBJECT_TYPE_MISMATCH',
        entityKind: 'RULE',
        entityId: badRule.id,
      }),
      expect.objectContaining({
        code: 'RULE_INCLUDES_TARGET_TYPE_MISMATCH',
        entityKind: 'RULE',
        entityId: badRule.id,
      }),
      expect.objectContaining({
        code: 'RULE_INCLUDES_EFFECT_MISMATCH',
        entityKind: 'RULE',
        entityId: badRule.id,
      }),
      expect.objectContaining({
        code: 'PRICE_TARGET_MISSING',
        entityKind: 'PRICE',
        entityId: orphanPrice.id,
      }),
      expect.objectContaining({
        code: 'PRICE_TARGET_TYPE_MISMATCH',
        entityKind: 'PRICE',
        entityId: wrongTargetPrice.id,
      }),
    ]));
  });

  it('is deterministic regardless of input order', () => {
    const n = cleanNodes();
    const rule = cleanRule(n.trim, n.base);
    const price = cleanPrice(n.trim);

    const a = auditVehicleMasterGraph({
      nodes: n.list,
      rules: [rule],
      prices: [price],
    });
    const b = auditVehicleMasterGraph({
      nodes: [...n.list].reverse(),
      rules: [rule],
      prices: [price],
    });

    expect(b).toEqual(a);
  });

  it('audits a store snapshot without mutating canonical records', async () => {
    const n = cleanNodes();
    const store = new MemoryVehicleMasterStore();
    for (const node of n.list) await store.putNode(node);
    await store.putCompatibilityRule(cleanRule(n.trim, n.base));
    await store.putPriceRevision(cleanPrice(n.trim));

    const beforeNode = await store.getNode(n.trim.id);
    const beforeRule = await store.getCompatibilityRule('rule_audit_includes');
    const beforePrice = await store.getPriceRevision('price_audit_base');

    const report = await auditVehicleMasterStore(store);

    expect(report.status).toBe('PASS');
    expect(await store.getNode(n.trim.id)).toEqual(beforeNode);
    expect(await store.getCompatibilityRule('rule_audit_includes')).toEqual(beforeRule);
    expect(await store.getPriceRevision('price_audit_base')).toEqual(beforePrice);
  });
});
