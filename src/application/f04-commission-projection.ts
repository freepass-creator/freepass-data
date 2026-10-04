import { resolveSalesCommission, resolveSupplierBillingFee, KAKAO_COMMISSION_POLICY, type CommissionInput } from './kakao-catalog-reference.js';

/**
 * F04 정산원장 «접수» 탭의 AE 판매수수료(공급사 청구)·AJ 출고수수료(영업채널 지급)를 Data 수수료 엔진의 투영으로
 * 채우는 «계획»만 만든다(쓰기 없음). 요구사항: ai-ops docs/handoffs/정산-수수료규칙-20261005/AE-AJ-투영쓰기-요구사항.md.
 *
 * - 확정(KNOWN·ZERO)만 채운다. 미확정은 빈칸 + 사유(0 으로 쓰지 않는다).
 * - 값이 있는 칸은 덮지 않는다 — 계산값과 다르면 차이 목록.
 * - 취소·청구 끝(청구 TRUE)·닫힌 청구월(열린 첫 달보다 앞) 줄은 건드리지 않는다.
 * - 회차청구 탭에 있는 계약(차량번호+원 접수행)은 AE 를 쓰지 않는다(이중 청구).
 * - 분납 계약의 AE 는 «원 줄이 청구한 몫»: 다음 회차가 회차청구 탭에 있으면 원 줄 AE 는 쓰지 않고, 없으면 계약 전체.
 * - 비고에 합의·정정 표시가 있는 줄의 빈칸은 채우지 않고 사람 확인 목록으로.
 * - VAT 포함 규칙(스타·스카이)은 ÷1.1 원 미만 반올림(AI 상황실 2026-10-05 결정, F04 수수료표 171행).
 */

export type F04Column = 'AE' | 'AJ';
export type F04Fill = { row: number; column: F04Column; plate: string; value: number; ruleId: string };
export type F04Blank = { row: number; column: F04Column; plate: string; reason: string };
/** against: 비교한 시트 칸 — 그 칸 자신(AE·AJ) 또는 사람이 적은 청구액(U)·지급액(V). */
export type F04Diff = { row: number; column: F04Column; against: F04Column | 'U' | 'V'; plate: string; sheet: unknown; computed: number; difference: number | null; ruleId: string };
export type F04ProjectionPlan = {
  schema: 'freepass-data.f04-commission-projection-plan/v1';
  policyId: string;
  readAt: string;
  openFromMonth: string;
  rowsRead: number;
  fills: F04Fill[];
  blanks: F04Blank[];
  diffs: F04Diff[];
  /** 닫힌 청구월·청구 끝 줄의 값이 계산과 다른 것 — 쓰지 않고 사람 확인용으로만(예: 스타 규칙이 빠진 옛 청구). */
  closedDiffs: F04Diff[];
  same: number;
  skipped: Record<string, number>;
};

/** F04 접수 탭 공급사 이름 → 공급사 코드. 정본 이름표는 contracts/supplier-input-sheet-spec.v1.json, 여기는 F04 에 적힌 다른 이름만.
 * 스타스카이: 엔진에서 스타(RP018)·스카이(RP033)는 같은 규칙이라 어느 쪽이든 금액이 같다 — 스카이로 둔다. */
export const F04_SUPPLIER_CODES: Readonly<Record<string, string>> = {
  웰릭스: 'RP013', '웰릭스(발주건)': 'RP013', 우리캐피탈: 'RP020', KH: 'RP010', 리더스: 'RP008', 리더스렌트카: 'RP008',
  제이앤제이: 'RP030', 에코: 'RP032', 센트로: 'RP017', 퍼시픽: 'RP022', 연카: 'RP011', 스위치: 'RP014', 스위치플랜: 'RP014',
  렌트존: 'PT-0001', 에스에이: 'PT-0023', 빌린카: 'RP021', 엘씨: 'PT-0026', 엘씨렌트: 'PT-0026', 스타: 'RP018', 스카이: 'RP033',
  스타스카이: 'RP033', 경진카: 'RP016', 경진: 'RP015', 경진렌트카: 'RP015', 이안카: 'RP031', 손오공: 'RP012', 아이언: 'RP006',
  오토플러스: 'RP023', 아이카: 'RP004',
};

