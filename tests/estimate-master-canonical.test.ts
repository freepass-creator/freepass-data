import { describe, expect, it } from 'vitest';
import {
  sealVehicleMasterCompatibilityRule,
  sealVehicleMasterNode,
  sealVehicleMasterPriceRevision,
} from '../src/domain/vehicle-master.js';
import { MemoryVehicleMasterStore } from '../src/infra/vehicle-master-memory-store.js';
import { buildEstimateMasterFromCanonicalVehicleMaster } from '../src/application/estimate-master-canonical.js';

const now = '2026-09-26T10:00:00.000Z';
const source = ['src_official'];

function node(input: {
  id: string;
  nodeType: Parameters<typeof sealVehicleMasterNode>[0]['nodeType'];
  name: string;
  parentId?: string | null;
  refs?: Record<string, string | null>;
  attributes?: Record<string, unknown>;
}) {
  return sealVehicleMasterNode({
    id: input.id,
    nodeType: input.nodeType,
    status: 'ACTIVE',
    revision: 1,
    canonicalName: input.name,
    parentId: input.parentId ?? null,
    refs: input.refs ?? {},
    aliases: [],
    attributes: input.attributes ?? {},
    sourceEvidenceIds: source,
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: now,
    updatedAt: now,
  });
}

function price(id: string, targetId: string, priceType: Parameters<typeof sealVehicleMasterPriceRevision>[0]['priceType'], amount: number) {
  return sealVehicleMasterPriceRevision({
    id,
    targetId,
    priceType,
    amount,
    currency: 'KRW',
    revision: 1,
    sourceEvidenceIds: source,
    sourceDocumentIds: source,
    effectiveFrom: '2026-09-01T00:00:00.000Z',
    effectiveTo: null,
    createdAt: now,
    updatedAt: now,
  });
}

