import { describe, expect, it } from 'vitest';
import { fiveColumnRows, fiveColumnLine } from '../src/application/source-five-column-report.js';

const beat = (source: string, reconciliation: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ source, failures: 0, lastCompleteAt: '2026-10-14T09:00:00.000Z', ...(reconciliation ? { reconciliation } : {}), ...extra });
const recon = (over: Record<string, unknown> = {}) => ({ sourceSellable: 30, registeredCount: 30, dispatchableExposedCount: 27, contractMarkedExposedCount: 3,
  notSellableEnrolledCount: 11, infoIncompleteCount: 0, pureNewCount: 0, missingCount: 3, missingLockedCount: 3, mismatchCount: 0, duplicateDocCount: 0,
  dispatchableGap: 0, sourceDispatchableCount: 27, ...over });

describe('5칸 지표 보고', () => {
  it('takes the last line per source and reads the five figures with the match verdict (locked MISSING allowed)', () => {
    const rows = fiveColumnRows([beat('RP021', recon({ sourceSellable: 1 })), beat('RP021', recon()), beat('RP016', recon({ missingCount: 1, missingLockedCount: 1 }))]);
    expect(rows.map(r => r.source)).toEqual(['RP016', 'RP021']);
    expect(rows[1]).toMatchObject({ sellable: 30, registered: 30, dispatchableExposed: 27, contractMarked: 3, notSellableEnrolled: 11, matched: true });
    expect(fiveColumnLine(rows[1]!)).toContain('원천 판매가능 30(출고가능 27) · 상품 30 · 출고가능 노출 27 · 계약중·잠금 3 · 판매불가 편입 11');
  });

  it('flags a gap when the dispatchable gap, pure NEW, unlocked MISSING or a mismatch is non-zero', () => {
    const rows = fiveColumnRows([
      beat('A', recon({ dispatchableGap: 2 })), beat('B', recon({ pureNewCount: 1 })), beat('C', recon({ missingCount: 4, missingLockedCount: 3 })),
      beat('D', recon({ mismatchCount: 1 })), beat('E', recon({ duplicateDocCount: 1 }))]);
    expect(rows.map(r => [r.source, r.matched])).toEqual([['A', false], ['B', false], ['C', false], ['D', false], ['E', false]]);
  });

  it('never guesses: a source without reconciliation shows dashes and a null verdict, and held reasons carry through', () => {
    const rows = fiveColumnRows([beat('RP012', null, { heldReasons: { CONTRACT_LOCKED: 2 } }), '이상한 줄', '']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'RP012', sellable: null, matched: null, heldReasons: { CONTRACT_LOCKED: 2 } });
    expect(fiveColumnLine(rows[0]!)).toContain('지표 없음');
    expect(fiveColumnLine(rows[0]!)).toContain('원천 판매가능 -');
  });
});
