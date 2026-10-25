import { sonogongApiRowFloor } from './sonogong-api.js';
/** 고유 차량번호 수 = 어댑터가 채택한 레코드 수(탭 간 중복은 이미 하나로 합쳐졌고, 번호 형식 오류·같은 탭 중복은 레코드가 아니다). */
export const uniquePlateCount = (read) => new Set(read.records.map(r => r.plate)).size;
/** 상류 데이터 생성 시각이 이보다 오래되면 «상류 정지»(소프트 보류, 우리 쪽 실패 아님). 손오공 데이터는 1시간 단위 갱신이라 여유를 둔다. */
export const SONOGONG_UPSTREAM_MAX_AGE_MINUTES = 150;
export function judgeSonogongApiRead(read, input) {
    if (read.complete && read.generatedAt && Number.isFinite(Date.parse(read.generatedAt)) &&
        (input.nowMs ?? Date.now()) - Date.parse(read.generatedAt) > SONOGONG_UPSTREAM_MAX_AGE_MINUTES * 60_000)
        return { complete: false, incompleteReason: 'UPSTREAM_STALE', saveCount: null };
    if (!read.complete)
        return { complete: false, ...(read.incompleteReason ? { incompleteReason: read.incompleteReason } : {}), saveCount: null };
    const unique = uniquePlateCount(read);
    const floor = sonogongApiRowFloor(input.exposedUnlockedDocs, input.previousCount);
    if (unique < floor)
        return { complete: false, incompleteReason: 'API_SHRUNK', saveCount: null }; // 축소 읽기: 기준을 낮추지 않는다
    if (input.stateError) {
        // 기준 파일 손상: 이번 회차만 불인정하고, 기준 없이도 노출 문서 하한(80%)을 통과한 «완전 읽기»일 때만 복구 저장한다.
        const recoverable = unique >= sonogongApiRowFloor(input.exposedUnlockedDocs, 0);
        return { complete: false, incompleteReason: input.stateError, saveCount: recoverable ? unique : null };
    }
    return { complete: true, saveCount: unique };
}
/** 잠금 안에서 호출한다. 같은 상한 값의 표식이 이미 있으면 소진, 없으면 «적용 전에» 표식을 원자적으로 쓴다. 쓰기 실패·읽기 불가는 상한을 올리지 않는다. */
export async function claimEnrollCapOnce(io, cap, nowIso) {
    let existing;
    try {
        existing = await io.read();
    }
    catch {
        return { granted: false, reason: 'MARKER_UNREADABLE' };
    }
    if (existing !== null) {
        try {
            const parsed = JSON.parse(existing);
            if (parsed.cap === cap)
                return { granted: false, reason: 'ALREADY_CLAIMED' };
            // 상한 값이 바뀌었으면 운영자가 새로 허용한 것으로 본다(값을 바꾸는 행위가 명시적 재승인이다).
        }
        catch {
            return { granted: false, reason: 'MARKER_UNREADABLE' };
        } // 손상: 보수적으로 올리지 않는다
    }
    const written = await io.write(JSON.stringify({ cap, at: nowIso, state: 'CLAIMED_BEFORE_APPLY' }));
    return written ? { granted: true, reason: 'GRANTED' } : { granted: false, reason: 'MARKER_WRITE_FAILED' };
}
