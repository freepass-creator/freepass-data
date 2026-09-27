import { describe, expect, it } from 'vitest';
import type { Offer, Policy, Product, VehicleAsset, VehicleModel } from '../src/domain/catalog.js';
import { buildCommercialProductView } from '../src/application/build-commercial-product-view.js';
import { evaluateProductConditions } from '../src/application/evaluate-product-conditions.js';

const meta = {
  schemaVersion: '1', revision: 1, validationStatus: 'VALID' as const,
  createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z',
  createdBy: { id: 'service:test', kind: 'SERVICE' as const },
  updatedBy: { id: 'service:test', kind: 'SERVICE' as const },
  lineageId: 'lin_test',
};

const model: VehicleModel = {
  ...meta, id: 'vm_1', maker: '현대', model: '그랜저', displayName: '현대 그랜저',
};
const asset: VehicleAsset = {
  ...meta, id: 'va_1', vehicleModelId: 'vm_1', status: 'AVAILABLE',
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
      deposit: { amount: 3500000, currency: 'KRW' }, depositState: 'KNOWN', mileageLimitKmPerYear: 30000 },
    { termKey: '36_2만', termMonths: 36, monthlyRent: { amount: 650000, currency: 'KRW' },
      deposit: { amount: 2500000, currency: 'KRW' }, depositState: 'KNOWN', mileageLimitKmPerYear: 20000 },
  ],
};
const policy: Policy = {
  ...meta, id: 'policy_1', kind: 'OTHER', version: '1',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  facts: {
    default_term_months: 36,
    annual_mileage: 20000,
    basic_driver_age: 26,
    insurance_included: true,
  },
};

describe('product condition preview', () => {
  it('shows ERP default price only after applying explicit default conditions', () => {
    const view = buildCommercialProductView({ product, vehicleModel: model, vehicleAsset: asset, offer, policy });
    expect(view.conditionProfile.defaults).toEqual({
      termMonths: 36,
      mileageKmPerYear: 20000,
      driverAge: 26,
      options: {},
    });
    expect(view.preview).toMatchObject({
      status: 'READY',
      basisTermKey: '36_2만',
      monthlyRent: { amount: 650000, currency: 'KRW' },
      deposit: { state: 'KNOWN', amount: { amount: 2500000, currency: 'KRW' } },
    });
  });

  it('recomputes the product result when period or mileage selection changes', () => {
    expect(evaluateProductConditions(offer, policy, {
      termMonths: 24, mileageKmPerYear: 30000, driverAge: 26, options: {},
    })).toMatchObject({
      status: 'READY',
      basisTermKey: '24_3만',
      monthlyRent: { amount: 760000, currency: 'KRW' },
      deposit: { state: 'KNOWN', amount: { amount: 3500000, currency: 'KRW' } },
    });
  });

  it('does not show a false final price when a changed age needs an untyped adjustment rule', () => {
    const result = evaluateProductConditions(offer, policy, {
      termMonths: 24, mileageKmPerYear: 20000, driverAge: 21, options: {},
    });
    expect(result.status).toBe('NEEDS_DECISION');
    expect(result.decisions).toContain('DRIVER_AGE_PRICE_RULE_REQUIRED');
    expect(result).not.toHaveProperty('monthlyRent');
    expect(result).not.toHaveProperty('deposit');
  });

  it('requires a default term policy when more than one duration exists', () => {
    const noDefaultTerm = { ...policy, facts: { annual_mileage: 20000, basic_driver_age: 26 } };
    const view = buildCommercialProductView({
      product, vehicleModel: model, vehicleAsset: asset, offer, policy: noDefaultTerm,
    });
    expect(view.preview.status).toBe('NEEDS_DECISION');
    expect(view.review.decisions).toContain('DEFAULT_TERM_REQUIRED');
  });

  it('keeps raw basis rows separate from the final preview result', () => {
    const view = buildCommercialProductView({ product, vehicleModel: model, vehicleAsset: asset, offer, policy });
    expect(view.pricingBasis).toHaveLength(3);
    expect(view.preview.basisTermKey).toBe('36_2만');
    expect(view.pricingBasis.find((row) => row.termKey === '24_2만')?.monthlyRent.amount).toBe(700000);
  });
});
