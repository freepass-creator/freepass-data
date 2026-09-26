import { describe, expect, it } from 'vitest';
import {
  sealVehicleMasterCompatibilityRule,
  sealVehicleMasterNode,
  sealVehicleMasterSourceDocument,
  type VehicleMasterNode,
} from '../src/domain/vehicle-master.js';
import {
  promoteVehicleMasterCompatibilityRule,
} from '../src/application/vehicle-master-ingestion.js';
import { MemoryVehicleMasterStore } from '../src/infra/vehicle-master-memory-store.js';
import { canonicalTrimIdentity } from '../src/domain/vehicle-master-normalization.js';

const observedAt = '2026-09-26T09:30:00.000Z';
const sourceDocumentId = 'official-rule-lineage';

type Seeded = {
  make: VehicleMasterNode;
  model: VehicleMasterNode;
  generation: VehicleMasterNode;
  phase: VehicleMasterNode;
  modelYear: VehicleMasterNode;
  powertrain: VehicleMasterNode;
  variant: VehicleMasterNode;
  trim: VehicleMasterNode;
};

async function seedSource(store: MemoryVehicleMasterStore) {
  await store.putSourceDocument(sealVehicleMasterSourceDocument({
    sourceDocumentId,
    sourceType: 'MANUFACTURER_OFFICIAL',
    sourceName: 'official rule lineage fixture',
    sourceUrl: 'https://example.test/rule-lineage',
    publishedAt: observedAt,
    observedAt,
    effectiveFrom: null,
    effectiveTo: null,
    storagePath: 'vehicle-master/source-documents/test/rule-lineage.html',
    sha256: 'a'.repeat(64),
    mimeType: 'text/html',
    metadata: {},
  }));
}

