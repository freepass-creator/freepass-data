import { describe, expect, it } from 'vitest';
import { reconcileSource } from '../src/application/source-reconciliation.js';
import type { SourceProductRecord } from '../src/domain/source-engine.js';
import type { CycleProduct } from '../src/ports/source-cycle.js';

const rec = (plate: string, sale: boolean, rent = 500000): SourceProductRecord => ({
  sourceId: 'RP012', uid: `U-${plate}`, plate, vehicleText: 'x', status: { raw: sale ? '출고가능' : '출고불가', saleAvailable: sale },
  terms: [{ months: 36, monthlyRent: { state: 'KNOWN', value: rent }, deposit: { state: 'ZERO', value: 0 }, mileage: null, raw: {} }], observedAt: '2026-10-14T00:00:00.000Z', raw: {}, vehicleHold: [] });
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
  it('separates MISSING documents that are contract-locked (policy hold) from real gaps', () => {
    const locked = doc(rec('12가1001', true), true); locked.locked_by_contract = true;
    const r = reconcileSource([rec('12가1001', false)], [locked, doc(rec('12가1002', true), true)]);
    expect(r).toMatchObject({ missingCount: 2, missingLockedCount: 1, matched: false, matchedExceptLocked: false });
    expect(reconcileSource([rec('12가1001', false)], [locked])).toMatchObject({ missingLockedCount: 1, matched: false, matchedExceptLocked: true });
  });
  it('reports registered / exposed / info-incomplete side by side (등록 N·노출 N·정보 부족 N)', () => {
    const hidden = doc(rec('12가1002', true), false);
    hidden.publication_withdrawal = { reason: 'INFO_INCOMPLETE', source: 'RP012', observedAt: '2026-10-14T00:00:00.000Z', deleteAuthorized: false };
    const r = reconcileSource([rec('12가1001', true), rec('12가1002', true), rec('12가1003', true)], [doc(rec('12가1001', true), true), hidden]);
    expect(r).toMatchObject({ sourceSellable: 3, registeredCount: 2, exposedCount: 1, infoIncompleteCount: 1,
      newCount: 2, newHasDoc: 1, pureNewCount: 1, registeredMatched: false });
    const done = reconcileSource([rec('12가1001', true), rec('12가1002', true)], [doc(rec('12가1001', true), true), hidden]);
    expect(done).toMatchObject({ registeredCount: 2, pureNewCount: 0, registeredMatched: true, matched: false });
  });
  it('compares business values only: raw cell differences and a different UID for the same plate are not mismatches', () => {
    const source = rec('12가1001', true), stored = rec('12가1001', true);
    source.raw = { cells: ['a'], source_row: 3 }; stored.raw = { cells: ['b'], source_row: 9 };
    source.terms[0]!.raw = { shortDeposit: '' }; stored.terms[0]!.raw = { shortDeposit: '없음' };
    source.uid = 'NEW'; stored.uid = 'iancar_OLD';
    expect(reconcileSource([source], [doc(stored, true)])).toMatchObject({ same: 1, mismatchCount: 0, matched: true });
  });
  it('counts not-sellable cars brought in by the first pass as a separate fourth figure', () => {
    const soldDoc = doc(rec('12가1009', false), false);
    soldDoc.publication_withdrawal = { reason: 'SOURCE_NOT_SELLABLE', source: 'RP012', observedAt: '2026-10-14T00:00:00.000Z', deleteAuthorized: false };
    const r = reconcileSource([rec('12가1001', true), rec('12가1009', false)], [doc(rec('12가1001', true), true), soldDoc]);
    expect(r).toMatchObject({ sourceSellable: 1, registeredCount: 1, exposedCount: 1, notSellableEnrolledCount: 1, matched: true });
  });
  it('five-figure report: contract-marked exposed documents are a separate figure and excluded from the dispatchable comparison', () => {
    const locked = doc(rec('12가1003', true), true); locked.locked_by_contract = true;
    const contractSource = rec('12가1003', true); contractSource.status = { raw: '계약중', saleAvailable: true };
    const r = reconcileSource([rec('12가1001', true), rec('12가1002', true), contractSource],
      [doc(rec('12가1001', true), true), doc(rec('12가1002', true), true), locked]);
    expect(r).toMatchObject({ sourceSellable: 3, sourceDispatchableCount: 2, dispatchableExposedCount: 2, contractMarkedExposedCount: 1, dispatchableGap: 0 });
    // 잠금이 풀리지 않은 채 원천에서 출고불가가 된 차: 출고가능 노출 쪽은 어긋나지 않고 잠금 칸에만 남는다
    const only = reconcileSource([rec('12가1001', true)], [doc(rec('12가1001', true), true), locked]);
    expect(only).toMatchObject({ sourceDispatchableCount: 1, dispatchableExposedCount: 1, contractMarkedExposedCount: 1, dispatchableGap: 0 });
  });
  it('a contract-locked document that differs from the source is a lock override, not a value mismatch', () => {
    const lockedDoc = doc(rec('12가1005', true, 500000), true); lockedDoc.locked_by_contract = true;
    const r = reconcileSource([rec('12가1005', true, 700000), rec('12가1006', true, 700000)],
      [lockedDoc, doc(rec('12가1006', true, 500000), true)]);
    expect(r).toMatchObject({ lockOverrideCount: 1, mismatchCount: 1 });
    expect(r.mismatchLast4).toEqual(['1006']);
  });
  it('is matched only when sets and values are identical', () => {
    const r = reconcileSource([rec('12가1001', true)], [doc(rec('12가1001', true), true)]);
    expect(r.matched).toBe(true);
  });
  it('treats a source-not-sellable vehicle that ERP5 still exposes as MISSING', () => {
    const r = reconcileSource([rec('12가1001', false)], [doc(rec('12가1001', true), true)]);
    expect(r).toMatchObject({ sourceSellable: 0, erpSellable: 1, missingCount: 1, matched: false });
  });
  it('explains a non-zero dispatch gap by reason code, and the reasons always add up to the gap', () => {
    const contract = (p: string) => { const r = rec(p, true); r.status = { raw: '계약중', saleAvailable: true }; return r; };
    const withdrawn = (r: SourceProductRecord, reason: string) => ({ ...doc(r, false), publication_withdrawal: { reason } } as unknown as CycleProduct);
    const locked = { ...doc(rec('12가1005', true), true), locked_by_contract: true } as CycleProduct;
    const source = ['12가1001', '12가1002', '12가1003', '12가1004', '12가1005', '12가1006'].map(p => rec(p, true));
    source.push(contract('12가1007'));
    const erp = [doc(rec('12가1001', true), true), withdrawn(rec('12가1002', true), 'INFO_INCOMPLETE'),
      withdrawn(rec('12가1003', false), 'SOURCE_NOT_SELLABLE'), doc(rec('12가1004', true), false), locked,
      doc(rec('12가1007', true), true), doc(rec('12가1008', true), true)];
    const r = reconcileSource(source, erp);
    // 원천 출고가능 6(1001~1006) − 출고가능 노출 3(1001·1007·1008) = 3
    expect(r.dispatchableGap).toBe(3);
    expect(r.dispatchGapReasons).toEqual({ SOURCE_ONLY_NO_DOC: 1, SOURCE_ONLY_INFO_INCOMPLETE: 1, SOURCE_ONLY_NOT_SELLABLE_STALE: 1,
      SOURCE_ONLY_NOT_LISTABLE: 1, SOURCE_ONLY_LOCKED_EXPOSED: 1, ERP_ONLY_NOT_IN_SOURCE: 1, ERP_ONLY_SOURCE_CONTRACT: 1 });
    expect(r.dispatchGapExplained).toBe(true);
    const clean = reconcileSource([rec('12가1001', true)], [doc(rec('12가1001', true), true)]);
    expect(clean).toMatchObject({ dispatchableGap: 0, dispatchGapReasons: {}, dispatchGapExplained: true });
  });
});
