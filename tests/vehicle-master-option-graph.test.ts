import { describe, expect, it } from 'vitest';
import {
  sealVehicleMasterNode,
  sealVehicleMasterSourceDocument,
} from '../src/domain/vehicle-master.js';
import { MemoryVehicleMasterStore } from '../src/infra/vehicle-master-memory-store.js';
import {
  buildVehicleMasterTrimProposalSet,
} from '../src/application/vehicle-master-canonical-builder.js';
import {
  buildVehicleMasterOptionProposalSet,
} from '../src/application/vehicle-master-option-builder.js';
import {
  promoteVehicleMasterTrimProposalSet,
} from '../src/application/vehicle-master-promote-chain.js';
import {
  promoteVehicleMasterOptionProposalSet,
} from '../src/application/vehicle-master-option-promote.js';
import type {
  VehicleMasterReconciledTrim,
} from '../src/application/vehicle-master-reconcile.js';

const observedAt = '2026-09-25T10:00:00.000Z';
const sourceIds = ['official', 'secondary'];

async function seed(store: MemoryVehicleMasterStore) {
  const rows = [
    {
      id: 'make_kia',
      type: 'MAKE' as const,
      name: '기아',
      parentId: null,
      refs: {},
    },
    {
      id: 'model_sorento',
      type: 'MODEL' as const,
      name: '쏘렌토',
      parentId: 'make_kia',
      refs: { makeId: 'make_kia' },
    },
    {
      id: 'gen_mq4',
      type: 'GENERATION' as const,
      name: 'MQ4',
      parentId: 'model_sorento',
      refs: { makeId: 'make_kia', modelId: 'model_sorento' },
    },
    {
      id: 'phase_mq4_fl',
      type: 'PHASE' as const,
      name: '더 뉴 쏘렌토',
      parentId: 'gen_mq4',
      refs: {
        makeId: 'make_kia',
        modelId: 'model_sorento',
        generationId: 'gen_mq4',
      },
    },
  ];

  for (const { id, type, name, parentId, refs } of rows) {
    await store.putNode(sealVehicleMasterNode({
      id,
      nodeType: type,
      status: 'ACTIVE',
      revision: 1,
      canonicalName: name,
      parentId,
      refs,
      aliases: [],
      attributes: {},
      sourceEvidenceIds: sourceIds,
      effectiveFrom: null,
      effectiveTo: null,
      createdAt: observedAt,
      updatedAt: observedAt,
    }));
  }

  await store.putSourceDocument(sealVehicleMasterSourceDocument({
    sourceDocumentId: 'official',
    sourceType: 'MANUFACTURER_OFFICIAL',
    sourceName: 'Kia official',
    sourceUrl: 'https://www.kia.com/kr/vehicles/sorento/price',
    publishedAt: '2026-09-01T00:00:00.000Z',
    observedAt,
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveTo: null,
    storagePath: 'vehicle-master/source-documents/official/a.html',
    sha256: 'a'.repeat(64),
    mimeType: 'text/html',
    metadata: {},
  }));
  await store.putSourceDocument(sealVehicleMasterSourceDocument({
    sourceDocumentId: 'secondary',
    sourceType: 'CARNOON',
    sourceName: 'Carnoon',
    sourceUrl: 'https://www.carnoon.co.kr/newcar/vehicle/11572',
    publishedAt: null,
    observedAt,
    effectiveFrom: null,
    effectiveTo: null,
    storagePath: 'vehicle-master/source-documents/carnoon/b.html',
    sha256: 'b'.repeat(64),
    mimeType: 'text/html',
    metadata: {},
  }));
}

function reconciled(): VehicleMasterReconciledTrim {
  return {
    modelYear: 2027,
    powertrainName: '2.5 가솔린 터보',
    seats: 5,
    drivetrain: '2WD',
    trimName: '프레스티지',
    fuelType: 'GASOLINE',
    basePrice: 36410000,
    currency: 'KRW',
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    baseItems: [],
    options: [
      {
        name: '6인승',
        kind: 'SEATS',
        price: 840000,
        note: null,
        packageItems: [],
        conditions: [],
        sourceDocumentIds: sourceIds,
      },
      {
        name: '전자식 4WD',
        kind: 'DRIVETRAIN',
        price: 2320000,
        note: null,
        packageItems: [],
        conditions: [],
        sourceDocumentIds: sourceIds,
      },
      {
        name: '스노우 화이트 펄',
        kind: 'COLOR',
        price: 80000,
        note: null,
        packageItems: [],
        conditions: [],
        sourceDocumentIds: sourceIds,
      },
      {
        name: '12.3인치 클러스터',
        kind: 'OPTION',
        price: 590000,
        note: null,
        packageItems: [],
        conditions: [],
        sourceDocumentIds: sourceIds,
      },
      {
        name: '드라이브 와이즈',
        kind: 'OPTION',
        price: 1290000,
        note: '12.3인치 클러스터 적용 시',
        packageItems: ['전방 충돌방지 보조', '후측방 충돌방지 보조'],
        conditions: [{
          relation: 'REQUIRES',
          targetLabel: '12.3인치 클러스터',
          raw: '12.3인치 클러스터 적용 시',
        }],
        sourceDocumentIds: sourceIds,
      },
      {
        name: '사이드 스텝',
        kind: 'ACCESSORY',
        price: 390000,
        note: null,
        packageItems: [],
        conditions: [],
        sourceDocumentIds: sourceIds,
      },
    ],
    sourceDocumentIds: sourceIds,
    fieldEvidence: {
      modelYear: sourceIds,
      powertrainName: sourceIds,
      trimName: sourceIds,
      basePrice: sourceIds,
      seats: sourceIds,
      drivetrain: sourceIds,
      fuelType: sourceIds,
      currency: sourceIds,
    },
    conflicts: [],
  };
}

