/** 이안카(RP031) 상품 ↔ 공통 정책 연결 계획 — 순수 함수(저장소·네트워크 접근 없음, 시험 가능).
 * 배경: 1차 발행(ONE API)이 정책 연결을 DEFERRED 로 비워 노출 이안카 94대 전부 policy_code 가 null 이다 → ERP5 상세가 «보험 조건 미등록».
 * 결정(대표 10-12): 이안카 정책은 만 26세 이상·연 20,000km 기본, 연령 상한은 원천(ONE) 값(만 65세). «공급사 원천 우선» —
 * 연령·면허·보험(자차 포함·면책금·수리 한도)·초과 주행 요금을 ONE 요금 원문의 보험 정보에서 당겨 온다.
 * 원칙: 모든 차량이 같은 값이면 공통 정책 FP-RP031-RENT 칸에 반영, 차량마다 다르면(면책금·수리 한도·초과 주행 요금·휴차료 등)
 * 공통 정책 하나로 뭉개지 않고 차량별로 상품 문서 `iancar_policy_terms` 에 보존한다(출처·관측 시각 포함). S01~S04 는 보존·삭제 없음. */
import { stableDigest } from '../shared/stable-digest.js';

export const IANCAR_COMMON_POLICY_CODE = 'FP-RP031-RENT';
export const IANCAR_BASE_ANNUAL_MILEAGE = '연 20,000km';
/** 공통 정책 문서에서 이 계획이 바꿀 수 있는 칸(그 밖의 칸 변경은 계획을 막는다). */
export const IANCAR_POLICY_PATCH_FIELDS = ['basic_driver_age', 'driver_age_upper_limit', 'license_period', 'injury_deductible', 'property_deductible',
  'own_damage_min_deductible', 'own_damage_max_deductible', 'annual_mileage', 'iancar_source_terms'];

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => (typeof value === 'string' ? value : null);
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** 차량 한 대의 원천(ONE 요금 원문) 보험·추가요금 조건. */
export type VehicleTerms = {
  source: 'ONE_RATES'; observedAt: string;
  minimumDriverAge: number; maximumDriverAge: number; minimumLicenseMonths: number;
  ownDamageIncluded: boolean; ownDamageDeductible: number; ownDamageMinimumFaultPercent: number;
  personalInjuryDeductible: number; propertyDamageDeductible: number; repairLimit: number;
  age24Surcharge: number | string | null; perPanelRepair: number; excessMileageFeePerKm: number;
  dailyLossOrLateReturnFeeByTerm: Record<string, number>; vatIncluded: boolean;
};

const priceKey = (row: Rec) => `${row.rental_period}_${row.mileage_period === 'year' ? '연' : '월'}${row.contracted_mileage}km`;

/** 요금 행들에서 차량 조건을 뽑는다. 보험·추가요금(휴차료 제외)·초과 주행 요금이 행마다 다르면 추정하지 않고 오류. */
export function extractVehicleTerms(rows: unknown, observedAt: string): { ok: true; terms: VehicleTerms } | { ok: false; reason: string } {
  if (!Array.isArray(rows) || !rows.length || !rows.every(isRec)) return { ok: false, reason: 'RATES_EMPTY_OR_INVALID' };
  const list = rows as Rec[];
  const stable = (row: Rec) => JSON.stringify([row.insurance, isRec(row.additional_charges) ? { ...row.additional_charges, daily_loss_or_late_return_fee: undefined } : null, row.excess_mileage_fee, row.vat_included]);
  if (list.some(row => stable(row) !== stable(list[0]!))) return { ok: false, reason: 'ROWS_INCONSISTENT' };
  const first = list[0]!;
  const ins = first.insurance, add = first.additional_charges;
  if (!isRec(ins) || !isRec(add)) return { ok: false, reason: 'INSURANCE_MISSING' };
  const fees: Record<string, number> = {};
  for (const row of list) {
    const value = isRec(row.additional_charges) ? row.additional_charges.daily_loss_or_late_return_fee : undefined;
    if (!isInt(value)) return { ok: false, reason: 'DAILY_LOSS_FEE_INVALID' };
    fees[priceKey(row)] = value;
  }
  const age24 = ins.age_24_surcharge;
  const need = [ins.minimum_driver_age, ins.maximum_driver_age, ins.minimum_license_months, ins.own_damage_deductible, ins.deductible_minimum_own_fault_percent,
    ins.personal_injury_deductible, ins.property_damage_deductible, ins.repair_limit, add.per_panel_repair, first.excess_mileage_fee];
  if (!need.every(isInt) || typeof ins.own_damage_included_in_rental !== 'boolean' || typeof first.vat_included !== 'boolean'
    || !(age24 === null || typeof age24 === 'string' || isInt(age24))) return { ok: false, reason: 'INSURANCE_FIELD_INVALID' };
  return { ok: true, terms: {
    source: 'ONE_RATES', observedAt,
    minimumDriverAge: ins.minimum_driver_age as number, maximumDriverAge: ins.maximum_driver_age as number, minimumLicenseMonths: ins.minimum_license_months as number,
    ownDamageIncluded: ins.own_damage_included_in_rental, ownDamageDeductible: ins.own_damage_deductible as number, ownDamageMinimumFaultPercent: ins.deductible_minimum_own_fault_percent as number,
    personalInjuryDeductible: ins.personal_injury_deductible as number, propertyDamageDeductible: ins.property_damage_deductible as number, repairLimit: ins.repair_limit as number,
    age24Surcharge: age24 as number | string | null, perPanelRepair: add.per_panel_repair as number, excessMileageFeePerKm: first.excess_mileage_fee as number,
    dailyLossOrLateReturnFeeByTerm: fees, vatIncluded: first.vat_included } };
}

