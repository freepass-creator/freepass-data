import { describe, expect, it } from 'vitest';
import {
  sealVehicleMasterNode,
  sealVehicleMasterPriceRevision,
  sealVehicleMasterSourceDocument,
  type VehicleMasterNode,
  type VehicleMasterPriceRevision,
} from '../src/domain/vehicle-master.js';
import {
  promoteVehicleMasterPriceRevision,
} from '../src/application/vehicle-master-ingestion.js';
import { MemoryVehicleMasterStore } from '../src/infra/vehicle-master-memory-store.js';
import {
  canonicalPowertrainIdentity,
  canonicalTrimIdentity,
} from '../src/domain/vehicle-master-normalization.js';

const observedAt = '2026-09-26T09:45:00.000Z';
const sourceDocumentId = 'official-price-semantics';

type Seeded = {
  make: VehicleMasterNode;
  model: VehicleMasterNode;
  generation: VehicleMasterNode;
  phase: VehicleMasterNode;
  modelYear: VehicleMasterNode;
  powertrain: VehicleMasterNode;
  variant: VehicleMasterNode;
  trim: VehicleMasterNode;
  option: VehicleMasterNode;
  packageNode: VehicleMasterNode;
  color: VehicleMasterNode;
};

async function seedSource(store: MemoryVehicleMasterStore) {
  await store.putSourceDocument(sealVehicleMasterSourceDocument({
    sourceDocumentId,
    sourceType: 'MANUFACTURER_OFFICIAL',
    sourceName: 'official price semantics',
    sourceUrl: 'https://example.test/price-semantics',
    publishedAt: observedAt,
    observedAt,
    effectiveFrom: null,
    effectiveTo: null,
    storagePath: 'vehicle-master/source-documents/test/price-semantics.html',
    sha256: 'b'.repeat(64),
    mimeType: 'text/html',
    metadata: {},
  }));
}

async function seed(store: MemoryVehicleMasterStore): Promise<Seeded> {
  const make = sealVehicleMasterNode({
    id: 'make_price',
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
    id: 'model_price',
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
    id: 'gen_price',
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
    id: 'phase_price',
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
    id: 'my_price',
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
    id: 'pt_price',
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
    id: 'variant_price',
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
    id: 'trim_price',
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

  const supplementalRefs = {
    makeId: make.id,
    modelId: model.id,
    generationId: generation.id,
    phaseId: phase.id,
    modelYearId: modelYear.id,
  };
  const option = sealVehicleMasterNode({
    id: 'opt_price',
    nodeType: 'OPTION',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '드라이브 와이즈',
    parentId: modelYear.id,
    refs: supplementalRefs,
    aliases: [],
    attributes: {},
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  const packageNode = sealVehicleMasterNode({
    id: 'pkg_price',
    nodeType: 'PACKAGE',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '스타일 패키지',
    parentId: modelYear.id,
    refs: supplementalRefs,
    aliases: [],
    attributes: {},
    sourceEvidenceIds: [sourceDocumentId],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
  const color = sealVehicleMasterNode({
    id: 'color_price',
    nodeType: 'COLOR',
    status: 'ACTIVE',
    revision: 1,
    canonicalName: '스노우 화이트 펄',
    parentId: modelYear.id,
    refs: supplementalRefs,
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
    option,
    packageNode,
    color,
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
    option,
    packageNode,
    color,
  };
}

function price(
  id: string,
  targetId: string,
  priceType: VehicleMasterPriceRevision['priceType']
) {
  return sealVehicleMasterPriceRevision({
    id,
    targetId,
    priceType,
    amount: 100000,
    currency: 'KRW',
    revision: 1,
    sourceEvidenceIds: [sourceDocumentId],
    sourceDocumentIds: [sourceDocumentId],
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
}

async function promote(
  store: MemoryVehicleMasterStore,
  proposal: ReturnType<typeof price>
) {
  return promoteVehicleMasterPriceRevision(store, {
    proposal,
    observations: [
      { fieldPath: 'amount', value: proposal.amount, sourceDocumentId },
      { fieldPath: 'currency', value: proposal.currency, sourceDocumentId },
      { fieldPath: 'targetId', value: proposal.targetId, sourceDocumentId },
    ],
    policy: {
      requiredFieldPaths: ['amount', 'currency', 'targetId'],
      minCorroboratingSourcesWithoutOfficial: 2,
    },
    observedAt,
  });
}

describe('vehicle master price target semantics', () => {
  it.each([
    ['BASE', 'trim'],
    ['OPTION', 'option'],
    ['PACKAGE', 'packageNode'],
    ['COLOR', 'color'],
  ] as const)('approves %s price only on its canonical target type', async (priceType, targetKey) => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const nodes = await seed(store);

    const result = await promote(
      store,
      price(`price_${priceType.toLowerCase()}_valid`, nodes[targetKey].id, priceType)
    );

    expect(result.decision.status).toBe('APPROVED');
    expect(result.canonicalWrite).toBe('CREATED');
  });

  it('keeps price on HOLD when priceType and target nodeType disagree', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const nodes = await seed(store);

    const result = await promote(
      store,
      price('price_color_on_option', nodes.option.id, 'COLOR')
    );

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'PRICE_TARGET_TYPE_MISMATCH',
        fieldPath: 'targetId',
        detail: 'OPTION!=COLOR',
      }),
    ]));
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps BASE price on HOLD when the target is not a TRIM', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const nodes = await seed(store);

    const result = await promote(
      store,
      price('price_base_on_package', nodes.packageNode.id, 'BASE')
    );

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'PRICE_TARGET_TYPE_MISMATCH',
        detail: 'PACKAGE!=TRIM',
      }),
    ]));
    expect(result.canonicalWrite).toBeNull();
  });

  it('keeps price on HOLD when its target has incomplete canonical lineage', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const nodes = await seed(store);

    const incompleteOption = sealVehicleMasterNode({
      id: 'opt_price_incomplete',
      nodeType: 'OPTION',
      status: 'ACTIVE',
      revision: 1,
      canonicalName: '불완전 옵션',
      parentId: nodes.modelYear.id,
      refs: {
        makeId: nodes.make.id,
        modelId: nodes.model.id,
        generationId: null,
        phaseId: nodes.phase.id,
        modelYearId: nodes.modelYear.id,
      },
      aliases: [],
      attributes: {},
      sourceEvidenceIds: [sourceDocumentId],
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    });
    await store.putNode(incompleteOption);

    const result = await promote(
      store,
      price('price_option_incomplete', incompleteOption.id, 'OPTION')
    );

    expect(result.decision.status).toBe('HOLD');
    expect(result.decision.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'PRICE_TARGET_LINEAGE_INCOMPLETE',
        fieldPath: 'targetId.generationId',
        detail: incompleteOption.id,
      }),
    ]));
    expect(result.canonicalWrite).toBeNull();
  });

  it('does not invent a nodeType restriction for ADJUSTMENT yet', async () => {
    const store = new MemoryVehicleMasterStore();
    await seedSource(store);
    const nodes = await seed(store);

    const result = await promote(
      store,
      price('price_adjustment_trim', nodes.trim.id, 'ADJUSTMENT')
    );

    expect(result.decision.status).toBe('APPROVED');
    expect(result.canonicalWrite).toBe('CREATED');
  });
});
