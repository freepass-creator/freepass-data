export const BILLINCAR_PROVIDER_CODE = 'RP021';
export const BILLINCAR_CANONICAL_POLICY_CODE = 'FP-RP021-RENT';
export const BILLINCAR_DUPLICATE_POLICY_CODE = 'POL-0040';
export const BILLINCAR_SOURCE_POLICY_CODES = ['POL-0035', 'RP021_S01', 'RP021_S02'] as const;
export const BILLINCAR_EXPECTED_PRODUCT_COUNT = 47;
export const BILLINCAR_EXPECTED_UNLINKED_COUNT = 12;
export const BILLINCAR_SOURCE_POLICY_UID = 'pol_freepassstd';

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export function assertBillincarCanonicalPolicy(facts: Record<string, unknown>) {
  const expected: Record<string, string> = {
    provider_company_code: BILLINCAR_PROVIDER_CODE,
    annual_mileage: '연 20,000km',
    mileage_upcharge_per_10000km: '10만원',
    basic_driver_age: '만 26세 이상',
    driver_age_lowering: '만 21세까지',
    age_lowering_cost: '10만원',
    insurance_included: '보험료 포함',
    deposit_installment: '2회까지',
    property_compensation_limit: '1억원',
    injury_deductible: '30만원',
    property_deductible: '30만원',
    self_body_accident: '1억원',
    self_body_deductible: '30만원',
    uninsured_damage: '없음',
  };
  for (const [key, value] of Object.entries(expected)) {
    if (text(facts[key]) !== value) throw new Error(`RP021 ${key} must equal source policy value`);
  }
}

export function assertBillincarProductSet(products: { id: string; data: Record<string, unknown> }[]) {
  if (products.length !== BILLINCAR_EXPECTED_PRODUCT_COUNT) {
    throw new Error(`Expected ${BILLINCAR_EXPECTED_PRODUCT_COUNT} active RP021 products, got ${products.length}`);
  }
  const unlinked = products.filter(({ data }) => !text(data.policy_code));
  if (unlinked.length !== BILLINCAR_EXPECTED_UNLINKED_COUNT) {
    throw new Error(`Expected ${BILLINCAR_EXPECTED_UNLINKED_COUNT} unlinked RP021 products, got ${unlinked.length}`);
  }
  for (const { id, data } of products) {
    if (text(data.provider_company_code) !== BILLINCAR_PROVIDER_CODE) throw new Error(`Unexpected provider products/${id}`);
    if (text(data.policy_code) && text(data.policy_code) !== BILLINCAR_CANONICAL_POLICY_CODE) {
      throw new Error(`Unexpected policy_code products/${id}`);
    }
    if (text(data.policy_code_source_original) !== BILLINCAR_SOURCE_POLICY_UID) {
      throw new Error(`Unexpected source policy products/${id}`);
    }
  }
}
