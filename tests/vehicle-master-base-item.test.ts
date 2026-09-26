import { describe, expect, it } from 'vitest';
import {
  sealVehicleMasterNode,
  sealVehicleMasterSourceDocument,
} from '../src/domain/vehicle-master.js';
import { MemoryVehicleMasterStore } from '../src/infra/vehicle-master-memory-store.js';
import { buildVehicleMasterTrimProposalSet } from '../src/application/vehicle-master-canonical-builder.js';
import { promoteVehicleMasterTrimProposalSet } from '../src/application/vehicle-master-promote-chain.js';
import { buildVehicleMasterBaseItemProposalSet } from '../src/application/vehicle-master-base-item-builder.js';
import { promoteVehicleMasterBaseItemProposalSet } from '../src/application/vehicle-master-base-item-promote.js';
import type { VehicleMasterReconciledTrim } from '../src/application/vehicle-master-reconcile.js';

const observedAt = '2026-09-25T11:00:00.000Z';
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
    storagePath: 'vehicle-master/source-documents/official/base-items.html',
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
    storagePath: 'vehicle-master/source-documents/carnoon/base-items.html',
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
    baseItems: [
      '스마트스트림 G2.5 터보 엔진',
      'LED 헤드램프',
    ],
    baseItemDetails: [
      {
        category: '파워트레인',
        name: '스마트스트림 G2.5 터보 엔진',
        sourceDocumentIds: sourceIds,
      },
      {
        category: '외장',
        name: 'LED 헤드램프',
        sourceDocumentIds: sourceIds,
      },
    ],
    options: [],
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

describe('vehicle master base-item graph', () => {
  it('promotes categorized standard equipment and trim inclusion rules', async () => {
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

    const baseSet = buildVehicleMasterBaseItemProposalSet({
      reconciled: reconciled(),
      trimProposalSet: trimSet,
      observedAt,
    });
    expect(baseSet.items).toHaveLength(2);
    expect(baseSet.items.map((item) => item.node.record.nodeType)).toEqual([
      'BASE_ITEM',
      'BASE_ITEM',
    ]);
    expect(baseSet.items.map((item) => item.inclusion.record.ruleType)).toEqual([
      'INCLUDES',
      'INCLUDES',
    ]);

    const result = await promoteVehicleMasterBaseItemProposalSet(store, baseSet);
    for (const item of result.items) {
      expect(item.node.canonicalWrite).toBe('CREATED');
      expect(item.inclusion.canonicalWrite).toBe('CREATED');
    }
  });

  it('does not revise unchanged base-item relations on a later observation', async () => {
    const store = new MemoryVehicleMasterStore();
    await seed(store);
    const firstTrim = buildVehicleMasterTrimProposalSet({
      anchor: {
        makeId: 'make_kia',
        modelId: 'model_sorento',
        generationId: 'gen_mq4',
        phaseId: 'phase_mq4_fl',
      },
      reconciled: reconciled(),
      observedAt,
    });
    await promoteVehicleMasterTrimProposalSet(store, firstTrim);
    const firstBase = buildVehicleMasterBaseItemProposalSet({
      reconciled: reconciled(),
      trimProposalSet: firstTrim,
      observedAt,
    });
    await promoteVehicleMasterBaseItemProposalSet(store, firstBase);

    const later = '2026-09-26T11:00:00.000Z';
    const secondTrim = buildVehicleMasterTrimProposalSet({
      anchor: {
        makeId: 'make_kia',
        modelId: 'model_sorento',
        generationId: 'gen_mq4',
        phaseId: 'phase_mq4_fl',
      },
      reconciled: reconciled(),
      observedAt: later,
    });
    await promoteVehicleMasterTrimProposalSet(store, secondTrim);
    const secondBase = buildVehicleMasterBaseItemProposalSet({
      reconciled: reconciled(),
      trimProposalSet: secondTrim,
      observedAt: later,
    });
    const result = await promoteVehicleMasterBaseItemProposalSet(store, secondBase);

    for (const item of result.items) {
      expect(item.node.canonicalWrite).toBe('UNCHANGED');
      expect(item.inclusion.canonicalWrite).toBe('UNCHANGED');
    }
  });
});