function rule(input: {
  id: string;
  subjectId: string;
  ruleType: Parameters<typeof sealVehicleMasterCompatibilityRule>[0]['ruleType'];
  targetIds?: string[];
  trimId: string;
  effect?: Parameters<typeof sealVehicleMasterCompatibilityRule>[0]['effect'];
}) {
  return sealVehicleMasterCompatibilityRule({
    id: input.id,
    subjectId: input.subjectId,
    ruleType: input.ruleType,
    targetIds: input.targetIds ?? [],
    scope: { trimId: input.trimId },
    condition: null,
    effect: input.effect ?? 'VALID',
    priority: 100,
    sourceEvidenceIds: source,
    effectiveFrom: null,
    effectiveTo: null,
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
}

async function fixture() {
  const store = new MemoryVehicleMasterStore();
  const make = node({ id: 'make_kia', nodeType: 'MAKE', name: '기아' });
  const model = node({
    id: 'model_niro', nodeType: 'MODEL', name: '니로',
    parentId: make.id, refs: { makeId: make.id },
  });
  const year = node({
    id: 'my_niro_2026', nodeType: 'MODEL_YEAR', name: '2026년형',
    parentId: 'phase_niro',
    refs: { makeId: make.id, modelId: model.id, generationId: 'gen_niro', phaseId: 'phase_niro' },
    attributes: { modelYear: 2026 },
  });
  const powertrain = node({
    id: 'pt_niro_hev', nodeType: 'POWERTRAIN', name: '1.6 하이브리드',
    parentId: year.id,
    refs: { ...year.refs, modelYearId: year.id },
    attributes: { fuelType: 'HYBRID' },
  });
  const variant = node({
    id: 'variant_niro_fwd5', nodeType: 'VARIANT', name: '5인승 FWD',
    parentId: powertrain.id,
    refs: { ...powertrain.refs, powertrainId: powertrain.id },
    attributes: { seats: 5, drivetrain: 'FWD' },
  });
  const trim = node({
    id: 'trim_niro_signature', nodeType: 'TRIM', name: '시그니처',
    parentId: variant.id,
    refs: { ...variant.refs, variantId: variant.id },
  });
  const option = node({
    id: 'opt_drivewise', nodeType: 'OPTION', name: '드라이브 와이즈',
    parentId: year.id, refs: { ...year.refs, modelYearId: year.id },
  });
  const ext = node({
    id: 'color_swp', nodeType: 'COLOR', name: '스노우 화이트 펄',
    parentId: year.id, refs: { ...year.refs, modelYearId: year.id },
  });
  const interior = node({
    id: 'color_black', nodeType: 'COLOR', name: '블랙',
    parentId: year.id, refs: { ...year.refs, modelYearId: year.id },
  });

  for (const value of [make, model, year, powertrain, variant, trim, option, ext, interior]) {
    await store.putNode(value);
  }
  await store.putPriceRevision(price('price_trim', trim.id, 'BASE', 35020000));
  await store.putPriceRevision(price('price_option', option.id, 'OPTION', 700000));
  await store.putPriceRevision(price('price_ext', ext.id, 'COLOR', 80000));
  await store.putPriceRevision(price('price_int', interior.id, 'COLOR', 0));

  await store.putCompatibilityRule(rule({
    id: 'avail_option', subjectId: option.id, ruleType: 'AVAILABLE_IF', trimId: trim.id,
  }));
  await store.putCompatibilityRule(rule({
    id: 'avail_ext', subjectId: ext.id, ruleType: 'AVAILABLE_IF', trimId: trim.id,
  }));
  await store.putCompatibilityRule(rule({
    id: 'avail_int', subjectId: interior.id, ruleType: 'AVAILABLE_IF', trimId: trim.id,
  }));

  return { store, trim, option, ext, interior };
}

describe('canonical vehicle master -> Estimate master dry-run', () => {
  it('fails closed into HOLD when product bridge and color domains are not evidenced', async () => {
    const { store, trim } = await fixture();
    const built = await buildEstimateMasterFromCanonicalVehicleMaster(store, { asOf: now });

    expect(built.records).toHaveLength(1);
    expect(built.records[0]).toMatchObject({
      productId: trim.id,
      trimId: trim.id,
      status: 'HOLD',
    });
    expect(built.records[0]?.holdReasons).toEqual(expect.arrayContaining([
      'PRODUCT_ID_BRIDGE_UNVERIFIED',
      'PRICE_BASIS_UNVERIFIED',
      'COLOR_DOMAIN_UNVERIFIED',
      'EXTERIOR_COLOR_UNAVAILABLE',
      'INTERIOR_COLOR_UNAVAILABLE',
    ]));
    expect(built.summary.active).toBe(0);
    expect(built.summary.hold).toBe(1);
    expect(built.summary.inputDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('becomes ACTIVE only when commercial identity, price basis, and color domains are explicit', async () => {
    const { store, trim, option, ext, interior } = await fixture();
    const built = await buildEstimateMasterFromCanonicalVehicleMaster(store, {
      asOf: now,
      bridge: {
        products: [{
          trimId: trim.id,
          productId: 'kia_niro_hev_signature',
          priceBefore: 35020000,
          priceAfter: 34520000,
          priceBasis: '세제혜택 후',
        }],
        colorDomains: {
          [ext.id]: 'EXTERIOR',
          [interior.id]: 'INTERIOR',
        },
      },
    });

    expect(built.summary).toMatchObject({ total: 1, active: 1, hold: 0, activeRate: 1 });
    expect(built.records[0]).toMatchObject({
      productId: 'kia_niro_hev_signature',
      vehicleModelId: 'model_niro',
      modelYearId: 'my_niro_2026',
      powertrainId: 'pt_niro_hev',
      trimId: trim.id,
      modelYear: 2026,
      status: 'ACTIVE',
    });
    expect(built.records[0]?.options).toEqual([
      expect.objectContaining({
        optionId: option.id,
        name: '드라이브 와이즈',
        price: { amount: 700000, currency: 'KRW' },
      }),
    ]);
    expect(built.records[0]?.exteriorColors[0]?.colorId).toBe(ext.id);
    expect(built.records[0]?.interiorColors[0]?.colorId).toBe(interior.id);
    expect(built.records[0]?.holdReasons).toEqual([]);
  });

  it('rejects duplicate product identities in the commercial bridge', async () => {
    const { store, trim, ext, interior } = await fixture();
    const second = node({
      id: 'trim_niro_prestige', nodeType: 'TRIM', name: '프레스티지',
      parentId: 'variant_niro_fwd5',
      refs: {
        makeId: 'make_kia', modelId: 'model_niro', generationId: 'gen_niro',
        phaseId: 'phase_niro', modelYearId: 'my_niro_2026',
        powertrainId: 'pt_niro_hev', variantId: 'variant_niro_fwd5',
      },
    });
    await store.putNode(second);
    await store.putPriceRevision(price('price_trim_2', second.id, 'BASE', 33000000));
    await store.putCompatibilityRule(rule({
      id: 'avail_ext_2', subjectId: ext.id, ruleType: 'AVAILABLE_IF', trimId: second.id,
    }));
    await store.putCompatibilityRule(rule({
      id: 'avail_int_2', subjectId: interior.id, ruleType: 'AVAILABLE_IF', trimId: second.id,
    }));

    await expect(buildEstimateMasterFromCanonicalVehicleMaster(store, {
      asOf: now,
      bridge: {
        products: [
          { trimId: trim.id, productId: 'dup', priceBefore: 1, priceAfter: 1, priceBasis: 'x' },
          { trimId: second.id, productId: 'dup', priceBefore: 1, priceAfter: 1, priceBasis: 'x' },
        ],
        colorDomains: { [ext.id]: 'EXTERIOR', [interior.id]: 'INTERIOR' },
      },
    })).rejects.toThrow('DUPLICATE_PRODUCT_ID');
  });
});
