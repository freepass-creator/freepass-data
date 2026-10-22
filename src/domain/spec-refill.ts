/** 제원 «빈 칸 다시 채움»(대표 2026-10-19 «연료가 빠지면 안 되는데 빠진 곳이 있다»): 한 번 제원 확인 표식(vehicle_spec_source_checked)이 찍힌 문서도
 * «문서 칸이 비어 있고 지금 원천에 형식이 맞는 값이 있으면» 그 칸만 다시 채운다. 이미 값이 있는 칸은 절대 덮지 않는다(빈 칸만).
 * 계획(application)과 쓰기(infra)가 같은 판정을 쓰도록 순수 함수 하나로 둔다 — 계획이 «채울 것 있음»으로 고른 문서는 쓰기에서 반드시 그 칸이 채워져
 * 다음 회차에 다시 고르지 않는다(되풀이 없음). */
import { SPEC_FORMAT_RULES } from './source-spec-validation.js';
import { canonicalFuel, masterTrimRowsLookup, type TrimFuelRow, type TrimIdentity } from './fuel-alias.js';

/** 다시 채움 대상 칸(제원 입구 매핑 SPEC_FILL_KEYS 와 같은 목록). */
export const SPEC_REFILL_KEYS = ['ext_color', 'int_color', 'fuel_type', 'first_registration_date', 'year', 'mileage', 'engine_cc', 'seats'] as const;
export type SpecRefillKey = (typeof SPEC_REFILL_KEYS)[number];
const ELECTRIC = new Set(['전기', '수소']);

export const specValueBlank = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** 원천 제원(raw.spec)에서 «주어진 빈 칸들»에 쓸 수 있는 값. 연료는 별칭 표(canonicalFuel)로 표준 이름으로 바꾸고 차명과 어긋나면 뺀다.
 * 다른 칸은 정해진 형식(SPEC_FORMAT_RULES)일 때만. 전기·수소(문서 연료 또는 이번에 채울 연료)이면 배기량은 빼낸다. */
export function refillableSpecValues(spec: unknown, blankKeys: readonly string[], vehicleText?: unknown, docFuel?: unknown): Partial<Record<SpecRefillKey, string>> {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return {};
  const src = spec as Record<string, unknown>;
  const out: Partial<Record<SpecRefillKey, string>> = {};
  for (const key of SPEC_REFILL_KEYS) {
    if (!blankKeys.includes(key)) continue;
    const v = src[key];
    if (typeof v !== 'string' || !v.trim() || v.length > 40) continue;
    if (key === 'fuel_type') { const fuel = canonicalFuel(v, vehicleText); if (fuel) out.fuel_type = fuel; continue; }
    if (SPEC_FORMAT_RULES[key]?.(v.trim())) out[key] = v.trim();
  }
  const fuel = typeof docFuel === 'string' && docFuel.trim() ? docFuel.trim() : out.fuel_type ?? '';
  if (ELECTRIC.has(fuel)) delete out.engine_cc;
  return out;
}

/** 마스터 연료 보완(대표 2026-10-19 요령 «마스터» 열): 원천 제원에 연료 칸이 «아예 없을 때만»(있는데 해석이 안 되거나 차명과 어긋나면 보류 — 마스터로 덮지 않는다, Codex 검토)
 * 계획이 읽기 경로에서 받아 고정한 마스터 연료(plannedMasterFuel)를 쓰고, 그 값도 차명과 어긋나지 않을 때만. 계획·쓰기가 같은 함수를 쓴다. */
export function masterFuelFallback(raw: unknown, plannedMasterFuel: unknown, vehicleText?: unknown): string | null {
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const r = obj(raw);
  // 원천 연료 원문이 어느 자리에든 있으면(제원 칸, 손오공 목록·상세, 이안카 원문, 오토플러스 원문 표기) 마스터로 보완하지 않는다.
  const sourceTexts = [obj(r.spec).fuel_type, obj(r.list).fuel, obj(r.detail).fuel, obj(obj(r.detail).data).fuel, r.fuel, r.source_fuel_text];
  // 빈 값(없음·null·빈 문자열)만 «없음»이다. 숫자·객체 등 형식이 틀린 값도 «원천에 있음»으로 보고 마스터로 보완하지 않는다(Codex 3차 검토).
  if (sourceTexts.some(v => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim()))) return null;
  return typeof plannedMasterFuel === 'string' ? canonicalFuel(plannedMasterFuel, vehicleText) : null;
}

/** 마스터 제원 보완(대표 2026-10-22 «F01/ERP5 빈칸이 너무 많다» — 손오공·이안카 API 는 인승·구동방식·배기량을 주지 않는다): 문서 칸 이름 그대로.
 * 마스터 연료 보완(masterFuelFallback)과 같은 원칙 — 빈 칸만, 원천에 값이 있으면 원천 우선(마스터로 덮지 않음), 트림 단위로 하나로 정해질 때만, 전기·수소는 배기량 제외. */
