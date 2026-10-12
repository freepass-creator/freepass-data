/** 이안카(RP031) 상품 ↔ 공통 정책 연결 계획 — 순수 함수(저장소 접근 없음, 시험 가능).
 * 배경: 1차 발행(ONE API)이 정책 연결을 DEFERRED 로 비워 노출 이안카 94대 전부 policy_code 가 null 이다 → ERP5 상세가 «보험 조건 미등록».
 * 결정(대표 10-12, 지휘통제실 판정): 이안카 정책은 만 26세 이상·연 20,000km 기본. 공통 정책 FP-RP031-RENT 에 연결하고(S01~S04 는 보존·삭제 안 함)
 * 공통 정책의 annual_mileage 를 연 20,000km 로 맞춘다. 연령 상한은 «공급사 원천(ONE 보험 정보) 우선» 원칙에 따라 근거를 나란히 보여 주고 판정을 받는다. */
import { stableDigest } from '../shared/stable-digest.js';

export const IANCAR_COMMON_POLICY_CODE = 'FP-RP031-RENT';
export const IANCAR_BASE_ANNUAL_MILEAGE = '연 20,000km';
export type AgeUpperChoice = 'KEEP' | 'ONE_65';

type Rec = Record<string, unknown>;
export type PolicyLinkInput = {
  policy: { exists: boolean; updateTimeMs: number | null; data: Rec };
  products: { id: string; updateTimeMs: number; data: Rec }[];
  ageUpper: AgeUpperChoice;
  /** ONE 보험 정보 표본 요약(선택) — 계획에 근거로 같이 보여 준다. */
  sourceInsurance?: { sampled: number; minimumDriverAge: number[]; maximumDriverAge: number[]; observedAt: string };
};

const text = (value: unknown) => (typeof value === 'string' ? value : null);

/** 정책 연결된 상품을 1차 발행(동기화)이 다시 비우지 않게 하는 필드 계산. 연결되지 않은 상품은 기존 동작(DEFERRED·원래 값 보존) 그대로. */
export function iancarPolicyFields(old: Rec): { policy_code: string | null; policy_code_source_original: unknown; policy_reference_state: 'LINKED' | 'DEFERRED' } {
  const linked = old.policy_reference_state === 'LINKED' && typeof old.policy_code === 'string' && !!old.policy_code.trim();
  if (linked) return { policy_code: old.policy_code as string, policy_code_source_original: old.policy_code_source_original ?? null, policy_reference_state: 'LINKED' };
  return { policy_code: null, policy_code_source_original: old.policy_code ?? old.policy_code_source_original ?? null, policy_reference_state: 'DEFERRED' };
}

export function buildPolicyLinkPlan(input: PolicyLinkInput) {
  const blockers: string[] = [];
  if (!input.policy.exists) blockers.push('COMMON_POLICY_MISSING');
  const policyBefore = input.policy.data;
  const policyPatch: Rec = {};
  if (text(policyBefore.annual_mileage) !== IANCAR_BASE_ANNUAL_MILEAGE) policyPatch.annual_mileage = IANCAR_BASE_ANNUAL_MILEAGE;
  if (input.ageUpper === 'ONE_65' && text(policyBefore.driver_age_upper_limit) !== '만 65세 이하') policyPatch.driver_age_upper_limit = '만 65세 이하';
  if (text(policyBefore.basic_driver_age) !== '만 26세 이상') blockers.push('BASIC_DRIVER_AGE_NOT_26');   // 대표 정책(만 26세 이상)과 다르면 계획을 막는다

  const targets = input.products.filter(p => p.data.provider_company_code === 'RP031' && p.data.listable === true);
  const skipped: { id: string; reason: string }[] = [];
  const productPatches: { id: string; updateTimeMs: number; patch: Rec }[] = [];
  for (const product of targets) {
    const d = product.data;
    if (d.locked_by_contract || d._deleted || d.deletedAt) { skipped.push({ id: product.id, reason: 'LOCKED_OR_DELETED' }); continue; }
    const patch: Rec = {};
    if (d.policy_code !== IANCAR_COMMON_POLICY_CODE) patch.policy_code = IANCAR_COMMON_POLICY_CODE;
    if (d.policy_reference_state !== 'LINKED') patch.policy_reference_state = 'LINKED';
    // 원래 값 보존: 이미 보존 칸이 있으면 덮지 않고, 없으면 연결 전 policy_code 를 남긴다(없으면 null 로 «없음» 표시)
    if (!Object.hasOwn(d, 'policy_code_source_original')) patch.policy_code_source_original = d.policy_code ?? null;
    if (Object.keys(patch).length) productPatches.push({ id: product.id, updateTimeMs: product.updateTimeMs, patch });
  }
  const before: Record<string, number> = {};
  for (const p of targets) { const k = String(p.data.policy_code ?? 'null'); before[k] = (before[k] ?? 0) + 1; }

  const planBody = {
    commonPolicy: { code: IANCAR_COMMON_POLICY_CODE, updateTimeMs: input.policy.updateTimeMs, patch: policyPatch },
    products: productPatches,
  };
  return {
    schema: 'iancar-policy-link-plan/1',
    blockers,
    counts: { listableTargets: targets.length, toLink: productPatches.length, alreadyLinked: targets.length - productPatches.length - skipped.length, skipped: skipped.length, policyFieldsChanged: Object.keys(policyPatch).length, deletes: 0 },
    policyCodeBefore: before,
    skipped,
    policyPatch,
    evidence: {
      ageUpperChoice: input.ageUpper,
      commonPolicy: {
        basicDriverAge: text(policyBefore.basic_driver_age), driverAgeUpperLimit: text(policyBefore.driver_age_upper_limit), annualMileage: text(policyBefore.annual_mileage),
        policyDefaultPack: text(policyBefore.policy_default_pack), createdBy: text(policyBefore.created_by), provenanceNote: '공통 정책 팩(자동 생성). 이안카 공식 정책 원문 출처는 문서에 없음',
      },
      source: input.sourceInsurance ?? null,
    },
    productPatches,
    planDigest: stableDigest(planBody),
  };
}
