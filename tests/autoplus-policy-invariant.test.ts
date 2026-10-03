import { describe, expect, it } from 'vitest';
import {
  assertAutoplusPolicyInvariant,
  assertAutoplusProductSet,
  AUTOPLUS_EXPECTED_ACTIVE_PRODUCT_COUNT,
  AUTOPLUS_POLICY_REPAIR_APPLIED_RUN_ID,
  assertAutoplusPolicyRepairRunnable,
} from '../src/domain/autoplus-policy-invariant.js';

describe('RP023 one-time policy repair', () => {
  it('stays retired after the recorded production run', () => {
    expect(() => assertAutoplusPolicyRepairRunnable()).toThrow('AUTOPLUS_POLICY_REPAIR_RETIRED');
    expect(() => assertAutoplusPolicyRepairRunnable()).toThrow(AUTOPLUS_POLICY_REPAIR_APPLIED_RUN_ID);
  });

  it('refuses before resolving a Firebase target', async () => {
    const { applyAutoplusPolicyRepair } = await import('../src/infra/autoplus-policy-repair-firestore.js');
    await expect(applyAutoplusPolicyRepair()).rejects.toThrow('AUTOPLUS_POLICY_REPAIR_RETIRED');
  });
});

const valid = {
  basic_driver_age: '만 26세 이상',
  driver_age_lowering: '불가',
  annual_mileage: '연 30,000km',
  insurance_included: '보험료 포함',
};

describe('RP023 policy invariant', () => {
  it('accepts the approved base-rent conditions', () => {
    expect(() => assertAutoplusPolicyInvariant(valid)).not.toThrow();
  });

  it.each([
    [{ ...valid, driver_age_lowering: '만21세' }, 'driver_age_lowering'],
    [{ ...valid, age_lowering_cost: '10만원' }, 'age_lowering_cost'],
    [{ ...valid, annual_mileage: '' }, 'annual_mileage'],
    [{ ...valid, insurance_included: '별도' }, 'insurance_included'],
  ])('rejects a contradictory policy', (facts, message) => {
    expect(() => assertAutoplusPolicyInvariant(facts)).toThrow(message);
  });
});

describe('RP023 product policy-link scope', () => {
  const products = Array.from({ length: AUTOPLUS_EXPECTED_ACTIVE_PRODUCT_COUNT }, (_, index) => ({
    id: `product-${index}`,
    data: { provider_company_code: 'RP023', product_type: '오플구독' },
  }));

  it('accepts the exact active AutoPlus product set', () => {
    expect(() => assertAutoplusProductSet(products)).not.toThrow();
  });

  it('fails closed when the count or product type drifts', () => {
    expect(() => assertAutoplusProductSet(products.slice(1))).toThrow('Expected 155');
    expect(() => assertAutoplusProductSet([
      ...products.slice(0, -1),
      { id: 'wrong-type', data: { provider_company_code: 'RP023', product_type: '렌트' } },
    ])).toThrow('product_type');
  });
});
