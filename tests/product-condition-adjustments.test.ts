import { describe, expect, it } from 'vitest';
import { applyProductConditionAdjustmentRules } from '../src/application/apply-product-condition-adjustments.js';
import type { ProductConditionAdjustmentRule } from '../src/domain/pricing-condition-model.js';

const won = (amount: number) => ({ amount, currency: 'KRW' as const });

describe('generic product-condition adjustment rules', () => {
  it('can price an insurance coverage upgrade without changing the engine', () => {
    const rules: ProductConditionAdjustmentRule[] = [{
      ruleId: 'property-2eok',
      dimensionKey: 'property_compensation_limit',
      target: 'MONTHLY_RENT',
      when: [{ dimensionKey: 'property_compensation_limit', op: 'EQ', value: '2억원' }],
      operation: { kind: 'ADD_FIXED', amount: won(20000) },
      priority: 100,
      source: { policyKey: 'property_compensation_limit' },
    }];
    const out = applyProductConditionAdjustmentRules({
      basisMonthlyRent: won(650000),
      basisDeposit: won(2500000),
      conditions: { property_compensation_limit: '2억원' },
      rules,
    });
    expect(out.monthlyRent.amount).toBe(670000);
    expect(out.deposit?.amount).toBe(2500000);
    expect(out.appliedRules.map((x) => x.ruleId)).toEqual(['property-2eok']);
  });

  it('can combine mileage, age and additional-driver changes', () => {
    const rules: ProductConditionAdjustmentRule[] = [
      {
        ruleId: 'mileage-plus',
        dimensionKey: 'annual_mileage_km',
        target: 'MONTHLY_RENT',
        when: [{ dimensionKey: 'annual_mileage_km', op: 'GT', value: 20000 }],
        operation: { kind: 'ADD_PER_UNIT', unit: 10000, fromValue: 20000, amount: won(100000) },
        priority: 10,
        source: { policyKey: 'mileage_upcharge_per_10000km' },
      },
      {
        ruleId: 'age-21',
        dimensionKey: 'driver_age',
        target: 'MONTHLY_RENT',
        when: [{ dimensionKey: 'driver_age', op: 'LTE', value: 21 }],
        operation: { kind: 'ADD_FIXED', amount: won(100000) },
        priority: 20,
        source: { policyKey: 'age_lowering_cost' },
      },
      {
        ruleId: 'additional-driver',
        dimensionKey: 'additional_driver_count',
        target: 'MONTHLY_RENT',
        when: [{ dimensionKey: 'additional_driver_count', op: 'GTE', value: 1 }],
        operation: { kind: 'ADD_PER_UNIT', unit: 1, fromValue: 0, amount: won(50000) },
        priority: 30,
        source: { policyKey: 'additional_driver_cost' },
      },
    ];
    const out = applyProductConditionAdjustmentRules({
      basisMonthlyRent: won(650000),
      basisDeposit: won(2500000),
      conditions: { annual_mileage_km: 30000, driver_age: 21, additional_driver_count: 1 },
      rules,
    });
    expect(out.monthlyRent.amount).toBe(900000);
    expect(out.appliedRules).toHaveLength(3);
  });

  it('can recalculate deposit from the adjusted monthly rent', () => {
    const rules: ProductConditionAdjustmentRule[] = [
      {
        ruleId: 'age-21',
        dimensionKey: 'driver_age',
        target: 'MONTHLY_RENT',
        when: [{ dimensionKey: 'driver_age', op: 'LTE', value: 21 }],
        operation: { kind: 'ADD_FIXED', amount: won(100000) },
        priority: 10,
        source: { policyKey: 'age_lowering_cost' },
      },
      {
        ruleId: 'deposit-x3',
        dimensionKey: 'term_months',
        target: 'DEPOSIT',
        when: [{ dimensionKey: 'term_months', op: 'GTE', value: 36 }],
        operation: { kind: 'MULTIPLY', multiplier: 3, base: 'CURRENT_MONTHLY_RENT' },
        priority: 100,
        source: { note: 'monthly rent x3 deposit rule' },
      },
    ];
    const out = applyProductConditionAdjustmentRules({
      basisMonthlyRent: won(650000),
      basisDeposit: won(2500000),
      conditions: { driver_age: 21, term_months: 36 },
      rules,
    });
    expect(out.monthlyRent.amount).toBe(750000);
    expect(out.deposit?.amount).toBe(2250000);
  });

  it('holds a condition that requires an explicit supplier variant', () => {
    const rules: ProductConditionAdjustmentRule[] = [{
      ruleId: 'maintenance-explicit',
      dimensionKey: 'maintenance_service',
      target: 'MONTHLY_RENT',
      when: [{ dimensionKey: 'maintenance_service', op: 'EQ', value: '제공' }],
      operation: { kind: 'REQUIRE_EXPLICIT_VARIANT' },
      priority: 100,
      source: { policyKey: 'maintenance_service' },
    }];
    const out = applyProductConditionAdjustmentRules({
      basisMonthlyRent: won(650000),
      conditions: { maintenance_service: '제공' },
      rules,
    });
    expect(out.unresolvedRules).toEqual(['maintenance-explicit']);
  });
});
