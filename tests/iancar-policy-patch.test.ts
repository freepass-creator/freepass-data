import { describe, expect, it } from 'vitest';
import { IANCAR_POLICY_UPCHARGES, assertIancarPolicySyncNotBlocked, iancarPolicyPatch } from '../src/domain/iancar-policy-patch.js';

const owned = (field: string) => ({ field_evidence: { [field]: { writer: 'policy-corrector' } }, policy_field_owner: 'policy-corrector' });

describe('iancar policy sync owner guard runs before any write', () => {
  it('builds the same patch the sync writes', () => {
    expect(iancarPolicyPatch('RP031_S01', '5만원', 'T')).toMatchObject({ policy_code: 'RP031_S01', mileage_upcharge_per_10000km: '5만원', age_21_cost: '불가', updated_at: 'T' });
    expect(Object.keys(IANCAR_POLICY_UPCHARGES)).toHaveLength(4);
  });
  it('refuses the whole sync (so no product is re-linked first) when any policy it writes holds a corrector-owned field', () => {
    expect(() => assertIancarPolicySyncNotBlocked({ RP031_S02: { mileage_upcharge_per_10000km: '협의', ...owned('mileage_upcharge_per_10000km') } })).toThrow(/POLICY_FIELD_OWNED_BY_CORRECTOR RP031_S02/);
    expect(() => assertIancarPolicySyncNotBlocked({ RP031_S03: { age_21_cost: '10만원', ...owned('age_21_cost') } })).toThrow(/POLICY_FIELD_OWNED_BY_CORRECTOR RP031_S03/);
  });
  it('passes when no policy is corrector-owned or the owned value is identical', () => {
    expect(() => assertIancarPolicySyncNotBlocked({ RP031_S01: { provider_company_code: 'RP031' } })).not.toThrow();
    expect(() => assertIancarPolicySyncNotBlocked({ RP031_S01: { age_21_cost: '불가', ...owned('age_21_cost') } })).not.toThrow();
  });
});
