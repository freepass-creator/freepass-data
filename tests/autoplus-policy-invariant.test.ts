import { describe, expect, it } from 'vitest';
import { assertAutoplusPolicyInvariant } from '../src/domain/autoplus-policy-invariant.js';

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
