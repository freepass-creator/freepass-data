/** 공급사별 차종 «정체성 4칸» 현황표(순수·읽기 전용, 커맨드 센터 2026-10-15 요청 ①).
 * 입력은 공개 카탈로그(summary-v1)나 같은 모양의 상품 목록이고 출력은 공급사별 대수 표다(전체 차량번호·고객정보 없음).
 * 분류는 «지금 4칸이 어떻게 차 있나»와 «원문을 결정적으로 쪼갤 수 있나»만 본다. 마스터 일치(확정 가능/마스터 필요)는 identity-promotion-plan 이
 * 마스터 스냅샷으로 판정하므로, 마스터가 주어졌을 때만 matched 를 센다. 어떤 이름도 지어내지 않는다. */
import { splitRawVehicleName } from '../domain/vehicle-raw-name-split.js';

export type IdentityStatusRow = { supplier: string; manufacturer?: string | null; model?: string | null; subModel?: string | null; trim?: string | null };

export const IDENTITY_STATUS_CATEGORIES = [
  'FILLED_4',            // 제조사·모델·세부모델·세부트림 모두 채워짐(마스터 일치는 별도 검증)
  'FILLED_NO_TRIM',      // 제조사·모델·세부모델은 있고 세부트림이 빔 → 트림만 마스터 매칭 필요
  'SPLIT_4_TOKENS',      // «_» 4토큰: 제조사_모델_파워트레인_트림 — 결정적으로 쪼갤 수 있음(마스터 일치 필요)
  'SPLIT_3_TOKENS',      // «_» 3토큰: 제조사_모델_꼬리 — 쪼갤 수 있으나 꼬리 해석은 낱말 규칙(마스터 일치 필요)
  'RAW_MISALIGNED',      // «_» 는 있으나 토큰이 어긋나 쪼개지 않음(마스터 매칭 규칙만)
  'RAW_NO_DELIMITER',    // 구분자 없는 원문 한 칸(제조사·모델 빔) — 쪼갤 수 없음, 마스터 매칭 규칙만
  'PARTIAL',             // 일부 칸만 채워짐
  'EMPTY',               // 4칸 모두 빔 — 이 응답으로는 판독 불가(원문은 문서 원문 칸에 있을 수 있음)
] as const;
export type IdentityStatusCategory = typeof IDENTITY_STATUS_CATEGORIES[number];

const has = (v: unknown) => typeof v === 'string' && v.trim() !== '';

export function classifyIdentityRow(row: IdentityStatusRow): IdentityStatusCategory {
  const maker = has(row.manufacturer), model = has(row.model), sub = has(row.subModel), trim = has(row.trim);
  const subText = String(row.subModel ?? '');
  if (sub && subText.includes('_')) {
    const split = splitRawVehicleName(subText);
    return split.structure === 'MAKER_MODEL_POWERTRAIN_TRIM' ? 'SPLIT_4_TOKENS'
      : split.structure === 'MAKER_MODEL_TAIL' ? 'SPLIT_3_TOKENS' : 'RAW_MISALIGNED';
  }
  if (maker && model && sub && trim) return 'FILLED_4';
  if (maker && model && sub) return 'FILLED_NO_TRIM';
  if (!maker && !model && sub) return 'RAW_NO_DELIMITER';
  if (!maker && !model && !sub && !trim) return 'EMPTY';
  return 'PARTIAL';
}

export type IdentityStatusTable = {
  total: number;
  suppliers: Record<string, { total: number; counts: Record<IdentityStatusCategory, number>; longSubModel: number; modelEqualsSubModel: number }>;
  totals: Record<IdentityStatusCategory, number>;
};

const zero = () => Object.fromEntries(IDENTITY_STATUS_CATEGORIES.map(c => [c, 0])) as Record<IdentityStatusCategory, number>;

export function buildIdentityStatusTable(rows: readonly IdentityStatusRow[]): IdentityStatusTable {
  const table: IdentityStatusTable = { total: rows.length, suppliers: {}, totals: zero() };
  for (const row of rows) {
    const supplier = String(row.supplier ?? '').trim() || '(공급사 없음)';
    const entry = table.suppliers[supplier] ??= { total: 0, counts: zero(), longSubModel: 0, modelEqualsSubModel: 0 };
    const category = classifyIdentityRow(row);
    entry.total++; entry.counts[category]++; table.totals[category]++;
    const sub = String(row.subModel ?? '').trim(), model = String(row.model ?? '').trim();
    if (sub.length > 22) entry.longSubModel++;
    if (model && sub && model === sub) entry.modelEqualsSubModel++;
  }
  return table;
}