describe('vehicle master option graph', () => {
  it('keeps structural selections out of Option nodes and promotes option/color rules', async () => {
    const store = new MemoryVehicleMasterStore();
    await seed(store);

    const trimSet = buildVehicleMasterTrimProposalSet({
      anchor: {
        makeId: 'make_kia',
        modelId: 'model_sorento',
        generationId: 'gen_mq4',
        phaseId: 'phase_mq4_fl',
      },
      reconciled: reconciled(),
      observedAt,
    });
    await promoteVehicleMasterTrimProposalSet(store, trimSet);

    const optionSet = buildVehicleMasterOptionProposalSet({
      reconciled: reconciled(),
      trimProposalSet: trimSet,
      observedAt,
    });

    expect(optionSet.structuralSelections.map((item) => item.kind)).toEqual([
      'DRIVETRAIN',
      'SEATS',
    ]);
    expect(optionSet.options).toHaveLength(4);
    expect(optionSet.unresolvedConditions).toEqual([]);

    const color = optionSet.options.find((item) => item.source.kind === 'COLOR');
    expect(color?.node.record.nodeType).toBe('COLOR');

    const driveWise = optionSet.options.find(
      (item) => item.source.name === '드라이브 와이즈'
    );
    expect(driveWise?.node.record.nodeType).toBe('PACKAGE');
    expect(driveWise?.price?.record.priceType).toBe('PACKAGE');
    expect(driveWise?.dependencies).toHaveLength(1);
    expect(driveWise?.dependencies[0]?.record.ruleType).toBe('REQUIRES');

    const result = await promoteVehicleMasterOptionProposalSet(store, optionSet);
    expect(result.options).toHaveLength(4);
    for (const item of result.options) {
      expect(item.node.canonicalWrite).toBe('CREATED');
      expect(item.price?.canonicalWrite).toBe('CREATED');
      expect(item.availability.canonicalWrite).toBe('CREATED');
    }
    expect(
      result.options.find((item) => item.dependencies.length)?.dependencies[0]?.canonicalWrite
    ).toBe('CREATED');
  });

  it('remains idempotent when the same option graph is observed again', async () => {
    const store = new MemoryVehicleMasterStore();
    await seed(store);

    const firstTrimSet = buildVehicleMasterTrimProposalSet({
      anchor: {
        makeId: 'make_kia',
        modelId: 'model_sorento',
        generationId: 'gen_mq4',
        phaseId: 'phase_mq4_fl',
      },
      reconciled: reconciled(),
      observedAt,
    });
    await promoteVehicleMasterTrimProposalSet(store, firstTrimSet);
    const firstOptions = buildVehicleMasterOptionProposalSet({
      reconciled: reconciled(),
      trimProposalSet: firstTrimSet,
      observedAt,
    });
    await promoteVehicleMasterOptionProposalSet(store, firstOptions);

    const secondTrimSet = buildVehicleMasterTrimProposalSet({
      anchor: {
        makeId: 'make_kia',
        modelId: 'model_sorento',
        generationId: 'gen_mq4',
        phaseId: 'phase_mq4_fl',
      },
      reconciled: reconciled(),
      observedAt: '2026-09-26T10:00:00.000Z',
    });
    await promoteVehicleMasterTrimProposalSet(store, secondTrimSet);
    const secondOptions = buildVehicleMasterOptionProposalSet({
      reconciled: reconciled(),
      trimProposalSet: secondTrimSet,
      observedAt: '2026-09-26T10:00:00.000Z',
    });
    const result = await promoteVehicleMasterOptionProposalSet(store, secondOptions);

    for (const item of result.options) {
      expect(item.node.canonicalWrite).toBe('UNCHANGED');
      expect(item.price?.canonicalWrite).toBe('UNCHANGED');
      expect(item.availability.canonicalWrite).toBe('UNCHANGED');
      for (const dependency of item.dependencies) {
        expect(dependency.canonicalWrite).toBe('UNCHANGED');
      }
    }
  });
});
