export type SheetBlankFillInput = {
  spreadsheetId: string;
  capturedAt: string;
  tabs: Record<string, { headers: string[]; rows: Array<{ row: number; values: Array<string | number | null>; formulaCols?: number[] }> }>;
  vehicles: Record<string, {
    confirmed: boolean;
    evidence: string;
    needsConfirmation?: string[];
    fields: Record<string, string | number | null | undefined>;
  }>;
  /** 정책확인 탭 MATCHED 줄: «탭:행» → 정책코드 + 그 줄의 차량번호(시트 줄의 차량번호와 대조 — 정렬이 바뀌면 건너뜀). */
  policyLinks: Record<string, { code: string; plate: string }>;
  policies: Record<string, Record<string, unknown>>;
};

export type SheetBlankFillPlan = {
  시트ID: string;
  이유: '공통 시트 빈 칸 채우기(정본 값)';
  요청자: 'B3Q FREEPASS-DATA 빈 칸 채우기 계획기';
  근거: '프리패스 데이터 정본(차량 확인·정책 정정기 근거)';
  바꿀칸: Array<{ 범위: string; 전: ''; 후: string | number }>;
  /** 시트고치기 «줄확인»: 쓰지 않고 같은 줄의 차량번호 칸만 대조 — 계획 뒤 줄이 움직여 다른 차에 쓰는 일을 막는다(시트고치기 줄확인 지원 판 필요). */
  줄확인: Array<{ 범위: string; 값: string }>;
};

export type SheetBlankFillReport = {
  capturedAt: string;
  counts: { 채울칸: number; 탭별: Record<string, number>; 칸별: Record<string, number> };
  skipped: Array<{ 탭: string; 행: number; 차량번호: string; 칸: string; 사유: SkipReason }>;
  differences: Array<{ 탭: string; 행: number; 차량번호: string; 칸: string; 시트값: unknown; 정본값: string | number; 층: '차량' | '정책' | '판매방침' }>;
  skippedCounts: Partial<Record<SkipReason, number>>;
};

type SkipReason = 'WHITESPACE_ONLY' | 'POLICY_LINK_MISMATCH' | 'INVALID_NUMBER' | 'NEEDS_CONFIRMATION' | 'NO_EVIDENCE' | 'NOT_CONFIRMED' | 'NO_CANON' | 'POLICY_NOT_CORRECTED' | 'NO_POLICY_LINK' | 'FORMULA_CELL' | 'HEADER_MISSING' | 'HEADER_DUPLICATE';
type Canon = { value: string | number; layer: '차량' | '정책' | '판매방침' } | { skip: SkipReason };

const VEHICLE_FIELDS: Record<string, string> = {
  제조사: 'maker', 모델: 'model', 세부모델: 'sub_model', 세부트림: 'trim_name', 연식: 'year', 배기량: 'engine_cc', 연료: 'fuel_type',
  인승: 'seats', 구동방식: 'drivetrain', 차종크기: 'size_class', 차종구분: 'body_type', 원산지: 'origin',
};
const NUMBER_HEADERS = new Set(['연식', '배기량', '인승']);
const POLICY_FIELDS: Record<string, string> = {
  기본연령: 'basic_driver_age', 면허기간: 'license_period', 연주행: 'annual_mileage', '1만km+': 'mileage_upcharge_per_10000km',
  분납: 'deposit_installment', 보험료: 'insurance_included', 심사: 'screening_criteria', 보증금카드: 'deposit_card_payment',
  대인한도: 'injury_compensation_limit', 대인면책: 'injury_deductible', 대물한도: 'property_compensation_limit', 대물면책: 'property_deductible',
  자차한도: 'own_damage_compensation', 자차수리비: 'own_damage_repair_ratio', 자손한도: 'self_body_accident', 자손면책: 'self_body_deductible',
  무보험한도: 'uninsured_damage', 무보험면책: 'uninsured_deductible', 추가운전인원: 'additional_driver_allowance_count',
  추가운전요금: 'additional_driver_cost', 정비: 'maintenance_service', 긴급출동: 'annual_roadside_assistance', 지역: 'rental_region',
  탁송비: 'delivery_fee', 승계: 'succession_allowed', 승계비: 'succession_fee', 최대연령: 'driver_age_upper_limit',
  개인운전자: 'personal_driver_scope', 법인운전자: 'business_driver_scope',
};
const SALES_AGE: Record<string, string> = { '21세+': 'age_21_cost', '23세+': 'age_23_cost' };
const TARGET_HEADERS = [...Object.keys(VEHICLE_FIELDS), ...Object.keys(POLICY_FIELDS), ...Object.keys(SALES_AGE), '자차면책'];

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
// 시트 칸의 «빈 칸» = null·undefined·'' 만. 공백만 있는 칸은 사람이 지운 흔적일 수 있어 빈 칸이 아니다(건너뜀).
const blankCell = (v: unknown) => v === null || v === undefined || v === '';
const whitespaceOnly = (v: unknown) => typeof v === 'string' && v !== '' && v.trim() === '';
// 정본 값이 비었는지(공백만 있어도 빔).
const empty = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const normalize = (v: unknown) => text(v).replace(/\s+/g, '').replace(/^보험료/, '').replace(/불가능/g, '불가');
const colName = (i: number) => { let n = i + 1, s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
// 숫자 칸(연식·배기량·인승)은 순수 숫자(또는 순수 숫자 글자)만 넣는다. «1,598»·«2024년» 같은 값은 숫자가 아니라 건너뜀.
const toSheetNumber = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : /^\d+(?:\.\d+)?$/.test(text(v)) ? Number(text(v)) : NaN;
  return Number.isFinite(n) ? n : null;
};
const fieldEvidence = (policy: Record<string, unknown>, field: string) =>
  (policy.field_evidence as Record<string, { writer?: string }> | undefined)?.[field]?.writer === 'policy-corrector';