export const MASTER_SPEC_KEYS = ['seats', 'drive_type', 'engine_cc'] as const;
export type MasterSpecKey = (typeof MASTER_SPEC_KEYS)[number];
export type MasterSpecValues = Partial<Record<MasterSpecKey, string>>;
/** 구동방식 표준 값(공유 시트 정규화 normalize-shared-sheet 와 같은 목록). 마스터 drivetrain 은 verifiedMasterRecords 가 FWD/RWD→2WD, 4MATIC 등→AWD 로 맞춰 둔다. 목록 밖은 쓰지 않는다. */
export const DRIVE_TYPE_VALUES: ReadonlySet<string> = new Set(['2WD', 'AWD', '4WD']);
export const masterSpecValid = (key: MasterSpecKey, v: unknown): v is string =>
  typeof v === 'string' && (key === 'drive_type' ? DRIVE_TYPE_VALUES.has(v) : !!SPEC_FORMAT_RULES[key]?.(v));
const textOf = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
/** 행 값들이 «모두 있고 하나로» 모일 때만 그 값(하나라도 비거나 형식 밖이면, 또는 둘 이상으로 갈리면 null — 여러 후보면 보류). */
const uniqueOf = (values: ReadonlyArray<string | null>): string | null =>
  !values.length || values.some(v => v === null) ? null : new Set(values).size === 1 ? values[0]! : null;

/** 확정 정체성 + 마스터 연결(vehicle_master_id)의 문서 → 마스터 제원(트림 행들이 하나로 모이는 칸만). 순수.
 * 행 선택은 마스터 연료와 같은 masterTrimRowsLookup(이름·별칭·연식·배기량) + 문서의 vehicle_master_id 와 같은 마스터 행만.
 * 문서에 이미 있는 연료·구동·인승과 «정면으로» 어긋나는 행은 뺀다(행에 그 값이 없거나 해석이 안 되면 남겨 후보로 센다 — 후보를 줄여 억지로 하나로 만들지 않는다). */
export type MasterSpecIdentity = TrimIdentity & { master_id: string; fuel_type?: string; drive_type?: string; seats?: string };
export function masterTrimSpecLookup(records: ReadonlyArray<TrimFuelRow>) {
  const rowsOf = masterTrimRowsLookup(records);
  return (identity: MasterSpecIdentity): MasterSpecValues => {
    const masterId = textOf(identity.master_id);
    if (!masterId) return {};
    let rows = rowsOf(identity).filter(r => r.masterId === masterId);
    const docFuel = canonicalFuel(identity.fuel_type);
    if (docFuel) rows = rows.filter(r => { const f = canonicalFuel(r.specs?.fuel ?? null); return !f || f === docFuel; });
    const docDrive = textOf(identity.drive_type).toUpperCase();
    if (DRIVE_TYPE_VALUES.has(docDrive)) rows = rows.filter(r => !DRIVE_TYPE_VALUES.has(r.specs?.drive ?? '') || r.specs!.drive === docDrive);
    const docSeats = /^\d{1,2}$/.test(textOf(identity.seats)) ? Number(textOf(identity.seats)) : null;
    if (docSeats !== null) rows = rows.filter(r => r.specs?.seats == null || r.specs.seats === docSeats);
    if (!rows.length) return {};
    const out: MasterSpecValues = {};
    const seats = uniqueOf(rows.map(r => (typeof r.specs?.seats === 'number' && Number.isInteger(r.specs.seats) ? String(r.specs.seats) : null)));
    if (masterSpecValid('seats', seats)) out.seats = seats;
    const drive = uniqueOf(rows.map(r => (DRIVE_TYPE_VALUES.has(r.specs?.drive ?? '') ? r.specs!.drive! : null)));
    if (masterSpecValid('drive_type', drive)) out.drive_type = drive;
    // 전기·수소(문서 연료 또는 후보 행 연료)에는 배기량을 채우지 않는다.
    const electric = ELECTRIC.has(docFuel ?? '') || rows.some(r => ELECTRIC.has(canonicalFuel(r.specs?.fuel ?? null) ?? ''));
    const cc = uniqueOf(rows.map(r => (typeof r.specs?.displacementCc === 'number' && Number.isInteger(r.specs.displacementCc) ? String(r.specs.displacementCc) : null)));
    if (!electric && masterSpecValid('engine_cc', cc)) out.engine_cc = cc;
    return out;
  };
}

/** 계획 단계 마스터 제원 보완 판정(masterFuelFallback 과 같은 자리·같은 원칙): 읽기 경로가 고정한 마스터 제원(planned) 중
 * 이번 관측 원천(검증·압축 전 원문)에 그 칸 원문이 «아예 없는» 칸만 남긴다. 원천에 값이 있으면(형식이 틀려도) 원천 우선이라 마스터로 채우지 않는다. 계획·쓰기가 같은 결과를 쓴다. */
