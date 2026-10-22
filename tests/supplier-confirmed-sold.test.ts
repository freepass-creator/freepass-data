import { describe, expect, it } from 'vitest';
import { planSourceCycle } from '../src/application/source-cycle.js';
import type { CycleProduct } from '../src/ports/source-cycle.js';
import type { SourceProductRecord } from '../src/domain/source-engine.js';

// 공급사 확인 판매완료(대표 2026-10-22): 사람이 내린 철회는 원천이 «그대로 판매 가능»인 동안만 지킨다.
const time = '2026-10-22T07:00:00.000Z', stored = '2026-10-22T03:07:27.866Z';
const rec = (uid: string, raw: string, sale: boolean, observedAt = time): SourceProductRecord => ({ sourceId: 'RP999', uid, plate: uid, vehicleText: '합성',
  status: { raw, saleAvailable: sale }, observedAt, raw: {}, vehicleHold: [],
  terms: [{ months: 12, monthlyRent: { state: 'KNOWN', value: 500000 }, deposit: { state: 'KNOWN', value: 700000 }, mileage: '20000km/year', raw: {} }] });
const withdrawn = (uid: string, mark: string | null): CycleProduct => ({ record: rec(uid, '배차문의', true, stored), listable: false, locked_by_contract: false,
  publication_withdrawal: { reason: 'SUPPLIER_CONFIRMED_SOLD', source: 'RP999', observedAt: time, deleteAuthorized: false }, publication_withdrawal_prior: null,
  ...(mark ? { supplierConfirmedSold: { recordObservedAt: mark } } : {}) });
const run = (product: CycleProduct, record: SourceProductRecord) => planSourceCycle({ sourceId: 'RP999', family: 'OTHER', maxDowngradeRatio: 1 },
  { records: [record], observedAt: time, heldCount: 0, complete: true }, { products: [product], complete: true }, Date.parse(time) + 60_000);

describe('공급사 확인 판매완료 표식', () => {
  it('원천이 표식 때와 같은 판매 가능 값이면 재노출하지 않는다', () => {
    const plan = run(withdrawn('A', stored), rec('A', '배차문의', true)).plan;
    expect(plan.entries).toEqual([]);
    expect(plan.warnings).toContain('SUPPLIER_CONFIRMED_SOLD_HELD');
  });
  it('표식이 없으면 종전처럼 재노출한다', () => {
    expect(run(withdrawn('A', null), rec('A', '배차문의', true)).plan.entries.map(e => e.kind)).toEqual(['REEXPOSE']);
  });
  it('엔진이 그 기록을 다시 쓴 뒤(관측 시각이 달라짐)에는 표식이 효력을 잃는다', () => {
    expect(run(withdrawn('A', '2026-10-21T00:00:00.000Z'), rec('A', '배차문의', true)).plan.entries.map(e => e.kind)).toEqual(['REEXPOSE']);
  });
  it('원천 상태 문구가 다른 판매 가능 값으로 바뀌면 보통 경로(재노출)', () => {
    expect(run(withdrawn('A', stored), rec('A', '출고가능', true)).plan.entries.map(e => e.kind)).toEqual(['REEXPOSE']);
  });
  it('원천이 판매 불가(판매완료)로 바뀌면 표식 경로가 아니라 보통 경로이고 재노출은 없다', () => {
    const plan = run(withdrawn('A', stored), rec('A', '판매완료', false)).plan;
    expect(plan.entries.map(e => e.kind)).not.toContain('REEXPOSE');
    expect(plan.warnings).not.toContain('SUPPLIER_CONFIRMED_SOLD_HELD');
  });
});
