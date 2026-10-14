import { describe, expect, it } from 'vitest';
import { calculatedDeposit, makerOrigin } from '../src/domain/calculated-deposit.js';
import { planSourceCycle } from '../src/application/source-cycle.js';
import type { SourceAmount, SourceProductRecord } from '../src/domain/source-engine.js';
import type { CycleProduct } from '../src/ports/source-cycle.js';

const OBSERVED = '2026-10-14T06:00:00.000Z';
const now = Date.parse('2026-10-14T06:05:00.000Z');
const rec = (plate: string, maker: string | null, deposit: SourceAmount = { state: 'UNKNOWN', value: null }, rent = 500000): SourceProductRecord => ({
  sourceId: 'RP012', uid: plate, plate, vehicleText: 'x', status: { raw: '출고가능', saleAvailable: true }, observedAt: OBSERVED,
  raw: { source: 'sonogong-partner-api', ...(maker ? { maker_hint: maker } : {}) }, vehicleHold: [],
  terms: [{ months: 36, monthlyRent: { state: 'KNOWN', value: rent }, deposit, mileage: null, raw: {} }] });
const cfg = { sourceId: 'RP012', family: 'OTHER' as const, maxDowngradeRatio: 0.5 };
const ev = (records: SourceProductRecord[]) => ({ records, complete: true, observedAt: OBSERVED, heldCount: 0 });

describe('보증금 계산값(국산 ×2·수입 ×3, CALCULATED)', () => {
  it('classifies makers conservatively and never guesses an unknown maker', () => {
    expect(makerOrigin('현대')).toBe('DOMESTIC'); expect(makerOrigin('현대자동차')).toBe('DOMESTIC'); expect(makerOrigin('기아')).toBe('DOMESTIC');
    expect(makerOrigin('르노코리아')).toBe('DOMESTIC'); expect(makerOrigin('KGM')).toBe('DOMESTIC');
    expect(makerOrigin('BMW')).toBe('IMPORT'); expect(makerOrigin('메르세데스-벤츠')).toBe('IMPORT'); expect(makerOrigin('테슬라')).toBe('IMPORT');
    expect(makerOrigin('')).toBeNull(); expect(makerOrigin(null)).toBeNull(); expect(makerOrigin('알수없는브랜드')).toBeNull();
    expect(calculatedDeposit(500000, '현대')).toBe(1_000_000);
    expect(calculatedDeposit(500000, 'BMW')).toBe(1_500_000);
    expect(calculatedDeposit(500000, '알수없는브랜드')).toBeNull();
    expect(calculatedDeposit(0, '현대')).toBeNull(); expect(calculatedDeposit(null, '현대')).toBeNull();
  });

  it('fills only UNKNOWN deposits, marks them calculated, and lets a source value win', () => {
    const calc = planSourceCycle(cfg, ev([rec('12가1001', '현대'), rec('12가1002', 'BMW'), rec('12가1003', null)]), { products: [], complete: true }, now).plan;
    const by = Object.fromEntries(calc.entries.map(e => [e.after.record.plate, e.after.record.terms[0]!]));
    expect(by['12가1001']!.deposit).toEqual({ state: 'KNOWN', value: 1_000_000 });
    expect(by['12가1001']!.raw).toMatchObject({ deposit_calculated: true });
    expect(by['12가1002']!.deposit).toEqual({ state: 'KNOWN', value: 1_500_000 });
    expect(by['12가1003']!.deposit).toEqual({ state: 'UNKNOWN', value: null });          // 제조사를 모르면 계산하지 않는다
    expect(calc.warnings).toContain('DEPOSIT_CALCULATED:2');
    const real = planSourceCycle(cfg, ev([rec('12가1004', '현대', { state: 'KNOWN', value: 3_000_000 })]), { products: [], complete: true }, now).plan;
    expect(real.entries[0]!.after.record.terms[0]!.deposit).toEqual({ state: 'KNOWN', value: 3_000_000 });
    expect(real.entries[0]!.after.record.terms[0]!.raw.deposit_calculated).toBeUndefined();
  });

  it('recalculates when the rent changes (a calculated deposit is not preserved as if it were a source value)', () => {
    const first = planSourceCycle(cfg, ev([rec('12가1001', '현대')]), { products: [], complete: true }, now).plan.entries[0]!.after;
    const stored: CycleProduct = { ...first, listable: true, record: { ...first.record, observedAt: '2026-10-14T05:00:00.000Z' } };
    const second = planSourceCycle(cfg, ev([rec('12가1001', '현대', { state: 'UNKNOWN', value: null }, 600000)]), { products: [stored], complete: true }, now).plan;
    expect(second.entries[0]!.after.record.terms[0]!.deposit).toEqual({ state: 'KNOWN', value: 1_200_000 });
  });

  it('a previously real (source) deposit is still preserved when the source goes UNKNOWN, and is not overwritten by a calculation', () => {
    const real = rec('12가1005', '현대', { state: 'KNOWN', value: 3_000_000 });
    const stored: CycleProduct = { record: { ...real, observedAt: '2026-10-14T05:00:00.000Z' }, listable: true, locked_by_contract: false, publication_withdrawal: null, publication_withdrawal_prior: null };
    const plan = planSourceCycle(cfg, ev([rec('12가1005', '현대', { state: 'UNKNOWN', value: null }, 500000)]), { products: [stored], complete: true }, now).plan;
    expect(plan.entries).toHaveLength(0);                       // 보존되어 변경 없음
  });
});