/** 배기량 충돌 판정 허용 오차(상대): 반올림·표기 차이는 같은 차로 보고 배기량 급이 다르면 충돌. */
const CC_TOLERANCE = 0.05;
export function masterSpecFallback(raw: unknown, planned: unknown): MasterSpecValues | null {
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const p = obj(planned), r = obj(raw), spec = obj(r.spec);
  const present = (v: unknown) => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim());
  // 원천 원문 «전체»(손오공 list·detail, 시트 headers/cells 포함)에서 칸 이름이 그 제원인 값을 찾는다 — 정규화에서 빠진 원천값(해석 못 한 값 포함)을
  // «빈 칸»으로 오인해 마스터로 덮지 않게 한다(원천 우선, 2026-10-22 Codex 검토 P1). 칸 이름은 정확 일치(driver_age 같은 이름과 섞이지 않게).
  const NAME: Record<MasterSpecKey, RegExp> = {
    seats: /^(seats?|seating\S*|capacity|passengers?|인승\S*|승차정원\S*)$/i,
    drive_type: /^(drive|drive_?type|drivetrain|driving_?wheel\S*|구동\S*)$/i,
    engine_cc: /^(engine_?cc|displacement\S*|cc|배기량\S*|engine_?size)$/i,
  };
  const found: Record<MasterSpecKey, unknown[]> = { seats: [], drive_type: [], engine_cc: [] };
  const walk = (o: unknown, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 5) return;
    if (Array.isArray(o)) { for (const x of o.slice(0, 200)) walk(x, depth + 1); return; }
    const rec = o as Record<string, unknown>;
    if (Array.isArray(rec.headers) && Array.isArray(rec.cells)) {   // 시트 줄: 머리글 ↔ 칸 짝
      rec.headers.forEach((h, i) => { for (const key of MASTER_SPEC_KEYS) if (typeof h === 'string' && NAME[key].test(h.trim()) && present((rec.cells as unknown[])[i])) found[key].push((rec.cells as unknown[])[i]); });
    }
    for (const [k, v] of Object.entries(rec)) {
      for (const key of MASTER_SPEC_KEYS) if (NAME[key].test(k) && present(v) && (typeof v !== 'object' || v === null)) found[key].push(v);
      walk(v, depth + 1);
    }
  };
  walk(r, 0);
  // 원천에 그 칸 값이 하나라도 있으면(형식이 틀려도) 마스터로 채우지 않는다. 기존에 보던 자리(spec.*·최상위)도 그대로 포함한다.
  const legacy: Record<MasterSpecKey, unknown[]> = {
    seats: [spec.seats, r.seats], drive_type: [spec.drive_type, spec.drivetrain, spec.drive, r.drive_type, r.drivetrain], engine_cc: [spec.engine_cc, spec.displacement, r.engine_cc],
  };
  const sourceHas = (key: MasterSpecKey) => found[key].length > 0 || legacy[key].some(present);
  // 이번 원천이 마스터 후보와 «정면으로» 다른 값을 주면(해석되는 인승·배기량 숫자가 다름, 구동이 다름) 그 마스터 후보는 이 차가 아니다 → 전부 보류(Codex P1).
  const digits = (v: unknown): number | null => { const m = /\d[\d,]*/.exec(String(v)); const n = m ? Number(m[0].replace(/,/g, '')) : NaN; return Number.isFinite(n) ? n : null; };
  const conflicts = (key: MasterSpecKey): boolean => {
    const want = p[key]; if (!masterSpecValid(key, want)) return false;
    const vals = [...found[key], ...legacy[key].filter(present)];
    if (key === 'drive_type') return vals.some(v => DRIVE_TYPE_VALUES.has(String(v).trim().toUpperCase()) && String(v).trim().toUpperCase() !== want);
    return vals.some(v => { const n = digits(v); if (n === null) return false; const w = Number(want); return key === 'engine_cc' ? Math.abs(n - w) / w > CC_TOLERANCE : n !== w; });   // 배기량은 반올림(1,600 ↔ 1,598)·같은 계열 표기 차이를 허용하고 배기량 급(1.6 ↔ 2.0)이 다르면 충돌
  };
  if (MASTER_SPEC_KEYS.some(conflicts)) return null;
  const out: MasterSpecValues = {};
  for (const key of MASTER_SPEC_KEYS) {
    const v = p[key];
    if (!masterSpecValid(key, v) || sourceHas(key)) continue;
    out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** 쓰기 단계: 계획이 고정한 마스터 제원(masterSpecFallback 을 거친 값) 중 문서 칸이 «지금도 비어 있고» 이번 쓰기에서 원천 값으로 채우지 않는 칸만.
 * 최종 연료(문서 연료 또는 이번에 채울 연료)가 전기·수소이면 배기량은 뺀다. */
export function masterSpecFillValues(original: Readonly<Record<string, unknown>>, filled: Readonly<Record<string, unknown>>, masterSpecs: unknown): MasterSpecValues {
  const m = masterSpecs && typeof masterSpecs === 'object' && !Array.isArray(masterSpecs) ? masterSpecs as Record<string, unknown> : {};
  const out: MasterSpecValues = {};
  for (const key of MASTER_SPEC_KEYS) {
    const v = m[key];
    if (masterSpecValid(key, v) && specValueBlank(original[key]) && filled[key] === undefined) out[key] = v;
  }
  const fuel = textOf(original.fuel_type) || textOf(filled.fuel_type);
  if (ELECTRIC.has(fuel)) delete out.engine_cc;
  return out;
}