export type PolicyLinkInput = {
  policy: { exists: boolean; updateTimeMs: number | null; data: Rec };
  products: { id: string; updateTimeMs: number; data: Rec }[];
  /** 상품 문서 ID → 원천 조건(원천에서 사라졌거나 읽지 못하면 없음) */
  vehicleTerms: Record<string, VehicleTerms | undefined>;
  /** 원천 조회 실패 사유(차량별, 계획에 표시) */
  vehicleTermsErrors?: Record<string, string>;
};

const won10k = (value: number) => (value % 10000 === 0 ? `${value / 10000}만원` : `${value}원`);
const licenseText = (months: number) => (months % 12 === 0 ? `${months / 12}년 이상` : `${months}개월 이상`);

/** 정책 연결된 상품을 1차 발행(동기화)이 다시 비우지 않게 하는 필드 계산. 연결되지 않은 상품은 기존 동작(DEFERRED·원래 값 보존) 그대로. */
export function iancarPolicyFields(old: Rec): { policy_code: string | null; policy_code_source_original: unknown; policy_reference_state: 'LINKED' | 'DEFERRED' } {
  const linked = old.policy_reference_state === 'LINKED' && typeof old.policy_code === 'string' && !!old.policy_code.trim();
  if (linked) return { policy_code: old.policy_code as string, policy_code_source_original: old.policy_code_source_original ?? null, policy_reference_state: 'LINKED' };
  return { policy_code: null, policy_code_source_original: old.policy_code ?? old.policy_code_source_original ?? null, policy_reference_state: 'DEFERRED' };
}

const uniform = <T>(values: T[]): { same: true; value: T } | { same: false; distribution: Record<string, number> } => {
  const distribution: Record<string, number> = {};
  for (const value of values) distribution[JSON.stringify(value)] = (distribution[JSON.stringify(value)] ?? 0) + 1;
  return Object.keys(distribution).length === 1 ? { same: true, value: values[0]! } : { same: false, distribution };
};

/** 계획 범위. ALL = 노출 이안카 전부를 공통 정책에 연결하고 공통 정책 문서도 원천 값으로 맞춘다(#565 원래 동작). NULL_POLICY_ONLY = policy_code 가 «비어 있는» 노출 상품만 공통 정책에 연결하고
 * 이미 정책(S01~S04 등)이 있는 상품과 정책 문서는 건드리지 않는다(대표 2026-10-22: 고객 안내 조건 변경은 따로 결정) — 차량별 iancar_policy_terms 기록은 그대로 함께 한다. */
export type PolicyLinkScope = 'ALL' | 'NULL_POLICY_ONLY';
export const isPolicyEmpty = (data: Rec): boolean => data.policy_code === null || data.policy_code === undefined || (typeof data.policy_code === 'string' && data.policy_code.trim() === '');

