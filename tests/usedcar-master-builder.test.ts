import { describe, expect, it } from 'vitest';
import { buildUsedcarMasterRecords } from '../src/application/usedcar-master.js';
import {
  sealVehicleMasterNode,
  type VehicleMasterNode,
  type VehicleMasterStatus,
} from '../src/domain/vehicle-master.js';
import { MemoryVehicleMasterStore } from '../src/infra/vehicle-master-memory-store.js';

const observedAt = '2026-09-26T07:30:00.000Z';

function canonicalNode(input: {
  id: string;
  nodeType: VehicleMasterNode['nodeType'];
  name: string;
  status?: VehicleMasterStatus | undefined;
  attributes?: Record<string, unknown>;
}) {
  return sealVehicleMasterNode({
    id: input.id,
    nodeType: input.nodeType,
    status: input.status ?? 'ACTIVE',
    revision: 1,
    canonicalName: input.name,
    parentId: null,
    refs: {},
    aliases: [],
    attributes: input.attributes ?? {},
    sourceEvidenceIds: ['source_test'],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
}

async function seedChain(input: {
  makeStatus?: VehicleMasterStatus;
  modelStatus?: VehicleMasterStatus;
  generationStatus?: VehicleMasterStatus;
  phaseStatus?: VehicleMasterStatus;
  modelYearStatus?: VehicleMasterStatus;
  powertrainStatus?: VehicleMasterStatus;
  variantStatus?: VehicleMasterStatus;
  trimStatus?: VehicleMasterStatus;
  omit?: 'make' | 'model' | 'generation' | 'phase' | 'modelYear' | 'powertrain' | 'variant';
} = {}) {
  const store = new MemoryVehicleMasterStore();
  const nodes = {
    make: canonicalNode({ id: 'make_kia', nodeType: 'MAKE', name: '기아', status: input.makeStatus }),
    model: canonicalNode({ id: 'model_sorento', nodeType: 'MODEL', name: '쏘렌토', status: input.modelStatus }),
    generation: canonicalNode({ id: 'gen_mq4', nodeType: 'GENERATION', name: '4세대 MQ4', status: input.generationStatus }),
    phase: canonicalNode({ id: 'phase_mq4_pre', nodeType: 'PHASE', name: '초기형', status: input.phaseStatus }),
    modelYear: canonicalNode({
      id: 'my_2021',
      nodeType: 'MODEL_YEAR',
      name: '2021년형',
      status: input.modelYearStatus,
      attributes: { modelYear: 2021 },
    }),
    powertrain: canonicalNode({
      id: 'pt_hybrid',
      nodeType: 'POWERTRAIN',
      name: '1.6 터보 하이브리드',
      status: input.powertrainStatus,
      attributes: { fuelType: 'HYBRID' },
    }),
    variant: canonicalNode({
      id: 'variant_5seat_2wd',
      nodeType: 'VARIANT',
      name: '5인승 2WD',
      status: input.variantStatus,
      attributes: { seats: 5, drivetrain: '2WD' },
    }),
  };

  for (const [key, node] of Object.entries(nodes)) {
    if (input.omit !== key) await store.putNode(node);
  }

  await store.putNode(sealVehicleMasterNode({
    id: 'trim_noblesse',
    nodeType: 'TRIM',
    status: input.trimStatus ?? 'ACTIVE',
    revision: 1,
    canonicalName: '노블레스',
    parentId: 'variant_5seat_2wd',
    refs: {
      makeId: 'make_kia',
      modelId: 'model_sorento',
      generationId: 'gen_mq4',
      phaseId: 'phase_mq4_pre',
      modelYearId: 'my_2021',
      powertrainId: 'pt_hybrid',
      variantId: 'variant_5seat_2wd',
    },
    aliases: [],
    attributes: {},
    sourceEvidenceIds: ['source_test'],
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  }));

  return store;
}

describe('usedcar master canonical state projection', () => {
  it('fails closed when a referenced canonical ancestor is missing', async () => {
    const store = await seedChain({ omit: 'phase' });

    const [record] = await buildUsedcarMasterRecords(store);

    expect(record?.identityStatus).toBe('HOLD');
    expect(record?.lifecycleStatus).toBe('HOLD');
    expect(record?.holdReasons).toContain('PHASE_NOT_FOUND');
  });

  it('propagates HOLD from an ancestor even when the trim itself is ACTIVE', async () => {
    const store = await seedChain({ phaseStatus: 'HOLD' });

    const [record] = await buildUsedcarMasterRecords(store);

    expect(record?.identityStatus).toBe('HOLD');
    expect(record?.lifecycleStatus).toBe('HOLD');
    expect(record?.holdReasons).toContain('CANONICAL_PHASE_HOLD');
  });

  it('propagates historical lifecycle from the canonical chain', async () => {
    const store = await seedChain({ generationStatus: 'HISTORICAL' });

    const [record] = await buildUsedcarMasterRecords(store);

    expect(record?.identityStatus).toBe('RESOLVED');
    expect(record?.lifecycleStatus).toBe('HISTORICAL');
    expect(record?.holdReasons).toEqual([]);
  });

  it('gives DISCONTINUED precedence over HISTORICAL in the canonical chain', async () => {
    const store = await seedChain({
      generationStatus: 'HISTORICAL',
      phaseStatus: 'DISCONTINUED',
    });

    const [record] = await buildUsedcarMasterRecords(store);

    expect(record?.identityStatus).toBe('RESOLVED');
    expect(record?.lifecycleStatus).toBe('DISCONTINUED');
  });
});
