import { describe, expect, it } from 'vitest';
import { SOURCE_FRESHNESS_MINUTES, evaluateSourceFreshness, freshnessClassOf, stateObservedAtMs } from '../src/domain/source-freshness.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const F05 = new Set(['RP021', 'RP008']);
const min = (m: number) => NOW - m * 60_000;

describe('source freshness policy', () => {
  it('classifies suppliers', () => {
    expect(freshnessClassOf('RP004', F05)).toBe('AICA_SHEET');
    expect(freshnessClassOf('RP031', F05)).toBe('IANCAR_ONE');
    expect(freshnessClassOf('RP021', F05)).toBe('F05_SHEET');
    expect(freshnessClassOf('RP012', F05)).toBe('OTHER');
    expect(freshnessClassOf(null, F05)).toBe('OTHER');
  });

  it('uses the latest valid observation and ignores nothing else', () => {
    expect(stateObservedAtMs({ _var_polled_at: min(30), _direct_ingest_at: min(5) })).toBe(min(5));
    expect(stateObservedAtMs({ _var_polled_at: 'x' })).toBeNull();
    expect(stateObservedAtMs({ updated_at: min(1), _mirror_at: min(1) })).toBeNull();
  });

  it('is fresh / warn / hold by per-source age', () => {
    const f05 = (m: number) => evaluateSourceFreshness({ provider_company_code: 'RP021', _var_polled_at: min(m) }, NOW, F05);
    expect(f05(2).state).toBe('FRESH');
    expect(f05(7).state).toBe('WARN'); expect(f05(7).sellable).toBe(true);
    expect(f05(11)).toMatchObject({ state: 'HOLD', sellable: false });
    const ian = (m: number) => evaluateSourceFreshness({ provider_company_code: 'RP031', _direct_ingest_at: min(m) }, NOW, F05);
    expect(ian(44).state).toBe('FRESH'); expect(ian(50).state).toBe('WARN'); expect(ian(61).state).toBe('HOLD');
    expect(evaluateSourceFreshness({ provider_company_code: 'RP004', _var_polled_at: min(6) }, NOW, F05).state).toBe('HOLD');
    expect(evaluateSourceFreshness({ provider_company_code: 'RP012', _var_polled_at: min(31) }, NOW, F05).state).toBe('HOLD');
  });

  it('never extends validity: unknown or future observation is not sellable', () => {
    expect(evaluateSourceFreshness({ provider_company_code: 'RP021' }, NOW, F05)).toMatchObject({ state: 'UNKNOWN', sellable: false, validUntil: null });
    expect(evaluateSourceFreshness({ provider_company_code: 'RP021', _var_polled_at: NOW + 3_600_000 }, NOW, F05).state).toBe('UNKNOWN');
  });

  it('valid_until is observation plus the hold age', () => {
    const verdict = evaluateSourceFreshness({ provider_company_code: 'RP021', _var_polled_at: min(3) }, NOW, F05);
    expect(Date.parse(verdict.validUntil!)).toBe(min(3) + SOURCE_FRESHNESS_MINUTES.F05_SHEET.hold * 60_000);
  });
});
