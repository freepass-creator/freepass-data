import { describe, expect, it } from 'vitest';
import type { Offer, Policy, Product, VehicleAsset, VehicleModel } from '../src/domain/catalog.js';
import {
  buildCommercialProductView,
  CONTRACT_CONDITION_FACT_KEYS,
  PRODUCT_POLICY_FACT_KEYS,
} from '../src/application/build-commercial-product-view.js';

const meta = {
  schemaVersion: '1', revision: 1, validationStatus: 'VALID' as const,
  createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z',
  createdBy: { id: 'service:test', kind: 'SERVICE' as const },
  updatedBy: { id: 'service:test', kind: 'SERVICE' as const },
  lineageId: 'lin_test',
};

const model: VehicleModel = {
  ...meta, id: 'vm_1', maker: '현대', model: '그랜저', displayName: '현대 그랜저',
  generation: 'GN7', trim: '프리미엄', fuel: '가솔린', seats: 5,
};
const asset: VehicleAsset = {
  ...meta, id: 'va_1', vehicleModelId: 'vm_1', status: 'AVAILABLE',
  plateNumber: '12하3456', odometerKm: 32000,
};
const product: Product = {
  ...meta, id: 'prod_1', vehicleModelId: 'vm_1', vehicleAssetId: 'va_1',
  commercialType: 'USED_RENT', status: 'ACTIVE', displayName: '그랜저 중고렌트',
};
const offer: Offer = {
  ...meta, id: 'offer_1', productId: 'prod_1', supplierId: 'RP001',
  status: 'ACTIVE', policyId: 'policy_1',
  priceTerms: [
    { termKey: '24_2만', termMonths: 24, monthlyRent: { amount: 700000, currency: 'KRW' },
      deposit: { amount: 3000000, currency: 'KRW' }, depositState: 'KNOWN', mileageLimitKmPerYear: 20000 },
    { termKey: '24_3만', termMonths: 24, monthlyRent: { amount: 760000, currency: 'KRW' },
      deposit: { amount: 3000000, currency: 'KRW' }, depositState: 'KNOWN', mileageLimitKmPerYear: 30000 },
  ],
};
const policy: Policy = {
  ...meta, id: 'policy_1', kind: 'OTHER', version: '1',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  facts: {
    annual_mileage: 20000,
    max_annual_mileage: 30000,
    over_mileage_rate_per_km: 200,
    insurance_included: true,
    basic_driver_age: 26,
    succession_allowed: true,
    early_termination_rate_under1y: 35,
  },
};

describe('commercial product four-part view', () => {
  it('separates vehicle, rental rates, product policy and contract conditions', () => {
    const view = buildCommercialProductView({ product, vehicleModel: model, vehicleAsset: asset, offer, policy });

    expect(view.vehicle).toMatchObject({
      productId: 'prod_1', commercialType: 'USED_RENT', maker: '현대', model: '그랜저',
      vehicleAssetId: 'va_1', plateNumber: '12하3456',
    });

    expect(view.rentalRates).toEqual([
      {
        termKey: '24_2만', termMonths: 24, mileageKmPerYear: 20000, isDefaultMileage: true,
        monthlyRent: { amount: 700000, currency: 'KRW' },
      },
      {
        termKey: '24_3만', termMonths: 24, mileageKmPerYear: 30000, isDefaultMileage: false,
        monthlyRent: { amount: 760000, currency: 'KRW' },
      },
    ]);

    expect(view.policy.defaultAnnualMileageKm).toBe(20000);
    expect(view.policy.facts.map((fact) => fact.key)).toEqual([
      'annual_mileage', 'max_annual_mileage', 'over_mileage_rate_per_km',
    ]);

    expect(view.contractConditions.depositByTerm[0]).toEqual({
      termKey: '24_2만', state: 'KNOWN', amount: { amount: 3000000, currency: 'KRW' },
    });
    expect(view.contractConditions.facts.map((fact) => fact.key)).toEqual([
      'basic_driver_age', 'early_termination_rate_under1y', 'insurance_included', 'succession_allowed',
    ]);
    expect(view.review.status).toBe('READY');
  });

  it('never silently drops a new policy fact', () => {
    const inputPolicy = { ...policy, facts: { ...policy.facts, future_supplier_rule: 'keep for review' } };
    const view = buildCommercialProductView({
      product, vehicleModel: model, vehicleAsset: asset, offer, policy: inputPolicy,
    });
    expect(view.review.status).toBe('NEEDS_DECISION');
    expect(view.review.decisions).toContain('POLICY_FACT_CLASSIFICATION_REQUIRED');
    expect(view.review.unclassifiedPolicyFacts).toEqual(['future_supplier_rule']);
  });

  it('keeps deposit out of rentalRates while preserving it under contract conditions', () => {
    const view = buildCommercialProductView({ product, vehicleModel: model, vehicleAsset: asset, offer, policy });
    expect(view.rentalRates[0]).not.toHaveProperty('deposit');
    expect(view.contractConditions.depositByTerm).toHaveLength(2);
  });

  it('covers every currently known Admin policy key in one of the two semantic buckets', () => {
    const all = new Set([...PRODUCT_POLICY_FACT_KEYS, ...CONTRACT_CONDITION_FACT_KEYS]);
    expect(all.size).toBe(PRODUCT_POLICY_FACT_KEYS.length + CONTRACT_CONDITION_FACT_KEYS.length);
    for (const key of Object.keys(policy.facts)) expect(all.has(key as never)).toBe(true);
  });

  it('rejects mismatched product/vehicle/offer identity instead of composing unrelated records', () => {
    expect(() => buildCommercialProductView({
      product: { ...product, vehicleModelId: 'other' },
      vehicleModel: model, vehicleAsset: asset, offer, policy,
    })).toThrow('PRODUCT_VEHICLE_MODEL_MISMATCH');
    expect(() => buildCommercialProductView({
      product, vehicleModel: model, vehicleAsset: asset, offer: { ...offer, productId: 'other' }, policy,
    })).toThrow('OFFER_PRODUCT_MISMATCH');
  });
});
