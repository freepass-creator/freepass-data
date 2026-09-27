import { describe, expect, it } from 'vitest';
import type { Policy } from '../src/domain/catalog.js';
import {
  CONDITION_DIMENSION_SPECS,
  buildConditionDimensions,
} from '../src/application/product-condition-dimensions.js';

const meta = {
  schemaVersion: '1', revision: 1, validationStatus: 'VALID' as const,
  createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z',
  createdBy: { id: 'service:test', kind: 'SERVICE' as const },
  updatedBy: { id: 'service:test', kind: 'SERVICE' as const },
  lineageId: 'lin_test',
};

const policy: Policy = {
  ...meta,
  id: 'policy_1',
  kind: 'OTHER',
  version: '1',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  facts: {
    annual_mileage: '연 20,000km',
    basic_driver_age: '만 26세 이상',
    property_compensation_limit: '1억원',
    own_damage_min_deductible: '50만원',
    maintenance_service: '미제공',
  },
};

describe('product condition dimension registry', () => {
  it('keeps currently unpriced insurance and service choices open as price dimensions', () => {
    const keys = new Set(CONDITION_DIMENSION_SPECS.map((item) => item.key));
    for (const key of [
      'property_compensation_limit',
      'injury_compensation_limit',
      'own_damage_min_deductible',
      'own_damage_max_deductible',
      'maintenance_service',
      'roadside_assistance',
      'replacement_car',
      'settlement_type',
    ]) {
      expect(keys.has(key)).toBe(true);
    }
  });

  it('reads known defaults but does not invent unprovided selectable options or price rules', () => {
    const dimensions = buildConditionDimensions(policy);
    expect(dimensions.find((item) => item.key === 'property_compensation_limit')).toMatchObject({
      defaultValue: '1억원',
      mayAffect: ['MONTHLY_RENT', 'DEPOSIT'],
    });
    expect(dimensions.find((item) => item.key === 'maintenance_service')).toMatchObject({
      defaultValue: '미제공',
      mayAffect: ['MONTHLY_RENT', 'DEPOSIT'],
    });
    expect(dimensions.find((item) => item.key === 'property_compensation_limit')).not.toHaveProperty('options');
  });
});
