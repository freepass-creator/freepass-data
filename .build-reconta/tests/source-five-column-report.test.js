import { describe, expect, it } from 'vitest';
import { fiveColumnRows, fiveColumnLine, verdictRows } from '../src/application/source-five-column-report.js';
const beat = (source, reconciliation, extra = {}) => JSON.stringify({ source, failures: 0, lastCompleteAt: '2026-10-14T09:00:00.000Z', ...(reconciliation ? { reconciliation } : {}), ...extra });
const recon = (over = {}) => ({ sourceSellable: 30, registeredCount: 30, dispatchableExposedCount: 27, contractMarkedExposedCount: 3,
    notSellableEnrolledCount: 11, infoIncompleteCount: 0, pureNewCount: 0, missingCount: 3, missingLockedCount: 3, mismatchCount: 0, duplicateDocCount: 0,
    dispatchableGap: 0, sourceDispatchableCount: 27, ...over });
describe('5칸 지표 보고', () => {
    it('takes the last line per source and reads the five figures with the match verdict (locked MISSING allowed)', () => {
        const rows = fiveColumnRows([beat('RP021', recon({ sourceSellable: 1 })), beat('RP021', recon()), beat('RP016', recon({ missingCount: 1, missingLockedCount: 1 }))]);
        expect(rows.map(r => r.source)).toEqual(['RP016', 'RP021']);
        expect(rows[1]).toMatchObject({ sellable: 30, registered: 30, dispatchableExposed: 27, contractMarked: 3, notSellableEnrolled: 11, matched: true });
        expect(fiveColumnLine(rows[1])).toContain('원천 판매가능 30(출고가능 27) · 상품 30 · 출고가능 노출 27 · 계약중·잠금 3 · 판매불가 편입 11');
    });
    it('flags a gap when the dispatchable gap, pure NEW, unlocked MISSING or a mismatch is non-zero', () => {
        const rows = fiveColumnRows([
            beat('A', recon({ dispatchableGap: 2 })), beat('B', recon({ pureNewCount: 1 })), beat('C', recon({ missingCount: 4, missingLockedCount: 3 })),
            beat('D', recon({ mismatchCount: 1 })), beat('E', recon({ duplicateDocCount: 1 }))
        ]);
        expect(rows.map(r => [r.source, r.matched])).toEqual([['A', false], ['B', false], ['C', false], ['D', false], ['E', false]]);
    });
    it('never guesses: a source without reconciliation shows dashes and a null verdict, and held reasons carry through', () => {
        const rows = fiveColumnRows([beat('RP012', null, { heldReasons: { CONTRACT_LOCKED: 2 } }), '이상한 줄', '']);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ source: 'RP012', sellable: null, matched: null, heldReasons: { CONTRACT_LOCKED: 2 } });
        expect(fiveColumnLine(rows[0])).toContain('지표 없음');
        expect(fiveColumnLine(rows[0])).toContain('원천 판매가능 -');
    });
    it('verdict: one line per source — ✅ match, ⚠ difference with plain reasons, ❌ stopped or 3 cycles in a row', () => {
        const ok = recon({ dispatchGapReasons: {} });
        const diff = recon({ sourceDispatchableCount: 29, dispatchableGap: 2, dispatchGapReasons: { SOURCE_ONLY_NO_DOC: 1, SOURCE_ONLY_INFO_INCOMPLETE: 1 } });
        const lines = [
            beat('RP012', ok),
            beat('RP023', diff),
            beat('RP031', diff), beat('RP031', diff), beat('RP031', diff),
            beat('RP006', null, { stopped: true, failures: 3, error: 'SOURCE_STALE' }),
            beat('RP004', null),
        ];
        const v = Object.fromEntries(verdictRows(lines).map(r => [r.source, r]));
        expect(v.RP012.line).toBe('손오공(RP012) ✅ 원천 출고가능 27 = 노출 27 · 계약중 3');
        expect(v.RP023.line).toBe('오토플러스(RP023) ⚠ 원천 출고가능 29 / 노출 27 · 계약중 3 — 편입 대기 1, 정보 부족(가격·상태) 1');
        expect(v.RP031.mark).toBe('❌');
        expect(v.RP031.line).toContain('(3회 연속)');
        expect(v.RP006.line).toBe('아이언(RP006) ❌ 회차 정지(연속 실패 3) — SOURCE_STALE');
        expect(v.RP004.mark).toBe('⚠');
        expect(v.RP004.line).toContain('지표 없음');
        // 차이가 풀리면 연속 횟수도 끊긴다
        expect(verdictRows([beat('RP031', diff), beat('RP031', diff), beat('RP031', diff), beat('RP031', ok)])[0].mark).toBe('✅');
    });
});
