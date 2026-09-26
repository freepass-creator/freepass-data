import { describe, expect, it } from 'vitest';
import {
  sealVehicleMasterNode,
  sealVehicleMasterSourceDocument,
  type VehicleMasterNode,
} from '../src/domain/vehicle-master.js';
import {
  promoteVehicleMasterNode,
} from '../src/application/vehicle-master-ingestion.js';
import { MemoryVehicleMasterStore } from '../src/infra/vehicle-master-memory-store.js';

const observedAt = '2026-09-26T10:00:00.000Z';
const sourceDocumentId = 'official-supplemental-identity';

type Lineage = {
  make: VehicleMasterNode;
  model: VehicleMasterNode;
  generation: VehicleMasterNode;
  phase: VehicleMasterNode;
  modelYear: VehicleMasterNode;
};

async function seedSource(store: MemoryVehicleMasterStore) {
  await store.putSourceDocument(sealVehicleMasterSourceDocument({
    sourceDocumentId,
    sourceType: 'MANUFACTURER_OFFICIAL',
    sourceName: 'official supplemental identity fixture',
    sourceUrl: 'https://example.test/supplemental-identity',
    publishedAt: observedAt,
    observedAt,
    effectiveFrom: null,
    effectiveTo: null,
    storagePath: 'vehicle-master/source-documents/test/supplemental-identity.html',
    sha256: 'c'.repeat(64),
    mimeType: 'text/html',
    metadata: {},
  }));
}

async function seedLineage(
  store: MemoryVehicleMasterStore,
  suffix: string,
  modelYearValue: number
): Promise<Lineage> {
  const make = sealVehicleMasterNode({
    id: `make_${suffix}`,
    nodeType: 'MAKE',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: `제조사 ${suffix}`,
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
    id: `model_${suffix}`,
    nodeType: 'MODEL',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: `모델 ${suffix}`,
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
    id: `gen_${suffix}`,
    nodeType: 'GENERATION',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: `세대 ${suffix}`,
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
    id: `phase_${suffix}`,
    nodeType: 'PHASE',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: `페이즈 ${suffix}`,
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
    id: `my_${suffix}_${modelYearValue}`,
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

  for (const node of [make, model, generation, phase, modelYear]) {
    await store.putNode(node);
  }

  return { make, model, generation, phase, modelYear };
}

function supplemental(
  id: string,
  nodeType: 'BASE_ITEM' | 'OPTION' | 'PACKAGE' | 'OPTION_GROUP' | 'COLOR',
  name: string,
  lineage: Lineage,
  aliases: string[] = []
) {
  return sealVehicleMasterNode({
    id,
    nodeType,
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
    aliases,
    attributes: {},
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
}

async function promote(store: MemoryVehicleMasterStore, proposal: VehicleMasterNode) {
  return promoteVehicleMasterNode(store, {
    proposal,
    observations: [{
      fieldPath: 'canonicalName',
      value: proposal.canonicalName,
      sourceDocumentId,
    }],
    policy: {
      requiredFieldPaths: ['canonicalName'],
      minCorroboratingSourcesWithoutOfficial: 2,
    },
    observedAt,
  });
}

describe('vehicle master supplemental identity', () => {
  it('keeps the same OPTION identity on HOLD within one MODEL_YEAR', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const lineage = await seedLineage(store, 'a', 2027);

    await store.putNode(supplemental(
      'opt_cluster_existing',
      'OPTION',
      '12.3인치 클러스터',
      lineage
    ));

    const result = await promote(store, supplemental(
      'opt_cluster_duplicate',
      'OPTION',
      '12.3 인치-클러스터',
      lineage
    ));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'SUPPLEMENTAL_DUPLICATE_IN_MODEL_YEAR',
        detail: 'opt_cluster_existing',
      }),
    ]));
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps duplicate BASE_ITEM identity on HOLD within one MODEL_YEAR', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const lineage = await seedLineage(store, 'base', 2027);

    await store.putNode(supplemental(
      'base_led_existing',
      'BASE_ITEM',
      'LED 헤드램프',
      lineage
    ));

    const result = await promote(store, supplemental(
      'base_led_duplicate',
      'BASE_ITEM',
      'LED-헤드램프',
      lineage
    ));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'SUPPLEMENTAL_DUPLICATE_IN_MODEL_YEAR',
        detail: 'base_led_existing',
      }),
    ]));
    expect(result.canonicalWrite).toBeNull();
  });

  it('uses explicit aliases when detecting supplemental duplicates', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const lineage = await seedLineage(store, 'alias', 2027);

    await store.putNode(supplemental(
      'opt_prestige_existing',
      'OPTION',
      '드라이브 와이즈',
      lineage,
      ['Drive Wise']
    ));

    const result = await promote(store, supplemental(
      'opt_drivewise_duplicate',
      'OPTION',
      'Drive Wise',
      lineage
    ));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'SUPPLEMENTAL_DUPLICATE_IN_MODEL_YEAR',
        detail: 'opt_prestige_existing',
      }),
    ]));
  });

  it('keeps OPTION and PACKAGE type splits on HOLD for the same selectable identity', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const lineage = await seedLineage(store, 'type', 2027);

    await store.putNode(supplemental(
      'opt_style_existing',
      'OPTION',
      '스타일 패키지',
      lineage
    ));

    const result = await promote(store, supplemental(
      'pkg_style_conflict',
      'PACKAGE',
      '스타일 패키지',
      lineage
    ));

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'SUPPLEMENTAL_TYPE_CONFLICT_IN_MODEL_YEAR',
        fieldPath: 'nodeType',
        detail: 'OPTION:opt_style_existing',
      }),
    ]));
    expect(result.canonicalWrite).toBeNull();
  });

  it('allows the same equipment identity to be BASE_ITEM and OPTION in one MODEL_YEAR', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const lineage = await seedLineage(store, 'role', 2027);

    await store.putNode(supplemental(
      'base_hud_existing',
      'BASE_ITEM',
      '헤드업 디스플레이',
      lineage
    ));

    const result = await promote(store, supplemental(
      'opt_hud_role',
      'OPTION',
      '헤드업 디스플레이',
      lineage
    ));

    expect(result.decision.status).toBe('APPROVED');
    expect(result.canonicalWrite).toBe('CREATED');
  });

  it('allows the same supplemental identity in a different MODEL_YEAR of one PHASE', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const lineage2026 = await seedLineage(store, 'samephase', 2026);
    const modelYear2027 = sealVehicleMasterNode({
      id: 'my_samephase_2027',
      nodeType: 'MODEL_YEAR',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '2027년형',
      parentId: lineage2026.phase.id,
      refs: {
        makeId: lineage2026.make.id,
        modelId: lineage2026.model.id,
        generationId: lineage2026.generation.id,
        phaseId: lineage2026.phase.id,
      },
      aliases: ['2027MY'],
      attributes: { modelYear: 2027 },
      sourceEvidenceIds: [sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    await store.putNode(modelYear2027);
    const lineage2027 = { ...lineage2026, modelYear: modelYear2027 };

    await store.putNode(supplemental(
      'opt_year26',
      'OPTION',
      '드라이브 와이즈',
      lineage2026
    ));

    const result = await promote(store, supplemental(
      'opt_year27',
      'OPTION',
      '드라이브 와이즈',
      lineage2027
    ));

    expect(result.decision.status).toBe('APPROVED');
    expect(result.canonicalWrite).toBe('CREATED');
  });
});
