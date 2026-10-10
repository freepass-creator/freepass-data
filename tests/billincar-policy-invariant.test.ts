import { describe, expect, it } from 'vitest';
import { assertBillincarCanonicalPolicy, assertBillincarProductSet, BILLINCAR_EXPECTED_PRODUCT_COUNT } from '../src/domain/billincar-policy-invariant.js';

const policy = { provider_company_code: 'RP021', annual_mileage: '연 20,000km', mileage_upcharge_per_10000km: '10만원',
  basic_driver_age: '만 26세 이상', driver_age_lowering: '만 21세까지', age_lowering_cost: '10만원', insurance_included: '보험료 포함',
  deposit_installment: '2회까지', property_compensation_limit: '1억원', injury_deductible: '30만원', property_deductible: '30만원',
  self_body_accident: '1억원', self_body_deductible: '30만원', uninsured_damage: '없음' };

describe('RP021 Billincar policy repair invariant', () => {
  it('accepts the exact source policy facts', () => expect(() => assertBillincarCanonicalPolicy(policy)).not.toThrow());
  it('rejects drift in a material source fact', () => expect(() => assertBillincarCanonicalPolicy({ ...policy, annual_mileage: '연 30,000km' })).toThrow('annual_mileage'));
  it('accepts exactly 47 products with 12 unlinked and one source UID', () => {
    const products = Array.from({ length: BILLINCAR_EXPECTED_PRODUCT_COUNT }, (_, index) => ({ id: String(index), data: { provider_company_code: 'RP021', policy_code: index < 12 ? '' : 'FP-RP021-RENT', policy_code_source_original: 'pol_freepassstd' } }));
    expect(() => assertBillincarProductSet(products)).not.toThrow();
  });
});

it('missing Billincar source ID stops before Firebase access', async () => {
  const { applyBillincarPolicyRepair } = await import('../src/infra/billincar-policy-repair-firestore.js');
  const previous = process.env.FREEPASS_SHEET_BILLINCAR_POLICY_ID;
  try {
    delete process.env.FREEPASS_SHEET_BILLINCAR_POLICY_ID;
    await expect(applyBillincarPolicyRepair()).rejects.toThrow('MISSING_SHEET_ID_ENV: FREEPASS_SHEET_BILLINCAR_POLICY_ID');
  } finally {
    if (previous === undefined) delete process.env.FREEPASS_SHEET_BILLINCAR_POLICY_ID;
    else process.env.FREEPASS_SHEET_BILLINCAR_POLICY_ID = previous;
  }
});
