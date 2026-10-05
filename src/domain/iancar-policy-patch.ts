import { assertNoCorrectorOverwrite } from './policy-correction.js';

export const IANCAR_POLICY_UPCHARGES = {
  RP031_S01: '5만원',
  RP031_S02: '10만원',
  RP031_S03: '15만원',
  RP031_S04: '25만원',
} as const;

/** The exact policy patch the iancar sync writes for one policy code (updated_at is injected by the caller). */
export const iancarPolicyPatch = (code: string, upcharge: string, updatedAt: unknown): Record<string, unknown> => ({
  policy_code: code,
  policy_name: `RP031 이안카 연 2만km / 1만km 추가 ${upcharge}`,
  provider_company_code: 'RP031',
  maintenance_service: '미제공',
  deposit_installment: '불가',
  annual_mileage: '연 20,000km',
  mileage_upcharge_per_10000km: upcharge,
  driver_age_lowering: '불가',
  age_21_cost: '불가',
  age_23_cost: '불가',
  personal_driver_scope: '개인/사업자',
  injury_compensation_limit: '무한',
  injury_deductible: '50만원',
  property_compensation_limit: '1억원',
  property_deductible: '50만원',
  self_body_accident: '1천5백만원',
  self_body_deductible: '50만원',
  uninsured_damage: '없음',
  own_damage_min_deductible: '50만원',
  own_damage_max_deductible: '100만원',
  updated_at: updatedAt,
});

/** Run BEFORE any product or policy write of the sync: refuses when a policy the sync would write holds corrector-owned fields,
 * so a refusal can never leave the products already re-linked (half-applied). */
export const assertIancarPolicySyncNotBlocked = (stored: Record<string, Record<string, unknown> | undefined>) => {
  for (const [code, upcharge] of Object.entries(IANCAR_POLICY_UPCHARGES)) {
    const data = stored[code];
    if (data) assertNoCorrectorOverwrite(code, data, iancarPolicyPatch(code, upcharge, '<updated_at>'));
  }
};