const AGREEMENT = /정정\s*반영|정산서\s*확정|확인금액\s*반영|합의/;
const PAYOUT_SIDE = /하허호|F80|출고수수료|지급/;
const BILLING_SIDE = /청구|판매수수료|공급사\s*정산서/;
/** 비고의 합의·정정 표시가 보호하는 축. 지급(하허호 F80) 쪽 말만 있으면 지급만, 청구 쪽 말만 있으면 청구만, 둘 다·모르면 둘 다. */
export const protectedSides = (remark: string): Set<F04Column> => {
  if (!AGREEMENT.test(remark)) return new Set();
  const payout = PAYOUT_SIDE.test(remark), billing = BILLING_SIDE.test(remark);
  if (payout && !billing) return new Set(['AJ']);
  if (billing && !payout) return new Set(['AE']);
  return new Set(['AE', 'AJ']);
};
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const truthy = (v: unknown) => v === true || /^(TRUE|true|1|예|Y)$/.test(text(v));
const int = (v: unknown): number | null => {
  const raw = typeof v === 'number' ? '' : text(v).replace(/[,\s원₩]/g, '');
  if (typeof v !== 'number' && !/^\d+$/.test(raw)) return null; // 빈칸·글자는 0 이 아니라 «모름»
  const n = typeof v === 'number' ? v : Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const empty = (v: unknown) => v === undefined || v === null || v === '';
/** FORMULA 로 읽은 칸의 수식(«=…»). 수식이 빈 글자를 돌려줘도 빈칸이 아니다 — 수식 칸은 절대 채우지 않는다. */
const formula = (v: unknown) => typeof v === 'string' && v.trim().startsWith('=');
/** 날짜를 YYYY-MM-DD 로: 시트 일련번호(1899-12-30 기준), «2026-09-20», «2026. 9. 20», «2026/9/20». 못 읽으면 원래 글자. */
export const isoDate = (v: unknown): string => {
  const serial = typeof v === 'number' ? v : /^\d{5}(?:\.\d+)?$/.test(text(v)) ? Number(text(v)) : NaN; // 글자로 온 일련번호도
  if (Number.isFinite(serial)) return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
  const m = /^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\.?$/.exec(text(v));
  return m ? `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}` : text(v);
};
const plateKey = (v: unknown) => text(v).replace(/\s+/g, '');

/** 접수 줄 하나 → 엔진 입력. 엔진이 받지 못하는 상품은 null 과 사유. */
export function f04RowInput(row: Record<string, unknown>, facts: Record<string, { fuel?: string }> = {}): { input: CommissionInput } | { reason: string } {
  const supplierId = F04_SUPPLIER_CODES[text(row['공급사'])];
  if (!supplierId) return { reason: 'SUPPLIER_CODE_UNRESOLVED' };
  const kind = text(row['상품구분']);
  if (kind === '지원금') return { reason: 'NOT_A_COMMISSION_ROW' };
  const productType = kind === '구독' ? '중고구독' : kind;
  const termMonths = int(row['계약기간']), monthlyRent = int(row['렌탈료']);
  if (termMonths === null || termMonths < 1 || monthlyRent === null) return { reason: 'INVALID_PRICE_TERM_INPUT' };
  const vehicleValue = int(row['차량가액']);
  const fuel = facts[plateKey(row['차량번호'])]?.fuel;
  return { input: { supplierId, productType, termMonths, monthlyRent, ...(vehicleValue ? { vehicleValue } : {}), ...(fuel ? { fuel } : {}) } };
}

const diffOf = (row: number, column: F04Column, against: F04Diff['against'], plate: string, sheetValue: unknown, computed: number, ruleId: string): F04Diff => {
  const sheet = int(sheetValue);
  return { row, column, against, plate, sheet: sheetValue, computed, difference: sheet === null ? null : sheet - computed, ruleId };
};

/** 엔진 결과 → 시트에 쓸 공급가 정수, 아니면 빈칸 사유. */
export function projectedAmount(result: ReturnType<typeof resolveSupplierBillingFee>): { value: number; ruleId: string } | { reason: string } {
  if (result.state !== 'CALCULATED' || result.amount === null || !result.ruleId) return { reason: result.reasonCode ?? result.state };
  // VAT 포함 규칙도 엔진의 공급가(÷1.1, 원 미만 반올림 — AI 상황실 2026-10-05 결정, 원장 41줄 관행)를 그대로 쓴다.
  return { value: result.amount, ruleId: result.ruleId };
}

/**
 * @param intake 접수 탭 값(UNFORMATTED). 머리글은 «차량번호»가 있는 첫 줄. 시트 행 번호 = 배열 index + 1.
 * @param installments 회차청구 탭 값. 머리글은 «차량번호»·«원 접수행»이 있는 줄.
 * @param openFromMonth 아직 닫히지 않은 첫 청구월(YYYY-MM). 이보다 앞선 청구월이 적힌 줄은 닫힌 것으로 보고 건드리지 않는다.
 */
export function planF04CommissionProjection(input: {
  intake: unknown[][]; installments: unknown[][]; openFromMonth: string; readAt: string; facts?: Record<string, { fuel?: string }>;
  /** 개별 합의 계약의 열쇠(차량번호|접수일) — 비공개 목록. 행 번호가 바뀌어도 계약으로 보호한다. */
  individualKeys?: string[];
  /** 같은 접수 탭을 FORMULA 로 읽은 값. 있으면 AE·AJ 가 수식 칸인지 이것으로 본다(값 읽기에서는 빈 글자 수식이 빈칸처럼 보인다). */
  intakeFormulas?: unknown[][];
}): F04ProjectionPlan {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.openFromMonth)) throw new Error('F04_OPEN_MONTH_INVALID');
  const hi = input.intake.findIndex(r => Array.isArray(r) && r.includes('차량번호'));
  if (hi < 0) throw new Error('F04_INTAKE_HEADER_MISSING');
  const header = input.intake[hi]!.map(text);
  for (const need of ['접수일', '차량번호', '공급사', '상품구분', '계약기간', '렌탈료', '분납여부', '청구년', '청구월', '취소', '판매수수료', '출고수수료', '비고', '청구', '청구액', '지급액'])
    if (header.indexOf(need) < 0) throw new Error('F04_INTAKE_COLUMN_MISSING');
  const colOf = (c: F04Column) => header.indexOf(c === 'AE' ? '판매수수료' : '출고수수료');
  if (colOf('AE') !== 30 || colOf('AJ') !== 35) throw new Error('F04_FEE_COLUMN_MOVED'); // AE=31번째, AJ=36번째 칸

  const ih = input.installments.findIndex(r => Array.isArray(r) && r.includes('차량번호') && r.includes('원 접수행'));
  if (ih < 0) throw new Error('F04_INSTALLMENT_HEADER_MISSING');
  const iHeader = input.installments[ih]!.map(text);
  const installmentLinks = input.installments.slice(ih + 1)
    .filter(r => Array.isArray(r) && !empty(r[iHeader.indexOf('차량번호')]))
    .map(r => ({ plate: plateKey(r[iHeader.indexOf('차량번호')]), row: int(r[iHeader.indexOf('원 접수행')]) }));
  const installmentRows = new Set(installmentLinks.filter(l => l.row !== null).map(l => `${l.plate}|${l.row}`));
  // 같은 차량번호의 회차청구 줄이 있는데 원 접수행이 이 줄을 가리키지 않거나 못 읽으면(행 이동 등) 연결 불명 — AE 를 쓰지 않는다.
  const installmentPlates = new Set(installmentLinks.map(l => l.plate));
  // 개별 합의 목록의 날짜도 같은 규칙으로 맞춘다(일련번호·날짜 글자 어느 쪽이든).
  const individualKeys = new Set((input.individualKeys ?? []).map(k => { const [p, d = ''] = k.split('|'); return `${plateKey(p)}|${isoDate(d)}`; }));

  // 수식 읽기는 값 읽기와 같은 시트 상태여야 한다: 줄 수가 같고, AE·AJ 와 수식 칸을 뺀 모든 칸이 같아야 한다
  // (두 번 읽는 사이 취소·청구·청구월·청구액·지급액·비고·계산 입력이 바뀌면 계획 전체를 멈춘다). 날짜 칸은 YYYY-MM-DD 로 맞춰 비교.
  const formulas = input.intakeFormulas;
  if (formulas) {
    if (formulas.length !== input.intake.length) throw new Error('F04_FORMULA_READ_MISMATCH');
    const fee = new Set([header.indexOf('판매수수료'), header.indexOf('출고수수료')]);
    // 수식이 하나라도 있는 열(배열 수식이 아래로 흘러 위 한 칸에만 수식이 보이는 파생 칸 포함)은 통째로 대조에서 뺀다.
    const derived = new Set<number>();
    formulas.forEach((r, i) => { if (i > hi) ((r as unknown[] | undefined) ?? []).forEach((x, c) => { if (formula(x)) derived.add(c); }); });
    const sameCell = (a: unknown, b: unknown) => {
      if (empty(a) && empty(b)) return true;
      if (a === b) return true;
      if (typeof a === 'boolean' || typeof b === 'boolean') return false;
      if (text(a) === text(b)) return true;
      return /^\d{4}\D/.test(isoDate(a)) && isoDate(a) === isoDate(b);
    };
    input.intake.forEach((r, i) => {
      if (i <= hi) return; // 설명·머리글 줄
      const v = (r as unknown[] | undefined) ?? [], f = (formulas[i] as unknown[] | undefined) ?? [];
      for (let c = 0; c < Math.max(v.length, f.length, header.length); c++) {
        if (fee.has(c) || derived.has(c)) continue;
        if (!sameCell(v[c], f[c])) throw new Error('F04_FORMULA_READ_MISMATCH');
      }
    });
  }
  const formulaAt = (sheetRow: number, col: number) => (formulas?.[sheetRow - 1] as unknown[] | undefined)?.[col];
  const rows = input.intake.slice(hi + 1).map((r, i) => ({ sheetRow: hi + 2 + i, cells: Array.isArray(r) ? r : [] }))
    .filter(r => !empty(r.cells[header.indexOf('차량번호')]));
  // 열쇠 = 차량번호 + 접수일. 겹치면 그 줄들은 판독 실패로 건드리지 않는다.
  const keyCount = new Map<string, number>();
  const key = (cells: unknown[]) => `${plateKey(cells[header.indexOf('차량번호')])}|${isoDate(cells[header.indexOf('접수일')])}`;
  for (const r of rows) keyCount.set(key(r.cells), (keyCount.get(key(r.cells)) ?? 0) + 1);

  const plan: F04ProjectionPlan = { schema: 'freepass-data.f04-commission-projection-plan/v1', policyId: KAKAO_COMMISSION_POLICY.policyId,
    readAt: input.readAt, openFromMonth: input.openFromMonth, rowsRead: rows.length, fills: [], blanks: [], diffs: [], closedDiffs: [], same: 0, skipped: {} };
  const skip = (why: string) => { plan.skipped[why] = (plan.skipped[why] ?? 0) + 1; };
  const [by, bm] = input.openFromMonth.split('-').map(Number) as [number, number];

  for (const { sheetRow, cells } of rows) {
    const row = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
    const plate = plateKey(row['차량번호']);
    if ((keyCount.get(key(cells)) ?? 0) > 1) { skip('DUPLICATE_KEY'); continue; }
    if (truthy(row['취소'])) { skip('CANCELLED'); continue; }
    // 청구년·청구월: 둘 다 빈칸이면 아직 안 정한 열린 줄. 하나만 있거나 숫자로 못 읽으면(«8월» 등) 판독 실패로 건드리지 않는다.
    const y = int(row['청구년']), m = int(row['청구월']);
    if ((empty(row['청구년']) !== empty(row['청구월'])) || (!empty(row['청구년']) && (y === null || m === null || m < 1 || m > 12))) { skip('BILLING_MONTH_UNREADABLE'); continue; }
    const closed = truthy(row['청구']) ? 'ALREADY_BILLED' : y !== null && m !== null && (y < by || (y === by && m < bm)) ? 'BILLING_MONTH_CLOSED' : null;
    const guarded = protectedSides(text(row['비고']));
    const individual = individualKeys.has(key(cells)) || /개별/.test(text(row['비고']));
    const built = individual ? { reason: 'INDIVIDUAL_AGREEMENT' } : f04RowInput(row, input.facts);
    if (closed) {
      // 닫힌 줄은 쓰지 않는다. 적힌 값이 계산과 다르면 사람 확인 목록에만.
      skip(closed);
      if ('input' in built) for (const column of ['AE', 'AJ'] as const) {
        const result = column === 'AE' ? resolveSupplierBillingFee(built.input) : resolveSalesCommission(built.input);
        const projected = projectedAmount(result), current = cells[colOf(column)];
        if (empty(current) || formula(current) || formula(formulaAt(sheetRow, colOf(column))) || (column === 'AE' && installmentPlates.has(plate)) || 'reason' in projected) continue;
        if (int(current) !== projected.value) plan.closedDiffs.push(diffOf(sheetRow, column, column, plate, current, projected.value, projected.ruleId));
      }
      continue;
    }
    for (const column of ['AE', 'AJ'] as const) {
      // 두 읽기(값·수식) 중 하나라도 대상 칸에 값이 있으면 빈칸이 아니다 — 그 사이 사람이 적은 값은 채우지 않고 대조한다.
      const second = formulaAt(sheetRow, colOf(column));
      if (formula(cells[colOf(column)]) || formula(second)) { skip('FORMULA_CELL'); continue; }
      const current = empty(cells[colOf(column)]) && formulas && !empty(second) ? second : cells[colOf(column)];
      if (column === 'AE' && installmentPlates.has(plate)) {
        const reason = installmentRows.has(`${plate}|${sheetRow}`) ? 'INSTALLMENT_TAB_HAS_CONTRACT' : 'INSTALLMENT_LINK_UNCLEAR';
        if (empty(current)) plan.blanks.push({ row: sheetRow, column, plate, reason }); else skip('AE_KEPT_INSTALLMENT_TAB');
        continue;
      }
      if ('reason' in built) { if (empty(current)) plan.blanks.push({ row: sheetRow, column, plate, reason: built.reason }); continue; }
      const result = column === 'AE' ? resolveSupplierBillingFee(built.input) : resolveSalesCommission(built.input);
      const projected = projectedAmount(result);
      if ('reason' in projected) { if (empty(current)) plan.blanks.push({ row: sheetRow, column, plate, reason: projected.reason }); continue; }
      if (!empty(current)) {
        if (int(current) === projected.value) plan.same++;
        else plan.diffs.push(diffOf(sheetRow, column, column, plate, current, projected.value, projected.ruleId));
        continue;
      }
      // 사람이 적은 청구액(U)·지급액(V)이 있고 계산값과 다르면(하허호 합의 등) 채우지 않고 차이 목록으로.
      const reference = cells[header.indexOf(column === 'AE' ? '청구액' : '지급액')];
      if (!empty(reference) && int(reference) !== projected.value) {
        plan.diffs.push(diffOf(sheetRow, column, column === 'AE' ? 'U' : 'V', plate, reference, projected.value, projected.ruleId));
        continue;
      }
      if (guarded.has(column)) { plan.blanks.push({ row: sheetRow, column, plate, reason: 'REMARK_AGREEMENT_NEEDS_PERSON' }); continue; }
      plan.fills.push({ row: sheetRow, column, plate, value: projected.value, ruleId: projected.ruleId });
    }
  }
  return plan;
}
