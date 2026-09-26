import { describe, expect, it } from 'vitest';
import {
  canonicalDrivetrain,
  canonicalPowertrainIdentity,
  canonicalSeatCount,
  canonicalTrimIdentity,
  canonicalVariantIdentity,
  inferPowertrainFuelType,
  inferVariantFacts,
} from '../src/domain/vehicle-master-normalization.js';

describe('vehicle master powertrain normalization', () => {
  it('unifies safe fuel-name aliases without inventing specification equivalence', () => {
    expect(canonicalPowertrainIdentity('1.6 HEV'))
      .toBe(canonicalPowertrainIdentity('1.6 하이브리드'));
    expect(canonicalPowertrainIdentity('2.5 gasoline turbo'))
      .toBe(canonicalPowertrainIdentity('2.5 가솔린 turbo'));
    expect(canonicalPowertrainIdentity('EV'))
      .toBe(canonicalPowertrainIdentity('전기'));
  });

  it('normalizes trim spacing, punctuation and latin case without translating names', () => {
    expect(canonicalTrimIdentity('Noblesse'))
      .toBe(canonicalTrimIdentity('NOBLESSE'));
    expect(canonicalTrimIdentity('노 블레스'))
      .toBe(canonicalTrimIdentity('노-블레스'));
    expect(canonicalTrimIdentity('Noblesse'))
      .not.toBe(canonicalTrimIdentity('노블레스'));
  });

  it('normalizes only explicit drivetrain aliases and preserves 2WD ambiguity', () => {
    expect(canonicalDrivetrain('awd')).toBe('AWD');
    expect(canonicalDrivetrain('전륜')).toBe('FWD');
    expect(canonicalDrivetrain('rear wheel drive')).toBe('RWD');
    expect(canonicalDrivetrain('2WD')).toBe('2WD');
    expect(canonicalDrivetrain('사륜')).toBeNull();
  });

  it('normalizes variant facts deterministically without guessing missing values', () => {
    expect(canonicalSeatCount(5)).toBe(5);
    expect(canonicalSeatCount(0)).toBeNull();
    expect(canonicalSeatCount(5.5)).toBeNull();
    expect(canonicalVariantIdentity({ seats: 5, drivetrain: 'awd' }))
      .toEqual({ seats: 5, drivetrain: 'AWD' });
    expect(inferVariantFacts('AWD 5seat')).toEqual({ seats: 5, drivetrain: 'AWD' });
    expect(inferVariantFacts('5인승 전륜')).toEqual({ seats: 5, drivetrain: 'FWD' });
    expect(inferVariantFacts('프리미엄')).toEqual({ seats: null, drivetrain: null });
  });

  it('keeps materially different powertrain descriptors distinct', () => {
    expect(canonicalPowertrainIdentity('1.6 하이브리드'))
      .not.toBe(canonicalPowertrainIdentity('1.6 터보 하이브리드'));
    expect(canonicalPowertrainIdentity('1.6 HEV'))
      .not.toBe(canonicalPowertrainIdentity('1.6 PHEV'));
  });

  it('infers only explicit fuel semantics from the powertrain label', () => {
    expect(inferPowertrainFuelType('1.6 터보 하이브리드')).toBe('HYBRID');
    expect(inferPowertrainFuelType('EV AWD')).toBe('ELECTRIC');
    expect(inferPowertrainFuelType('2.2 디젤')).toBe('DIESEL');
    expect(inferPowertrainFuelType('2.5 gasoline turbo')).toBe('GASOLINE');
    expect(inferPowertrainFuelType('3.5 LPG')).toBe('LPG');
    expect(inferPowertrainFuelType('2.5 터보')).toBeNull();
  });
});
