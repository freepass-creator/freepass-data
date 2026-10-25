/** 공급사 시트 원천(공통 시트 F05 공급사별·아이카 RP004)의 «급감» 하한(대표 2026-10-14 «데이터만큼은 정확하게»).
 * 아이언·손오공·오토플러스와 같은 방어: 시트가 일부만 읽혔거나 누가 행을 지워 «읽힌 행» 이 갑자기 줄면 그 읽기는 완전하지 않은 것으로 보고
 * (SOURCE_SHRUNK) 부재 하향·적용을 막는다. 판정은 순수 함수이고 기준 수 저장(임시 파일 + 이름 바꾸기)은 런타임이 한다. */
export const SHEET_SHRINK_RATIO = 0.8;
/** 읽힌 행 = 이 공급사 레코드 + 보류(보류 행도 시트에 있는 행이다). 하한:
 *  - 직전 정상 회차 수의 80% «그리고» 잠금 제외 노출 문서 수의 80% 둘 다보다 적으면 SOURCE_SHRUNK.
 *  - 직전 기준이 없으면(최초) 노출 문서 80% 만으로 판정한다(빈 읽기가 최초 회차에 전부를 부재로 내리지 않게).
 *  - 기준 파일이 손상되면(stateError) 이번 회차만 불완전으로 두고, 읽힌 수가 노출 문서 80% 이상이면 그 수로 기준을 복구한다.
 * 불완전한 읽기·급감은 기준에 저장하지 않는다(줄어든 수가 다음 회차 기준이 되어 방어가 풀리지 않게). */
export function judgeSheetCount(input) {
    const { complete, rows, previousCount, exposedUnlockedDocs, stateError } = input;
    if (!complete)
        return { complete: false, saveCount: null };
    const belowExposed = rows < exposedUnlockedDocs * SHEET_SHRINK_RATIO;
    if (stateError)
        return { complete: false, incompleteReason: stateError, saveCount: belowExposed ? null : rows };
    const belowPrevious = previousCount > 0 ? rows < previousCount * SHEET_SHRINK_RATIO : true;
    if (belowExposed && belowPrevious)
        return { complete: false, incompleteReason: 'SOURCE_SHRUNK', saveCount: null };
    return { complete: true, saveCount: rows };
}
/** 직전 정상 수 상태 파일 해석(순수). text=null 은 파일 없음(첫 회차). 읽기 오류·깨진 JSON·음수·비정수만 상태 오류다.
 * count 0 은 «이전 없음»이다 — 빈 시트가 완전으로 읽힌 회차가 0 을 남겼어도(예전 동작) 영구히 상태 오류로 막히지 않는다(2026-10-16 PT-0026·RP033). */
export function parseSheetCountState(text, readError = false) {
    if (readError)
        return { previous: 0, stateError: 'SHEET_COUNT_STATE_INVALID' };
    if (text === null)
        return { previous: 0, stateError: null };
    try {
        const parsed = JSON.parse(text);
        const count = parsed && typeof parsed === 'object' ? parsed.count : undefined;
        return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
            ? { previous: count, stateError: null } : { previous: 0, stateError: 'SHEET_COUNT_STATE_INVALID' };
    }
    catch {
        return { previous: 0, stateError: 'SHEET_COUNT_STATE_INVALID' };
    }
}
