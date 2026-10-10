import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertAutoplusPolicyInvariant,
  assertAutoplusProductSet,
  AUTOPLUS_EXPECTED_ACTIVE_PRODUCT_COUNT,
  AUTOPLUS_POLICY_REPAIR_APPLIED_RUN_ID,
} from '../src/domain/autoplus-policy-invariant.js';

describe('RP023 one-time policy repair retirement', () => {
  it('has no executable repair entry or adapter and preserves the applied-run identity', () => {
    const root = new URL('../', import.meta.url);
    expect(existsSync(new URL('src/jobs/apply-autoplus-policy-repair.ts', root))).toBe(false);
    expect(existsSync(new URL('src/infra/autoplus-policy-repair-firestore.ts', root))).toBe(false);
    const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
    expect(manifest.scripts).not.toHaveProperty('repair:autoplus-policy');
    expect(AUTOPLUS_POLICY_REPAIR_APPLIED_RUN_ID).toBe('2026-09-29T04-44-30-502Z-42019aec-9cd2-4fa9-85bf-76c6b1542a68');
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
