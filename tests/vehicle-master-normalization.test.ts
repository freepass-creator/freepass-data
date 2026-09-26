import { describe, expect, it } from 'vitest';
import {
  canonicalPowertrainIdentity,
  canonicalTrimIdentity,
  inferPowertrainFuelType,
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
