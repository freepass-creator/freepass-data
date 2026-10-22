/** 공통 시트(F05형)의 차량 사실 칸 후보 → 프리패스 데이터 «기존 칸»에 빈 칸만 채우는 순수 로직(대표 2026-10-23 설계안 승인, 설계안 docs: 비고 F01 칸).
 *  재사용 칸(ERP5 가 이미 읽는 칸): 구동방식 → drive_type(공개 화면), 원산지 → origin(F01). 검증을 통과한 값만 원천 기록에 «후보»(raw.sheet_facts)로 싣고,
 *  쓰기는 문서의 해당 칸이 «비어 있을 때만». 이미 다른 값이 있으면 쓰지 않고 충돌로 센다. 원문(raw.cells)은 그대로 보존된다. */
export const SHEET_FACT_KEYS = ['drive_type', 'origin', 'options'] as const;
export type SheetFactKey = (typeof SHEET_FACT_KEYS)[number];
export type SheetFacts = Partial<Record<SheetFactKey, string>>;

const DRIVE_VALUES = new Set(['2WD', '4WD', 'AWD', 'FWD', 'RWD']);
const ORIGIN_VALUES = new Set(['국산', '수입']);
/** 옵션은 공개 화면에 그대로 보인다(대표 2026-10-23 설계안·Codex): 무정보 값과 연락처·URL·보증금·수수료·내부 메모 문구는 후보에서 뺀다. 길이 상한 1,000자. */
const OPTIONS_MAX = 1000;
const OPTIONS_NO_INFO = new Set(['', '-', '기본', '없음', '해당없음', 'X', 'N/A', 'NA']);
const OPTIONS_PUBLIC_UNSAFE = /(\d{2,3}-?\d{3,4}-?\d{4})|(https?:\/\/)|(www\.)|@|보증금|수수료|내부|문의|카톡|카카오|계좌|입금|견적|프로모션/i;
const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').normalize('NFKC').replace(/\s+/g, ' ').trim();

/** 키별 검증: 통과한 정규 값 또는 null. */
export function validSheetFact(key: SheetFactKey, value: unknown): string | null {
  const t = text(value);
  if (!t) return null;
  if (key === 'drive_type') { const u = t.toUpperCase(); return DRIVE_VALUES.has(u) ? u : null; }
  if (key === 'options') return typeof value === 'string' && t.length <= OPTIONS_MAX && !OPTIONS_NO_INFO.has(t.toUpperCase()) && !OPTIONS_PUBLIC_UNSAFE.test(t) ? t : null;
  return ORIGIN_VALUES.has(t) ? t : null;
}
const SHEET_HEADER: Record<SheetFactKey, string> = { drive_type: '구동방식', origin: '원산지', options: '옵션 원문' };

/** 헤더 «이름»으로 읽는다(열 위치가 아니다). 검증을 통과한 칸만 담고, 하나도 없으면 undefined. */
export function sheetFactsOf(headers: readonly unknown[] | undefined, cells: readonly unknown[] | undefined): SheetFacts | undefined {
  if (!Array.isArray(headers) || !Array.isArray(cells)) return undefined;
  const out: SheetFacts = {};
  for (const key of SHEET_FACT_KEYS) {
    const at = headers.findIndex(h => text(h) === SHEET_HEADER[key]);
    if (at < 0) continue;
    const v = validSheetFact(key, cells[at]);
    if (v) out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}
/** 저장된/전달된 raw.sheet_facts 재검증(모양이 틀리거나 값이 검증을 못 통과하면 그 칸은 버린다). */
export function validSheetFacts(v: unknown): SheetFacts | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: SheetFacts = {};
  for (const key of SHEET_FACT_KEYS) { const x = validSheetFact(key, (v as Record<string, unknown>)[key]); if (x) out[key] = x; }
  return Object.keys(out).length ? out : undefined;
}

/** 문서의 «빈 칸» 정의: 없음·null·빈 문자열(공백만)만. 0·false·[]·다른 값은 빈 칸이 아니다. */
export const isBlankFact = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** 문서 현재 값 상태(읽기 경로): 켜진 칸마다 «값 문자열 또는 null(비어 있음)». */
export function sheetFactState(doc: Record<string, unknown>, enabled: readonly SheetFactKey[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  // 비문자 값(false·[]·{}·숫자)도 «값 있음»으로 센다(빈 칸이 아니므로 덮지 않고 충돌로 본다).
  for (const key of enabled) {
    // 손오공 API 옵션을 관리하는 문서(api_options_state 있음)는 시트 옵션 대상이 아니다(대표 10-19: 유상 옵션만 표시).
    if (key === 'options' && !isBlankFact(doc.api_options_state)) continue;
    out[key] = isBlankFact(doc[key]) ? null : (typeof doc[key] === 'string' ? text(doc[key]) || '(공백 정규화 후 빈 값)' : '(문자열이 아닌 값)');
  }
  return out;
}
/** 계획 판정: 상태와 후보로 채울 칸·충돌 칸. */
export function sheetFactPlan(state: Record<string, string | null> | undefined, facts: SheetFacts | undefined, enabled: readonly SheetFactKey[]): { fill: SheetFactKey[]; conflicts: SheetFactKey[] } {
  const fill: SheetFactKey[] = [], conflicts: SheetFactKey[] = [];
  if (!state || !facts) return { fill, conflicts };
  for (const key of enabled) {
    const candidate = facts[key];
    if (!candidate || !(key in state)) continue;
    if (state[key] === null) fill.push(key);
    else if (state[key] !== candidate) conflicts.push(key);
  }
  return { fill, conflicts };
}
/** 쓰기 칸: 켜진 칸 중 문서가 지금도 비어 있고 후보가 검증을 통과한 칸만(쓰기 시점에 다시 확인). */
export function sheetFactFields(rawFacts: unknown, original: Record<string, unknown>, enabled: readonly SheetFactKey[], planned?: readonly SheetFactKey[]): Record<string, string> {
  const facts = validSheetFacts(rawFacts);
  const out: Record<string, string> = {};
  if (!facts) return out;
  // planned(계획이 고른 칸)가 있으면 그 칸만 쓴다 — 계획 밖 채움을 막는다.
  for (const key of enabled) if (facts[key] && isBlankFact(original[key]) && (!planned || planned.includes(key))) out[key] = facts[key]!;
  return out;
}
