import { describe, expect, it } from 'vitest';
import { parseSheetCountState, judgeSheetCount } from '../src/adapters/sheet-count-guard.js';
// 2026-10-16 10:00 KST PT-0026·RP033 SHEET_COUNT_STATE_INVALID(연속 3, STOPPED): 직전 정상 수 파일에 count 0 이 남으면 영구히 상태 오류가 되던 경로.
describe('시트 직전 정상 수 상태 파일 해석', () => {
    it('파일 없음(첫 회차)과 정상 값은 오류가 아니다', () => {
        expect(parseSheetCountState(null)).toEqual({ previous: 0, stateError: null });
        expect(parseSheetCountState('{"count":120,"at":"2026-10-16T00:00:00.000Z"}')).toEqual({ previous: 120, stateError: null });
    });
    it('count 0 은 이전 없음이다(예전 동작이 남긴 값이 영구 오류가 되지 않는다)', () => {
        expect(parseSheetCountState('{"count":0,"at":"2026-10-16T00:00:00.000Z"}')).toEqual({ previous: 0, stateError: null });
        // 이전 없음 + 노출 문서가 있는데 행이 0 이면 급감 판정(빈 읽기가 노출 전부를 내리지 않음)
        expect(judgeSheetCount({ complete: true, rows: 0, previousCount: 0, exposedUnlockedDocs: 30, stateError: null }))
            .toEqual({ complete: false, incompleteReason: 'SOURCE_SHRUNK', saveCount: null });
        // 행이 다시 생기면 정상 복구
        expect(judgeSheetCount({ complete: true, rows: 25, previousCount: 0, exposedUnlockedDocs: 30, stateError: null }))
            .toEqual({ complete: true, saveCount: 25 });
    });
    it('깨진 JSON·구조 다름·음수·비정수·읽기 오류만 상태 오류', () => {
        for (const text of ['', '{', 'null', '[]', '{"count":-1}', '{"count":1.5}', '{"count":"7"}', '{}']) {
            expect(parseSheetCountState(text), text).toEqual({ previous: 0, stateError: 'SHEET_COUNT_STATE_INVALID' });
        }
        expect(parseSheetCountState(null, true)).toEqual({ previous: 0, stateError: 'SHEET_COUNT_STATE_INVALID' });
    });
});
