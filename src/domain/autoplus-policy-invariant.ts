export const AUTOPLUS_PROVIDER_CODE = 'RP023';
export const AUTOPLUS_POLICY_CODES = ['POL-0047', 'FP-RP023-RENT'] as const;

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';

export function assertAutoplusPolicyInvariant(facts: Record<string, unknown>) {
  if (!/26/.test(text(facts.basic_driver_age))) {
    throw new Error('RP023 basic_driver_age must be age 26 or older');
  }
  if (text(facts.driver_age_lowering) !== '불가') {
    throw new Error('RP023 driver_age_lowering must be 불가');
  }
  if (facts.age_lowering_cost !== undefined && facts.age_lowering_cost !== null && text(facts.age_lowering_cost)) {
    throw new Error('RP023 age_lowering_cost must be absent');
  }
  if (!text(facts.annual_mileage)) {
    throw new Error('RP023 annual_mileage must be explicit');
  }
  if (!/보험.*포함|포함.*보험/.test(text(facts.insurance_included))) {
    throw new Error('RP023 insurance_included must explicitly include insurance');
  }
}
