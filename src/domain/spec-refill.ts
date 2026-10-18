/** 제원 «빈 칸 다시 채움»(대표 2026-10-19 «연료가 빠지면 안 되는데 빠진 곳이 있다»): 한 번 제원 확인 표식(vehicle_spec_source_checked)이 찍힌 문서도
 * «문서 칸이 비어 있고 지금 원천에 형식이 맞는 값이 있으면» 그 칸만 다시 채운다. 이미 값이 있는 칸은 절대 덮지 않는다(빈 칸만).
 * 계획(application)과 쓰기(infra)가 같은 판정을 쓰도록 순수 함수 하나로 둔다 — 계획이 «채울 것 있음»으로 고른 문서는 쓰기에서 반드시 그 칸이 채워져
 * 다음 회차에 다시 고르지 않는다(되풀이 없음). */
import { SPEC_FORMAT_RULES } from './source-spec-validation.js';
import { canonicalFuel } from './fuel-alias.js';

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
