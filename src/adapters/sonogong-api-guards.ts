/** 손오공 API 읽기의 «쓰기 전 안전 판정»(순수·시험 가능). 독립 검토 2026-10-14(#601) 결함 3건의 수정:
 * ① 축소된(API_SHRUNK 등 불완전) 읽기의 건수는 기준 파일에 저장하지 않는다 — 기준은 마지막 «완전하고 하한을 통과한» 읽기 건수만이다.
 * ② 하한은 «고유 차량번호 수» 로 계산한다(탭 간 중복 행은 제외).
 * ③ 한 회차 한정 편입 상한 표식은 잠금 안에서 «적용 전에» 원자적으로 기록하고, 기록에 실패하면 상한을 올리지 않는다(보수적으로 원복값). */
import type { SonogongApiRead } from './sonogong-api.js';
import { sonogongApiRowFloor, SONOGONG_API_TABS, SONOGONG_WITHDRAWN_PRODUCT_TYPES } from './sonogong-api.js';

/** 하한 계산용 «잠금 제외 노출 문서 수»(decode 된 문서 칸). 계약 잠금·계약중은 원천에서 내려가도 정산 전 노출을 유지하므로 빼고,
 * 읽지 않는 탭의 상품 구분(중고렌트·픽업구독, 대표 2026-10-28 «손오공 구독은 연동하고 나머지는 다 내리고») 문서는 이 읽기와 비교 대상이 아니므로 뺀다(문서 칸 product_type 또는 저장 기록 raw.product_type). */
export function sonogongExposedUnlockedCount(docs: ReadonlyArray<Record<string, unknown>>): number {
  return docs.filter(f => {
    const locked = (f.locked_by_contract !== undefined && f.locked_by_contract !== null && f.locked_by_contract !== false && f.locked_by_contract !== '')
      || f.status === '계약중' || f.status_kind === '계약중';
    const recordType = (f.source_cycle_record as { raw?: { product_type?: unknown } } | null | undefined)?.raw?.product_type;
    const withdrawnType = [f.product_type, recordType].some(t => typeof t === 'string' && SONOGONG_WITHDRAWN_PRODUCT_TYPES.includes(t));
    return f.listable === true && !locked && !withdrawnType;
  }).length;
}

/** 기준 파일에 함께 남기는 «읽은 탭 범위». */
export const SONOGONG_COUNT_TAB_SCOPE = SONOGONG_API_TABS.join(',');
/** 기준 파일(직전 정상 건수) 해석. 파일 없음 = 기준 없음. 형식이 깨졌으면 API_COUNT_STATE_INVALID.
 * 읽은 탭 범위가 다른 기준(옛 형식 = 세 탭 전부, 대표 2026-10-28 전)은 지금 읽기와 비교할 수 없어 «기준 없음»으로 본다 — 노출 문서 하한만 남고, 다음 완전 읽기가 새 범위로 다시 쓴다. */
export function parseSonogongCountState(text: string | null, readError: boolean): { previous: number; stateError: string | null } {
  if (readError) return { previous: 0, stateError: 'API_COUNT_STATE_INVALID' };
  if (text === null) return { previous: 0, stateError: null };
  try {
    const parsed = JSON.parse(text) as { count?: unknown; tabs?: unknown };
    if (!(typeof parsed.count === 'number' && Number.isSafeInteger(parsed.count) && parsed.count > 0)) return { previous: 0, stateError: 'API_COUNT_STATE_INVALID' };
    return { previous: parsed.tabs === SONOGONG_COUNT_TAB_SCOPE ? parsed.count : 0, stateError: null };
  } catch { return { previous: 0, stateError: 'API_COUNT_STATE_INVALID' }; }
}

export type ApiReadVerdict = {
  complete: boolean; incompleteReason?: string;
  /** 기준 파일(직전 정상 건수)에 저장할 고유 번호 수. null 이면 저장하지 않는다(불완전·축소 읽기). */
  saveCount: number | null;
};

