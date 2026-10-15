/** 손오공 API 상세 옵션 투영(순수, 읽기 전용). 설계: docs/SONOGONG-OPTIONS-DESIGN-20261016.md (커맨드 센터 2026-10-15 박대표 승인).
 * detail.options = [{ category, name, amount }] 를 «기본(무상)»과 «유상 후보»로 나눈다. 유상 구분의 근거는 API category «선택옵션» 한 가지뿐이며
 * 이름으로 추정하지 않는다. 금액은 원 단위 양의 정수일 때만 KNOWN, 그 외(null·0·음수·비정수)는 UNKNOWN(금액 미확인)으로 두고 원문을 남긴다.
 * 표시 전용: 이 투영은 대여료·보증금·견적 계산에 쓰이지 않는다. 원문 정본은 source_raw 이며 여기서는 이름의 공백·전각 정리만 한다. */

export const PAID_OPTION_CATEGORY = '선택옵션';
/** 무상(기본 포함)으로 확정하는 API category 코드. 이 밖의 구분(누락·오염 포함)은 무상으로 확정하지 않고 UNKNOWN_CATEGORY 로 둔다. */
export const KNOWN_BASIC_CATEGORIES: ReadonlySet<string> = new Set(['CONVENIENCE', 'INTERIOR', 'SAFETY', 'EXTERIOR', 'MULTIMEDIA']);
export const UNKNOWN_CATEGORY = 'UNKNOWN_CATEGORY';

export type BasicOption = { category: string; name: string };
export type PaidOption = { name: string; amount_krw: number | null; amount_state: 'KNOWN' | 'UNKNOWN'; amount_raw: number | string | null };
export type OptionProjection = {
  basic: BasicOption[];
  paid: PaidOption[];
  /** 구분이 알려진 무상 코드도 «선택옵션» 도 아닌 항목 — 무상으로 확정하지 않는다(이름만 보존). */
  unclassified: { name: string }[];
  notes: {
    /** 입력 항목 수(배열이 아니면 0). */
    inputCount: number;
    /** 이름이 비어 버린 항목. */
    droppedEmptyName: number;
    /** 같은 (구분, 이름) 의 반복 — 첫 항목만 남긴다. */
    duplicates: number;
    /** 구분이 «선택옵션» 이 아닌데 금액이 있는 항목 — 기본으로 두고 금액은 버린다(실측 대상). */
    amountOnNonPaid: number;
    /** 알려진 코드가 아니어서 분류하지 못한 항목 수. */
    unknownCategory: number;
    /** 유상인데 금액이 UNKNOWN 인 항목(null 포함). */
    paidAmountUnknown: number;
  };
};

const clean = (v: unknown) => (typeof v === 'string' ? v.normalize('NFKC').replace(/\s+/g, ' ').trim() : '');
const isPositiveWon = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

export function projectSonogongOptions(options: unknown): OptionProjection {
  const result: OptionProjection = { basic: [], paid: [], unclassified: [], notes: { unknownCategory: 0, inputCount: 0, droppedEmptyName: 0, duplicates: 0, amountOnNonPaid: 0, paidAmountUnknown: 0 } };
  if (!Array.isArray(options)) return result;
  result.notes.inputCount = options.length;
  const seen = new Set<string>();
  for (const entry of options) {
    const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const category = clean(item.category), name = clean(item.name);
    if (!name) { result.notes.droppedEmptyName++; continue; }
    const dedupeKey = `${category}\u0000${name}`;
    if (seen.has(dedupeKey)) { result.notes.duplicates++; continue; }
    seen.add(dedupeKey);
    const amount = item.amount;
    if (category === PAID_OPTION_CATEGORY) {
      const known = isPositiveWon(amount);
      if (!known) result.notes.paidAmountUnknown++;
      const raw = typeof amount === 'number' || typeof amount === 'string' ? amount : null;
      result.paid.push({ name, amount_krw: known ? amount : null, amount_state: known ? 'KNOWN' : 'UNKNOWN', amount_raw: raw });
    } else {
      if (amount !== null && amount !== undefined) result.notes.amountOnNonPaid++;
      const code = category.toUpperCase();
      if (KNOWN_BASIC_CATEGORIES.has(code)) result.basic.push({ category: code, name });
      else { result.unclassified.push({ name }); result.notes.unknownCategory++; }
    }
  }
  return result;
}

/** 여러 상품의 투영을 집계한다(이름·금액 값은 내지 않는다 — 건수와 분포만). */
export function summarizeOptionProjections(projections: OptionProjection[]) {
  const byCategory: Record<string, number> = {};
  const summary = { unclassifiedTotal: 0, documents: projections.length, documentsWithOptions: 0, basicTotal: 0, paidTotal: 0, paidKnown: 0, paidUnknown: 0,
    documentsWithKnownPaid: 0, amountOnNonPaid: 0, droppedEmptyName: 0, duplicates: 0, byCategory };
  for (const p of projections) {
    if (p.basic.length || p.paid.length || p.unclassified.length) summary.documentsWithOptions++;
    summary.unclassifiedTotal += p.unclassified.length;
    summary.basicTotal += p.basic.length; summary.paidTotal += p.paid.length;
    const known = p.paid.filter(o => o.amount_state === 'KNOWN').length;
    summary.paidKnown += known; summary.paidUnknown += p.paid.length - known;
    if (known) summary.documentsWithKnownPaid++;
    summary.amountOnNonPaid += p.notes.amountOnNonPaid; summary.droppedEmptyName += p.notes.droppedEmptyName; summary.duplicates += p.notes.duplicates;
    for (const o of p.basic) byCategory[o.category] = (byCategory[o.category] ?? 0) + 1;   // 알려진 코드만 키가 된다
    if (p.unclassified.length) byCategory[UNKNOWN_CATEGORY] = (byCategory[UNKNOWN_CATEGORY] ?? 0) + p.unclassified.length;
    if (p.paid.length) byCategory[PAID_OPTION_CATEGORY] = (byCategory[PAID_OPTION_CATEGORY] ?? 0) + p.paid.length;
  }
  return summary;
}