export function buildPolicyLinkPlan(input: PolicyLinkInput, options: { scope?: PolicyLinkScope } = {}) {
  const scope: PolicyLinkScope = options.scope ?? 'ALL';
  const writesPolicyDocument = scope === 'ALL';
  const blockers: string[] = [];
  if (!input.policy.exists) blockers.push('COMMON_POLICY_MISSING');
  const policyBefore = input.policy.data;

  const targets = input.products.filter(p => p.data.provider_company_code === 'RP031' && p.data.listable === true && (scope === 'ALL' || isPolicyEmpty(p.data)));
  const withTerms = targets.filter(p => input.vehicleTerms[p.id]);
  const terms = withTerms.map(p => input.vehicleTerms[p.id]!);
  const observedAts = [...new Set(terms.map(t => t.observedAt))].sort();

  // 공통 정책: 모든 차량이 같은 값일 때만 원천 값을 반영한다. 차량마다 다르면 공통에 넣지 않고 varies 로 기록(차량별 보존).
  const derived: Rec = {}, varies: Record<string, Record<string, number>> = {};
  const policyPatch: Rec = {};
  const setCommon = (policyField: string, value: string) => { derived[policyField] = value; if (writesPolicyDocument && text(policyBefore[policyField]) !== value) policyPatch[policyField] = value; };
  if (terms.length) {
    const take = <K extends keyof VehicleTerms>(key: K) => uniform(terms.map(t => t[key]));
    const minAge = take('minimumDriverAge'), maxAge = take('maximumDriverAge'), lic = take('minimumLicenseMonths');
    const injury = take('personalInjuryDeductible'), property = take('propertyDamageDeductible'), included = take('ownDamageIncluded');
    if (minAge.same) setCommon('basic_driver_age', `만 ${minAge.value}세 이상`); else varies.minimumDriverAge = minAge.distribution;
    if (maxAge.same) setCommon('driver_age_upper_limit', `만 ${maxAge.value}세 이하`); else varies.maximumDriverAge = maxAge.distribution;
    if (lic.same) setCommon('license_period', licenseText(lic.value)); else varies.minimumLicenseMonths = lic.distribution;
    if (injury.same) setCommon('injury_deductible', won10k(injury.value)); else varies.personalInjuryDeductible = injury.distribution;
    if (property.same) setCommon('property_deductible', won10k(property.value)); else varies.propertyDamageDeductible = property.distribution;
    if (!included.same || included.value !== true) varies.ownDamageIncluded = included.same ? { [JSON.stringify(included.value)]: terms.length } : included.distribution;
    // 자차 면책금은 차량마다 다르면 공통 정책에는 «범위»(최소~최대)만 둔다 — 차량별 값은 상품 문서에 보존.
    const own = terms.map(t => t.ownDamageDeductible);
    setCommon('own_damage_min_deductible', won10k(Math.min(...own))); setCommon('own_damage_max_deductible', won10k(Math.max(...own)));
    for (const key of ['ownDamageDeductible', 'repairLimit', 'age24Surcharge', 'perPanelRepair', 'excessMileageFeePerKm'] as const) {
      const u = take(key); if (!u.same) varies[key] = u.distribution;
    }
  }
  if (writesPolicyDocument && text(policyBefore.annual_mileage) !== IANCAR_BASE_ANNUAL_MILEAGE) { policyPatch.annual_mileage = IANCAR_BASE_ANNUAL_MILEAGE; }
  derived.annual_mileage = IANCAR_BASE_ANNUAL_MILEAGE;
  // 근거 칸(출처·시각): 공통 정책 문서에 «무엇을 어디서 당겨 왔는지» 남긴다.
  const sourceNote = { source: 'ONE_RATES(insurance·additional_charges·excess_mileage_fee)', observedAt: observedAts.at(-1) ?? null, vehiclesRead: terms.length, derived, variesAcrossVehicles: varies,
    note: '공급사 원천 우선. 차량마다 다른 값(면책금·수리 한도·초과 주행 요금·휴차료)은 상품 문서 iancar_policy_terms 에 차량별 보존' };
  if (writesPolicyDocument && terms.length && stableDigest(policyBefore.iancar_source_terms ?? null) !== stableDigest(sourceNote)) policyPatch.iancar_source_terms = sourceNote;
  if (text(policyBefore.basic_driver_age) !== '만 26세 이상' && !('basic_driver_age' in policyPatch)) blockers.push('BASIC_DRIVER_AGE_NOT_26');
  if (policyPatch.basic_driver_age && policyPatch.basic_driver_age !== '만 26세 이상') blockers.push('SOURCE_MINIMUM_AGE_NOT_26');
  if (!writesPolicyDocument && derived.basic_driver_age !== undefined && derived.basic_driver_age !== '만 26세 이상') blockers.push('SOURCE_MINIMUM_AGE_NOT_26');   // 원천이 대표 정책(만 26세 이상)과 다르면 계획을 막는다

  // 원천 조회 실패(401·429·시간 초과·형식 불일치 등)는 «원천에 없음(404)» 과 다르다 — 근거 없이 연결하지 않도록 계획을 막는다.
  const lookupFailures = targets.filter(p => !input.vehicleTerms[p.id] && (input.vehicleTermsErrors?.[p.id] ?? 'NOT_LOOKED_UP') !== 'NOT_IN_SOURCE');
  if (lookupFailures.length) blockers.push(`SOURCE_LOOKUP_FAILED(${lookupFailures.length})`);
  if (targets.length && !terms.length) blockers.push('NO_SOURCE_TERMS_READ');
  // 공통 필수 조건(연령·면허·대인/대물 면책·자차 포함)이 차량마다 다르면 공통 정책 하나로 연결할 수 없다 — 기존 공통 값이 남은 채 전 차량이 연결되는 것을 막는다.
  const commonVaries = ['minimumDriverAge', 'maximumDriverAge', 'minimumLicenseMonths', 'personalInjuryDeductible', 'propertyDamageDeductible', 'ownDamageIncluded'].filter(k => k in varies);
  for (const key of commonVaries) blockers.push(`COMMON_CONDITION_VARIES(${key})`);
  const unexpectedPolicyFields = Object.keys(policyPatch).filter(k => !IANCAR_POLICY_PATCH_FIELDS.includes(k));
  if (unexpectedPolicyFields.length) blockers.push('POLICY_PATCH_FIELD_NOT_ALLOWED');

  const skipped: { id: string; reason: string }[] = [];
  const productPatches: { id: string; updateTimeMs: number; patch: Rec }[] = [];
  for (const product of targets) {
    const d = product.data;
    if (d.locked_by_contract || d._deleted || d.deletedAt) { skipped.push({ id: product.id, reason: 'LOCKED_OR_DELETED' }); continue; }
    const patch: Rec = {};
    if (d.policy_code !== IANCAR_COMMON_POLICY_CODE) patch.policy_code = IANCAR_COMMON_POLICY_CODE;
    if (d.policy_reference_state !== 'LINKED') patch.policy_reference_state = 'LINKED';
    if (!Object.hasOwn(d, 'policy_code_source_original')) patch.policy_code_source_original = d.policy_code ?? null;
    const vehicle = input.vehicleTerms[product.id];
    if (vehicle && stableDigest(d.iancar_policy_terms ?? null) !== stableDigest(vehicle)) patch.iancar_policy_terms = vehicle;
    if (Object.keys(patch).length) productPatches.push({ id: product.id, updateTimeMs: product.updateTimeMs, patch });
  }
  const before: Record<string, number> = {};
  for (const p of targets) { const k = String(p.data.policy_code ?? 'null'); before[k] = (before[k] ?? 0) + 1; }
  const noTerms = targets.filter(p => !input.vehicleTerms[p.id]).map(p => ({ id: p.id, reason: input.vehicleTermsErrors?.[p.id] ?? 'NOT_LOOKED_UP' }));

  const planBody = { ...(scope === 'ALL' ? {} : { scope }), commonPolicy: { code: IANCAR_COMMON_POLICY_CODE, updateTimeMs: input.policy.updateTimeMs, patch: policyPatch }, products: productPatches };
  return {
    schema: 'iancar-policy-link-plan/2',
    scope,
    blockers,
    counts: { listableTargets: targets.length, toLink: productPatches.length, termsFromSource: withTerms.length, withoutSourceTerms: noTerms.length, skipped: skipped.length,
      policyFieldsChanged: Object.keys(policyPatch).length, policyDocumentChanges: Object.keys(policyPatch).length ? 1 : 0, deletes: 0 },
    policyCodeBefore: before,
    skipped, withoutSourceTerms: noTerms,
    policyPatch,
    evidence: {
      commonPolicyBefore: { basicDriverAge: text(policyBefore.basic_driver_age), driverAgeUpperLimit: text(policyBefore.driver_age_upper_limit), licensePeriod: text(policyBefore.license_period),
        annualMileage: text(policyBefore.annual_mileage), policyDefaultPack: text(policyBefore.policy_default_pack), createdBy: text(policyBefore.created_by) },
      source: sourceNote,
    },
    productPatches,
    planDigest: stableDigest(planBody),
  };
}
