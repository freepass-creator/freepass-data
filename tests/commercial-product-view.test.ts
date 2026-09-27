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
    max_annual_mileage: 40000,
    mileage_upcharge_per_10000km: '대여료의 10%',
    basic_driver_age: '만 26세 이상',
    driver_age_lowering: '만 21세까지',
    driver_age_upper_limit: '만 70세 이하',
    age_lowering_cost: '10만원',
    license_period: '1년 이상',
    personal_driver_scope: '본인+직계가족',
    business_driver_scope: '임직원',
    additional_driver_allowance_count: '1인까지',
    additional_driver_cost: '5만원',
    insurance_included: '보험료 포함',
    maintenance_service: '미제공',
  },
};

describe('product condition preview', () => {
  it('attaches the priced condition envelope to every basis rent', () => {
    const view = buildCommercialProductView({ product, vehicleModel: model, vehicleAsset: asset, offer, policy });
    expect(view.pricingBasis.find((row) => row.termKey === '36_2만')?.conditionScope).toEqual({
      termMonths: 36,
      mileage: { pricedUpToKmPerYear: 20000, maxSelectableKmPerYear: 40000 },
      driverAge: { includedFromAge: 26, lowerableToAge: 21, allowedToAge: 70 },
      drivers: {
        maxAdditionalDriverCount: 1,
        personalScope: '본인+직계가족',
        businessScope: '임직원',
      },
      licensePeriod: '1년 이상',
      insuranceIncluded: '보험료 포함',
      maintenanceService: '미제공',
    });
  });

  it('exposes the three policy inputs that directly modify monthly rent', () => {
    const view = buildCommercialProductView({ product, vehicleModel: model, vehicleAsset: asset, offer, policy });
    expect(view.conditionProfile.monthlyRentModifiers).toEqual([
      {
        key: 'mileage_upcharge_per_10000km', dimension: 'MILEAGE', target: 'MONTHLY_RENT',
        cadence: 'MONTHLY', unit: 'PER_10000KM', rawValue: '대여료의 10%',
      },
      {
        key: 'age_lowering_cost', dimension: 'DRIVER_AGE', target: 'MONTHLY_RENT',
        cadence: 'MONTHLY', unit: 'ON_AGE_LOWERING', rawValue: '10만원',
      },
      {
        key: 'additional_driver_cost', dimension: 'ADDITIONAL_DRIVER', target: 'MONTHLY_RENT',
        cadence: 'MONTHLY', unit: 'PER_ADDITIONAL_DRIVER', rawValue: '5만원',
      },
    ]);
  });

  it('shows ERP default price only after applying explicit default conditions', () => {
    const view = buildCommercialProductView({ product, vehicleModel: model, vehicleAsset: asset, offer, policy });
    expect(view.conditionProfile.defaults).toEqual({
      termMonths: 36,
      mileageKmPerYear: 20000,
      driverAge: 26,
      additionalDriverCount: 0,
      options: {},
    });
    expect(view.preview).toMatchObject({
      status: 'READY',
      basisTermKey: '36_2만',
      monthlyRent: { amount: 650000, currency: 'KRW' },
      deposit: { state: 'KNOWN', amount: { amount: 2500000, currency: 'KRW' } },
    });
  });

  it('keeps the same basis price for an older driver inside the priced age range', () => {
    const result = evaluateProductConditions(offer, policy, {
      termMonths: 24, mileageKmPerYear: 20000, driverAge: 40, additionalDriverCount: 0, options: {},
    });
    expect(result.status).toBe('READY');
    expect(result.monthlyRent?.amount).toBe(700000);
  });

  it('requires a price adjustment when age is lowered within the allowed range', () => {
    const result = evaluateProductConditions(offer, policy, {
      termMonths: 24, mileageKmPerYear: 20000, driverAge: 21, additionalDriverCount: 0, options: {},
    });
    expect(result.status).toBe('NEEDS_DECISION');
    expect(result.decisions).toContain('DRIVER_AGE_PRICE_ADJUSTMENT_REQUIRED');
    expect(result).not.toHaveProperty('monthlyRent');
  });

  it('requires an additional-driver adjustment inside the allowed count', () => {
    const result = evaluateProductConditions(offer, policy, {
      termMonths: 24, mileageKmPerYear: 20000, driverAge: 26, additionalDriverCount: 1, options: {},
    });
    expect(result.status).toBe('NEEDS_DECISION');
    expect(result.decisions).toContain('ADDITIONAL_DRIVER_PRICE_ADJUSTMENT_REQUIRED');
  });

  it('rejects selections outside policy age or driver count bounds', () => {
    expect(evaluateProductConditions(offer, policy, {
      termMonths: 24, mileageKmPerYear: 20000, driverAge: 71, additionalDriverCount: 0, options: {},
    }).invalidFacts).toContain('DRIVER_AGE_ABOVE_ALLOWED_RANGE');
    expect(evaluateProductConditions(offer, policy, {
      termMonths: 24, mileageKmPerYear: 20000, driverAge: 26, additionalDriverCount: 2, options: {},
    }).invalidFacts).toContain('ADDITIONAL_DRIVER_COUNT_EXCEEDS_POLICY');
  });

  it('uses an explicit mileage price row when one exists', () => {
    expect(evaluateProductConditions(offer, policy, {
      termMonths: 24, mileageKmPerYear: 30000, driverAge: 26, additionalDriverCount: 0, options: {},
    })).toMatchObject({
      status: 'READY',
      basisTermKey: '24_3만',
      monthlyRent: { amount: 760000, currency: 'KRW' },
    });
  });

  it('requires policy adjustment when requested mileage has no explicit row', () => {
    const result = evaluateProductConditions(offer, policy, {
      termMonths: 36, mileageKmPerYear: 30000, driverAge: 26, additionalDriverCount: 0, options: {},
    });
    expect(result.status).toBe('NEEDS_DECISION');
    expect(result.decisions).toContain('MILEAGE_PRICE_ADJUSTMENT_REQUIRED');
  });
});
