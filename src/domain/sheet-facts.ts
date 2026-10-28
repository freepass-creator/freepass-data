/** 공통 시트(F05형)의 차량 사실 칸 후보 → 프리패스 데이터 «기존 칸»에 빈 칸만 채우는 순수 로직(대표 2026-10-23 설계안 승인, 설계안 docs: 비고 F01 칸).
 *  재사용 칸(ERP5 가 이미 읽는 칸): 구동방식 → drive_type(공개 화면), 원산지 → origin(F01). 검증을 통과한 값만 원천 기록에 «후보»(raw.sheet_facts)로 싣고,
 *  쓰기는 문서의 해당 칸이 «비어 있을 때만». 이미 다른 값이 있으면 쓰지 않고 충돌로 센다. 원문(raw.cells)은 그대로 보존된다. */
export const SHEET_FACT_KEYS = ['drive_type', 'origin', 'options', 'consumer_price', 'self_body_accident'] as const;
export type SheetFactKey = (typeof SHEET_FACT_KEYS)[number];
export type SheetFacts = Partial<Record<SheetFactKey, string | number>>;
/** 차량가격(consumer_price, 대표 2026-10-23 승인): 정수 원, 5,000,000~300,000,000. 세금 포함 여부는 단정하지 않고 시트 원문 값 그대로. */
export const CONSUMER_PRICE_MIN = 5_000_000, CONSUMER_PRICE_MAX = 300_000_000;
/** 자손한도(self_body_accident, 대표 2026-10-28 «맞춰주세요»·«그냥 숫자만 넣자 … 1억이면 총액기준으로»): F05 차 줄 값을 총액 기준 한도 숫자 하나(정수 원)로.
 *  자손·자상 구분이나 사망·부상 나눔은 하지 않는다. 범위 1백만~100억. «1억/50»·«사망 1억 부상 1500만» 처럼 한 금액이 아니면 후보에서 뺀다(추정 금지). */
export const SELF_BODY_LIMIT_MIN = 1_000_000, SELF_BODY_LIMIT_MAX = 10_000_000_000;
/** 엔진이 주인인 칸: F05 차 줄 값이 우선이라(대표 10-28) 문서 값과 다르면 충돌이 아니라 F05 값으로 바꾼다. 다른 칸은 종전대로 빈 칸만 채운다. */
export const SHEET_FACT_SOURCE_OWNED: ReadonlySet<SheetFactKey> = new Set(['self_body_accident']);

/** «1억원»·«1억5천만원»·«5천만원»·«1천5백만원»·«1,500만원»·«100,000,000» → 정수 원. 한 금액으로 읽히지 않으면 null. */
export function koreanWonAmount(value: string): number | null {
  // 쉼표는 천 단위 구분일 때만(«1,5억»·«1,,500만» 은 금액이 아니다).
  if ((value.match(/[\d,]+/g) ?? []).some(run => run.includes(',') && !/^\d{1,3}(?:,\d{3})+$/.test(run))) return null;
  const t = value.replace(/[,\s]/g, '').replace(/원$/, '');
  if (/^\d{1,12}$/.test(t)) return Number(t);
  const m = /^(?:(\d+)억)?(?:(?:(\d+)천)?(?:(\d+)백)?(\d+)?만)?$/.exec(t);
  if (!m || !t || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const man = Number(m[2] ?? 0) * 1000 + Number(m[3] ?? 0) * 100 + Number(m[4] ?? 0);
  return Number(m[1] ?? 0) * 100_000_000 + man * 10_000;
}

const DRIVE_VALUES = new Set(['2WD', '4WD', 'AWD', 'FWD', 'RWD']);
const ORIGIN_VALUES = new Set(['국산', '수입']);
/** 옵션은 공개 화면에 그대로 보인다(대표 2026-10-23 설계안·Codex): 무정보 값과 연락처·URL·보증금·수수료·내부 메모 문구는 후보에서 뺀다. 길이 상한 1,000자. */
const OPTIONS_MAX = 1000;
const OPTIONS_NO_INFO = new Set(['', '-', '기본', '없음', '해당없음', 'X', 'N/A', 'NA']);
const OPTIONS_PUBLIC_UNSAFE = /(\d{2,3}-?\d{3,4}-?\d{4})|(https?:\/\/)|(www\.)|@|보증금|수수료|내부|문의|카톡|카카오|계좌|입금|견적|프로모션/i;
const text = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').normalize('NFKC').replace(/\s+/g, ' ').trim();

/** 키별 검증: 통과한 정규 값 또는 null. */
export function validSheetFact(key: SheetFactKey, value: unknown): string | number | null {
  const t = text(value);
  if (!t) return null;
  if (key === 'consumer_price') {
    const digits = t.replace(/[,\s원]/g, '');
    if (!/^\d{1,12}$/.test(digits)) return null;
    const n = Number(digits);
    return n >= CONSUMER_PRICE_MIN && n <= CONSUMER_PRICE_MAX ? n : null;
  }
  if (key === 'self_body_accident') {
    const n = typeof value === 'number' ? (Number.isSafeInteger(value) ? value : null) : koreanWonAmount(t);
    return n !== null && n >= SELF_BODY_LIMIT_MIN && n <= SELF_BODY_LIMIT_MAX ? n : null;
  }
  if (key === 'drive_type') { const u = t.toUpperCase(); return DRIVE_VALUES.has(u) ? u : null; }
  if (key === 'options') return typeof value === 'string' && t.length <= OPTIONS_MAX && !OPTIONS_NO_INFO.has(t.toUpperCase()) && !OPTIONS_PUBLIC_UNSAFE.test(t) ? t : null;
  return ORIGIN_VALUES.has(t) ? t : null;
}
const SHEET_HEADER: Record<SheetFactKey, string> = { drive_type: '구동방식', origin: '원산지', options: '옵션 원문', consumer_price: '차량가격', self_body_accident: '자손한도' };

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
    const v = doc[key];
    // 엔진이 주인인 숫자 칸에 문자열이 들어 있으면 같은 글자여도 다른 값으로 본다(숫자로 바로잡는다).
    if (SHEET_FACT_SOURCE_OWNED.has(key) && !isBlankFact(v) && typeof v !== 'number') { out[key] = '(숫자가 아닌 값)'; continue; }
    out[key] = isBlankFact(v) ? null : (typeof v === 'string' ? text(v) || '(공백 정규화 후 빈 값)' : typeof v === 'number' && Number.isFinite(v) ? String(v) : '(문자열이 아닌 값)');
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
    else if (state[key] !== String(candidate)) (SHEET_FACT_SOURCE_OWNED.has(key) ? fill : conflicts).push(key);
  }
  return { fill, conflicts };
}
/** 쓰기 칸: 켜진 칸 중 문서가 지금도 비어 있고 후보가 검증을 통과한 칸만(쓰기 시점에 다시 확인). */
export function sheetFactFields(rawFacts: unknown, original: Record<string, unknown>, enabled: readonly SheetFactKey[], planned?: readonly SheetFactKey[]): Record<string, string | number> {
  const facts = validSheetFacts(rawFacts);
  const out: Record<string, string | number> = {};
  if (!facts) return out;
  // planned(계획이 고른 칸)가 있으면 그 칸만 쓴다 — 계획 밖 채움을 막는다.
  for (const key of enabled) {
    const writable = isBlankFact(original[key]) || (SHEET_FACT_SOURCE_OWNED.has(key) && original[key] !== facts[key]);
    if (facts[key] && writable && (!planned || planned.includes(key))) out[key] = facts[key]!;
  }
  return out;
}
