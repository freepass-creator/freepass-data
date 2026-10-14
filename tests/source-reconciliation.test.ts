import { describe, expect, it } from 'vitest';
import { reconcileSource } from '../src/application/source-reconciliation.js';
import type { SourceProductRecord } from '../src/domain/source-engine.js';
import type { CycleProduct } from '../src/ports/source-cycle.js';

const rec = (plate: string, sale: boolean, rent = 500000): SourceProductRecord => ({
  sourceId: 'RP012', uid: `U-${plate}`, plate, vehicleText: 'x', status: { raw: sale ? '출고가능' : '출고불가', saleAvailable: sale },
  terms: [{ months: 36, rent, deposit: { state: 'ZERO' } } as never], observedAt: '2026-10-14T00:00:00.000Z', raw: {}, vehicleHold: [] });
const doc = (r: SourceProductRecord, listable: boolean): CycleProduct => ({ record: r, listable, locked_by_contract: false,
  publication_withdrawal: null, publication_withdrawal_prior: null } as CycleProduct);

describe('원천 ↔ ERP5 정합 보고', () => {
  it('compares vehicle-key sets, not counts: 10 sold + 10 new is not a match', () => {
    const source = ['12가1001', '12가1002', '12가1003'].map(p => rec(p, true));
    const erp = ['12가1001', '12가1002', '12가9999'].map(p => doc(rec(p, true), true));
    const r = reconcileSource(source, erp);
    expect(r).toMatchObject({ sourceSellable: 3, erpSellable: 3, same: 2, newCount: 1, missingCount: 1, mismatchCount: 0, countEqual: true, matched: false });
    expect(r.newLast4).toEqual(['1003']);
    expect(r.missingLast4).toEqual(['9999']);
    expect(JSON.stringify(r)).not.toContain('12가');
  });
  it('counts value mismatches and separates new vehicles that already have a hidden document', () => {
    const r = reconcileSource([rec('12가1001', true, 600000), rec('12가1002', true)],
      [doc(rec('12가1001', true, 500000), true), doc(rec('12가1002', true), false)]);
    expect(r).toMatchObject({ same: 1, mismatchCount: 1, mismatchLast4: ['1001'], newCount: 1, newHasDoc: 1, matched: false });
  });
  it('keys by plate, so the same car under a different UID is one vehicle, not NEW + MISSING', () => {
    const fresh = rec('12가1001', true); fresh.uid = 'NEW-UID';
    const old = rec('12가1001', true); old.uid = 'iancar_OLD';
    const r = reconcileSource([fresh], [doc(old, true)]);
    expect(r).toMatchObject({ same: 1, newCount: 0, missingCount: 0 });
  });
  it('does not count a preserved deposit (source UNKNOWN, document KNOWN) as a value mismatch', () => {
    const source = rec('12가1001', true), stored = rec('12가1001', true);
    source.terms[0]!.deposit = { state: 'UNKNOWN', value: null } as never;
    stored.terms[0]!.deposit = { state: 'KNOWN', value: 1000000 } as never;
    expect(reconcileSource([source], [doc(stored, true)])).toMatchObject({ mismatchCount: 0, matched: true });
    const changedRent = rec('12가1001', true, 700000); changedRent.terms[0]!.deposit = { state: 'UNKNOWN', value: null } as never;
    expect(reconcileSource([changedRent], [doc(stored, true)]).mismatchCount).toBe(1);   // 대여료가 다르면 여전히 불일치
  });
  it('is matched only when sets and values are identical', () => {
    const r = reconcileSource([rec('12가1001', true)], [doc(rec('12가1001', true), true)]);
    expect(r.matched).toBe(true);
  });
  it('treats a source-not-sellable vehicle that ERP5 still exposes as MISSING', () => {
    const r = reconcileSource([rec('12가1001', false)], [doc(rec('12가1001', true), true)]);
    expect(r).toMatchObject({ sourceSellable: 0, erpSellable: 1, missingCount: 1, matched: false });
  });
});