const policyValue = (policy: Record<string, unknown>, field: string) => (policy as Record<string, unknown>)[field];

export function planSheetBlankFill(input: SheetBlankFillInput): { plan: SheetBlankFillPlan; report: SheetBlankFillReport } {
  const captured = Date.parse(input.capturedAt);
  if (!Number.isFinite(captured) || Date.now() - captured > 15 * 60_000) throw new Error('SHEET_BLANK_FILL_CAPTURE_STALE');
  const plan: SheetBlankFillPlan = { 시트ID: input.spreadsheetId, 이유: '공통 시트 빈 칸 채우기(정본 값)', 요청자: 'B3Q FREEPASS-DATA 빈 칸 채우기 계획기', 근거: '프리패스 데이터 정본(차량 확인·정책 정정기 근거)', 바꿀칸: [], 줄확인: [] };
  const report: SheetBlankFillReport = { capturedAt: input.capturedAt, counts: { 채울칸: 0, 탭별: {}, 칸별: {} }, skipped: [], differences: [], skippedCounts: {} };
  const addSkip = (탭: string, 행: number, 차량번호: string, 칸: string, 사유: SkipReason) => {
    report.skipped.push({ 탭, 행, 차량번호, 칸, 사유 });
    report.skippedCounts[사유] = (report.skippedCounts[사유] ?? 0) + 1;
  };
  const addFill = (탭: string, row: number, col: number, header: string, value: string | number) => {
    plan.바꿀칸.push({ 범위: `${탭}!${colName(col)}${row}`, 전: '', 후: value });
    report.counts.탭별[탭] = (report.counts.탭별[탭] ?? 0) + 1;
    report.counts.칸별[header] = (report.counts.칸별[header] ?? 0) + 1;
  };
  const canonFor = (tab: string, row: number, plate: string, header: string): Canon => {
    if (VEHICLE_FIELDS[header]) {
      const vehicle = input.vehicles[plate];
      if (!vehicle?.confirmed) return { skip: 'NOT_CONFIRMED' };
      if (empty(vehicle.evidence)) return { skip: 'NO_EVIDENCE' };
      if (vehicle.needsConfirmation?.includes(header)) return { skip: 'NEEDS_CONFIRMATION' };
      const raw = vehicle.fields[VEHICLE_FIELDS[header]!];
      if (empty(raw)) return { skip: 'NO_CANON' };
      if (NUMBER_HEADERS.has(header)) {
        const n = toSheetNumber(raw);
        return n === null ? { skip: 'INVALID_NUMBER' } : { value: n, layer: '차량' };
      }
      return { value: text(raw), layer: '차량' };
    }
    const link = input.policyLinks[`${tab}:${row}`];
    if (!link?.code) return { skip: 'NO_POLICY_LINK' };
    if (link.plate !== plate) return { skip: 'POLICY_LINK_MISMATCH' };
    const policy = input.policies[link.code];
    if (!policy) return { skip: 'NO_POLICY_LINK' };
    if (SALES_AGE[header]) {
      const field = SALES_AGE[header]!;
      const sales = (policy.sales_policy as Record<string, { value?: unknown }> | undefined)?.[field]?.value;
      if (!empty(sales)) return { value: typeof sales === 'number' ? sales : text(sales), layer: '판매방침' };
      if (!fieldEvidence(policy, field)) return { skip: 'POLICY_NOT_CORRECTED' };
      const v = policyValue(policy, field);
      return empty(v) ? { skip: 'NO_CANON' } : { value: typeof v === 'number' ? v : text(v), layer: '정책' };
    }
    if (header === '자차면책') {
      if (!fieldEvidence(policy, 'own_damage_min_deductible') || !fieldEvidence(policy, 'own_damage_max_deductible')) return { skip: 'POLICY_NOT_CORRECTED' };
      const min = policyValue(policy, 'own_damage_min_deductible'), max = policyValue(policy, 'own_damage_max_deductible');
      if (empty(min) || empty(max)) return { skip: 'NO_CANON' };
      const a = text(min), b = text(max);
      return { value: normalize(a) === normalize(b) ? a : `${a.replace(/만원$/, '')}~${b}`, layer: '정책' };
    }
    const field = POLICY_FIELDS[header];
    if (!field) return { skip: 'NO_CANON' };
    if (!fieldEvidence(policy, field)) return { skip: 'POLICY_NOT_CORRECTED' };
    const raw = policyValue(policy, field);
    if (empty(raw)) return { skip: 'NO_CANON' };
    const value = header === '보험료' && typeof raw === 'string' ? raw.trim().replace(/^보험료\s*/, '') : raw;
    return { value: typeof value === 'number' ? value : text(value), layer: '정책' };
  };

  for (const [tab, sheet] of Object.entries(input.tabs)) {
    const index = new Map<string, number>();
    const duplicates = new Set<string>();
    sheet.headers.forEach((h, i) => { if (!h) return; if (index.has(h)) duplicates.add(h); else index.set(h, i); });
    const missing = ['차량번호', ...TARGET_HEADERS].filter(h => !index.has(h));
    const bad = [...missing.map(h => ['HEADER_MISSING', h] as const), ...[...duplicates].map(h => ['HEADER_DUPLICATE', h] as const)];
    if (bad.length) {
      for (const r of sheet.rows) for (const [reason, h] of bad) addSkip(tab, r.row, text(r.values[index.get('차량번호') ?? -1]), h, reason);
      continue;
    }
    for (const r of sheet.rows) {
      if (r.row < 2) continue;
      const plate = text(r.values[index.get('차량번호')!]);
      if (!plate) continue;
      if (!Array.isArray(r.formulaCols)) throw new Error('SHEET_BLANK_FILL_FORMULA_READ_REQUIRED');
      const formulaCols = new Set(r.formulaCols);
      for (const header of TARGET_HEADERS) {
        const col = index.get(header)!;
        const current = r.values[col];
        const canon = canonFor(tab, r.row, plate, header);
        if (formulaCols.has(col)) { addSkip(tab, r.row, plate, header, 'FORMULA_CELL'); continue; }
        if (whitespaceOnly(current)) { addSkip(tab, r.row, plate, header, 'WHITESPACE_ONLY'); continue; }
        if ('skip' in canon) { if (blankCell(current)) addSkip(tab, r.row, plate, header, canon.skip); continue; }
        if (blankCell(current)) addFill(tab, r.row, col, header, canon.value);
        else if (normalize(current) !== normalize(canon.value)) report.differences.push({ 탭: tab, 행: r.row, 차량번호: plate, 칸: header, 시트값: current, 정본값: canon.value, 층: canon.layer });
      }
    }
  }
  // 줄확인: 채우는 줄마다 같은 줄의 차량번호 칸을 «대조만» 하도록 계획에 같이 넣는다.
  const plateByRow = new Map<string, { 범위: string; 값: string }>();
  for (const [tab, sheet] of Object.entries(input.tabs)) {
    const plateCol = sheet.headers.indexOf('차량번호');
    if (plateCol < 0) continue;
    for (const r of sheet.rows) {
      const plate = text(r.values[plateCol]);
      if (!plate) continue;
      if (plan.바꿀칸.some((c) => c.범위.startsWith(`${tab}!`) && Number(c.범위.slice(tab.length + 1).replace(/^[A-Z]+/, '')) === r.row)) plateByRow.set(`${tab}:${r.row}`, { 범위: `${tab}!${colName(plateCol)}${r.row}`, 값: plate });
    }
  }
  plan.줄확인 = [...plateByRow.values()].sort((a, b) => a.범위.localeCompare(b.범위, 'ko', { numeric: true }));
  plan.바꿀칸.sort((a, b) => a.범위.localeCompare(b.범위, 'ko', { numeric: true }));
  const seen = new Set<string>();
  for (const c of plan.바꿀칸) { if (seen.has(c.범위)) throw new Error('SHEET_BLANK_FILL_DUPLICATE_CELL'); seen.add(c.범위); }
  if (plan.바꿀칸.length > 2000) throw new Error('SHEET_BLANK_FILL_TOO_MANY_CELLS');
  report.counts.채울칸 = plan.바꿀칸.length;
  return { plan, report };
}