async function seedLineage(
  store: MemoryVehicleMasterStore,
  prefix: string,
  modelYearValue = 2027
): Promise<Seeded> {
  const make = sealVehicleMasterNode({
    id: `make_${prefix}`,
    nodeType: 'MAKE',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: `제조사 ${prefix}`,
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
    id: `model_${prefix}`,
    nodeType: 'MODEL',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: `모델 ${prefix}`,
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
    id: `gen_${prefix}`,
    nodeType: 'GENERATION',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: `세대 ${prefix}`,
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
    id: `phase_${prefix}`,
    nodeType: 'PHASE',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: `페이즈 ${prefix}`,
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
    id: `my_${prefix}`,
    nodeType: 'MODEL_YEAR',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: `${modelYearValue}년형`,
    parentId: phase.id,
    refs: {
      makeId: make.id,
      modelId: model.id,
      generationId: generation.id,
      phaseId: phase.id,
    },
    aliases: [`${modelYearValue}MY`],
    attributes: { modelYear: modelYearValue },
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  const powertrain = sealVehicleMasterNode({
    id: `pt_${prefix}`,
    nodeType: 'POWERTRAIN',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '2.5 가솔린',
    parentId: modelYear.id,
    refs: {
      ...modelYear.refs,
      modelYearId: modelYear.id,
    },
    aliases: [],
    attributes: { identityKey: '2.5|가솔린', fuelType: 'GASOLINE' },
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  const variant = sealVehicleMasterNode({
    id: `variant_${prefix}`,
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
    id: `trim_${prefix}`,
    nodeType: 'TRIM',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: `트림 ${prefix}`,
    parentId: variant.id,
    refs: {
      ...variant.refs,
      variantId: variant.id,
    },
    aliases: [],
    attributes: { identityKey: canonicalTrimIdentity(`트림 ${prefix}`) },
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });

  for (const node of [make, model, generation, phase, modelYear, powertrain, variant, trim]) {
    await store.putNode(node);
  }
  return { make, model, generation, phase, modelYear, powertrain, variant, trim };
}

function optionNode(id: string, lineage: Seeded, name: string) {
  return sealVehicleMasterNode({
    id,
    nodeType: 'OPTION',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: name,
    parentId: lineage.modelYear.id,
    refs: {
      makeId: lineage.make.id,
      modelId: lineage.model.id,
      generationId: lineage.generation.id,
      phaseId: lineage.phase.id,
      modelYearId: lineage.modelYear.id,
    },
    aliases: [],
    attributes: {},
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
}

function rule(input: {
  id: string;
  subjectId: string;
  targetIds: string[];
  scopeTrimId: string;
  ruleType?: 'REQUIRES' | 'EXCLUDES' | 'AVAILABLE_IF' | 'INCLUDES';
}) {
  return sealVehicleMasterCompatibilityRule({
    id: input.id,
    revision: 1,
    subjectId: input.subjectId,
    ruleType: input.ruleType ?? 'REQUIRES',
    targetIds: input.targetIds,
    scope: { trimId: input.scopeTrimId },
    condition: { ruleEvidence: 'ok' },
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
  proposal: ReturnType<typeof rule>
) {
  return promoteVehicleMasterCompatibilityRule(store, {
    proposal,
    observations: [{
      fieldPath: 'condition.ruleEvidence',
      value: 'ok',
      sourceDocumentId,
    }],
    policy: {
      requiredFieldPaths: ['condition.ruleEvidence'],
      minCorroboratingSourcesWithoutOfficial: 2,
    },
    observedAt,
  });
}

describe('vehicle master compatibility-rule lineage', () => {
  it('approves a rule when subject target and scope share one canonical lineage', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const a = await seedLineage(store, 'a');
    const subject = optionNode('opt_a_subject', a, '옵션 A');
    const target = optionNode('opt_a_target', a, '옵션 B');
    await store.putNode(subject);
    await store.putNode(target);

    const result = await promote(store, rule({
      id: 'rule_same_lineage',
      subjectId: subject.id,
      targetIds: [target.id],
      scopeTrimId: a.trim.id,
    }));

    expect(result.decision.status).toBe('APPROVED');
    expect(result.canonicalWrite).toBe('CREATED');
  });

  it('keeps a cross-lineage target rule on HOLD', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const a = await seedLineage(store, 'a');
    const b = await seedLineage(store, 'b', 2026);
    const subject = optionNode('opt_a_subject', a, '옵션 A');
    const target = optionNode('opt_b_target', b, '옵션 B');
    await store.putNode(subject);
    await store.putNode(target);

    const result = await promote(store, rule({
      id: 'rule_cross_target',
      subjectId: subject.id,
      targetIds: [target.id],
      scopeTrimId: a.trim.id,
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_LINEAGE_MISMATCH',
        fieldPath: expect.stringContaining('targetIds.opt_b_target'),
      }),
    ]));
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps a rule on HOLD when scope TRIM belongs to another lineage', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const a = await seedLineage(store, 'a');
    const b = await seedLineage(store, 'b', 2026);
    const subject = optionNode('opt_scope_subject', a, '옵션 A');
    const target = optionNode('opt_scope_target', a, '옵션 B');
    await store.putNode(subject);
    await store.putNode(target);

    const result = await promote(store, rule({
      id: 'rule_cross_scope',
      subjectId: subject.id,
      targetIds: [target.id],
      scopeTrimId: b.trim.id,
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_LINEAGE_MISMATCH',
        fieldPath: expect.stringContaining('scope.trimId'),
      }),
    ]));
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps TRIM-subject rule on HOLD when scope.trimId is a different TRIM', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const a = await seedLineage(store, 'a');
    const otherTrim = sealVehicleMasterNode({
      ...a.trim,
      id: 'trim_a_other',
      canonicalName: '다른 트림',
      attributes: { identityKey: canonicalTrimIdentity('다른 트림') },
      contentHash: undefined as never,
    });
    const sealedOtherTrim = sealVehicleMasterNode({
      id: otherTrim.id,
      nodeType: otherTrim.nodeType,
      status: otherTrim.status,
      revision: otherTrim.revision,
      canonicalName: otherTrim.canonicalName,
      parentId: otherTrim.parentId ?? null,
      refs: otherTrim.refs,
      aliases: otherTrim.aliases,
      attributes: otherTrim.attributes,
      sourceEvidenceIds: otherTrim.sourceEvidenceIds,
      effectiveFrom: otherTrim.effectiveFrom ?? null,
      effectiveTo: otherTrim.effectiveTo ?? null,
      createdAt: otherTrim.createdAt,
      updatedAt: otherTrim.updatedAt,
    });
    await store.putNode(sealedOtherTrim);

    const target = sealVehicleMasterNode({
      id: 'base_a_target',
      nodeType: 'BASE_ITEM',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '기본품목',
      parentId: a.modelYear.id,
      refs: {
        makeId: a.make.id,
        modelId: a.model.id,
        generationId: a.generation.id,
        phaseId: a.phase.id,
        modelYearId: a.modelYear.id,
      },
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    await store.putNode(target);

    const result = await promote(store, rule({
      id: 'rule_wrong_trim_scope',
      subjectId: a.trim.id,
      targetIds: [target.id],
      scopeTrimId: sealedOtherTrim.id,
      ruleType: 'INCLUDES',
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_SCOPE_SUBJECT_MISMATCH',
        fieldPath: 'scope.trimId',
      }),
    ]));
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps a rule on HOLD when a referenced node has incomplete lineage', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const a = await seedLineage(store, 'a');
    const subject = optionNode('opt_incomplete_subject', a, '옵션 A');
    const target = sealVehicleMasterNode({
      id: 'opt_incomplete_target',
      nodeType: 'OPTION',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '옵션 B',
      parentId: a.modelYear.id,
      refs: {
        makeId: a.make.id,
        modelId: a.model.id,
        generationId: null,
        phaseId: a.phase.id,
        modelYearId: a.modelYear.id,
      },
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    await store.putNode(subject);
    await store.putNode(target);

    const result = await promote(store, rule({
      id: 'rule_incomplete_target',
      subjectId: subject.id,
      targetIds: [target.id],
      scopeTrimId: a.trim.id,
    }));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'RULE_LINEAGE_INCOMPLETE',
        fieldPath: 'targetIds.opt_incomplete_target.generationId',
        detail: target.id,
      }),
    ]));
    expect(result.canonicalWrite).toBeNull();
  });
});