/** 고유 차량번호 수 = 어댑터가 채택한 레코드 수(탭 간 중복은 이미 하나로 합쳐졌고, 번호 형식 오류·같은 탭 중복은 레코드가 아니다). */
export const uniquePlateCount = (read: Pick<SonogongApiRead, 'records'>): number => new Set(read.records.map(r => r.plate)).size;

/** 상류 데이터 생성 시각이 이보다 오래되면 «상류 정지»(소프트 보류, 우리 쪽 실패 아님). 손오공 데이터는 1시간 단위 갱신이라 여유를 둔다. */
export const SONOGONG_UPSTREAM_MAX_AGE_MINUTES = 150;

export function judgeSonogongApiRead(read: Pick<SonogongApiRead, 'complete' | 'records'> & { incompleteReason?: string | undefined; generatedAt?: string | null | undefined },
  input: { exposedUnlockedDocs: number; previousCount: number; stateError: string | null; nowMs?: number }): ApiReadVerdict {
  if (read.complete && read.generatedAt && Number.isFinite(Date.parse(read.generatedAt)) &&
      (input.nowMs ?? Date.now()) - Date.parse(read.generatedAt) > SONOGONG_UPSTREAM_MAX_AGE_MINUTES * 60_000)
    return { complete: false, incompleteReason: 'UPSTREAM_STALE', saveCount: null };
  if (!read.complete) return { complete: false, ...(read.incompleteReason ? { incompleteReason: read.incompleteReason } : {}), saveCount: null };
  const unique = uniquePlateCount(read);
  const floor = sonogongApiRowFloor(input.exposedUnlockedDocs, input.previousCount);
  if (unique < floor) return { complete: false, incompleteReason: 'API_SHRUNK', saveCount: null };     // 축소 읽기: 기준을 낮추지 않는다
  if (input.stateError) {
    // 기준 파일 손상: 이번 회차만 불인정하고, 기준 없이도 노출 문서 하한(80%)을 통과한 «완전 읽기»일 때만 복구 저장한다.
    const recoverable = unique >= sonogongApiRowFloor(input.exposedUnlockedDocs, 0);
    return { complete: false, incompleteReason: input.stateError, saveCount: recoverable ? unique : null };
  }
  return { complete: true, saveCount: unique };
}

export type OnceClaim = { granted: boolean; reason: 'GRANTED' | 'ALREADY_CLAIMED' | 'MARKER_UNREADABLE' | 'MARKER_WRITE_FAILED' };
/** 잠금 안에서 호출한다. 같은 상한 값의 표식이 이미 있으면 소진, 없으면 «적용 전에» 표식을 원자적으로 쓴다. 쓰기 실패·읽기 불가는 상한을 올리지 않는다. */
export async function claimEnrollCapOnce(io: { read: () => Promise<string | null>; write: (text: string) => Promise<boolean> },
  cap: number, nowIso: string): Promise<OnceClaim> {
  let existing: string | null;
  try { existing = await io.read(); } catch { return { granted: false, reason: 'MARKER_UNREADABLE' }; }
  if (existing !== null) {
    try {
      const parsed = JSON.parse(existing) as { cap?: unknown };
      if (parsed.cap === cap) return { granted: false, reason: 'ALREADY_CLAIMED' };
      // 상한 값이 바뀌었으면 운영자가 새로 허용한 것으로 본다(값을 바꾸는 행위가 명시적 재승인이다).
    } catch { return { granted: false, reason: 'MARKER_UNREADABLE' }; }   // 손상: 보수적으로 올리지 않는다
  }
  const written = await io.write(JSON.stringify({ cap, at: nowIso, state: 'CLAIMED_BEFORE_APPLY' }));
  return written ? { granted: true, reason: 'GRANTED' } : { granted: false, reason: 'MARKER_WRITE_FAILED' };
}
