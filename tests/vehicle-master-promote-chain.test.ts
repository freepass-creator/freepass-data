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
  promoteVehicleMasterTrimProposalSet,
} from '../src/application/vehicle-master-promote-chain.js';
import type {
  VehicleMasterReconciledTrim,
} from '../src/application/vehicle-master-reconcile.js';

const observedAt = '2026-09-25T09:00:00.000Z';
const sourceIds = ['official', 'secondary'];

async function seed(store: MemoryVehicleMasterStore) {
  for (const [id, type, name, parentId] of [
    ['make_kia', 'MAKE', '기아', null],
    ['model_sorento', 'MODEL', '쏘렌토', 'make_kia'],
    ['gen_mq4', 'GENERATION', 'MQ4', 'model_sorento'],
    ['phase_mq4_fl', 'PHASE', '더 뉴 쏘렌토', 'gen_mq4'],
  ] as const) {
    await store.putNode(sealVehicleMasterNode({
      id,
      nodeType: type,
      status: 'ACTIVE',
      revision: 1,
      canonicalName: name,
      parentId,
      refs: {},
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
    sourceName: 'official',
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
    sourceName: 'secondary',
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

function reconciled(basePrice = 36410000, effectiveFrom = '2026-09-01T00:00:00.000Z'): VehicleMasterReconciledTrim {
  return {
    modelYear: 2027,
    powertrainName: '2.5 가솔린 터보',
    seats: 5,
    drivetrain: '2WD',
    trimName: '프레스티지',
    fuelType: 'GASOLINE',
    basePrice,
    currency: 'KRW',
    effectiveFrom,
    baseItems: [],
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

describe('vehicle master canonical promotion chain', () => {
  it('promotes the full chain and is idempotent on repeat', async () => {
    const store = new MemoryVehicleMasterStore();
    await seed(store);

    const proposals = buildVehicleMasterTrimProposalSet({
      anchor: {
        makeId: 'make_kia',
        modelId: 'model_sorento',
        generationId: 'gen_mq4',
        phaseId: 'phase_mq4_fl',
      },
      reconciled: reconciled(),
      observedAt,
    });

    const first = await promoteVehicleMasterTrimProposalSet(store, proposals);
    expect(first.modelYear.canonicalWrite).toBe('CREATED');
    expect(first.powertrain.canonicalWrite).toBe('CREATED');
    expect(first.variant.canonicalWrite).toBe('CREATED');
    expect(first.trim.canonicalWrite).toBe('CREATED');
    expect(first.basePrice.canonicalWrite).toBe('CREATED');

    const secondProposals = buildVehicleMasterTrimProposalSet({
      anchor: {
        makeId: 'make_kia',
        modelId: 'model_sorento',
        generationId: 'gen_mq4',
        phaseId: 'phase_mq4_fl',
      },
      reconciled: reconciled(),
      observedAt: '2026-09-26T09:00:00.000Z',
    });
    const second = await promoteVehicleMasterTrimProposalSet(store, secondProposals);

    expect(second.modelYear.canonicalWrite).toBe('UNCHANGED');
    expect(second.powertrain.canonicalWrite).toBe('UNCHANGED');
    expect(second.variant.canonicalWrite).toBe('UNCHANGED');
    expect(second.trim.canonicalWrite).toBe('UNCHANGED');
    expect(second.basePrice.canonicalWrite).toBe('UNCHANGED');
  });

  it('creates the next price revision when the effective price actually changes', async () => {
    const store = new MemoryVehicleMasterStore();
    await seed(store);

    const first = buildVehicleMasterTrimProposalSet({
      anchor: {
        makeId: 'make_kia',
        modelId: 'model_sorento',
        generationId: 'gen_mq4',
        phaseId: 'phase_mq4_fl',
      },
      reconciled: reconciled(),
      observedAt,
    });
    await promoteVehicleMasterTrimProposalSet(store, first);

    const changed = buildVehicleMasterTrimProposalSet({
      anchor: {
        makeId: 'make_kia',
        modelId: 'model_sorento',
        generationId: 'gen_mq4',
        phaseId: 'phase_mq4_fl',
      },
      reconciled: reconciled(36510000, '2026-10-01T00:00:00.000Z'),
      observedAt: '2026-10-01T09:00:00.000Z',
    });
    const result = await promoteVehicleMasterTrimProposalSet(store, changed);

    expect(result.trim.canonicalWrite).toBe('UPDATED');
    expect(result.basePrice.canonicalWrite).toBe('CREATED');

    const prices = await store.listPriceRevisionsByTarget(changed.trim.record.id);
    expect(prices).toHaveLength(2);
    expect(prices.map((price) => [price.revision, price.amount])).toEqual([
      [1, 36410000],
      [2, 36510000],
    ]);
  });
});
