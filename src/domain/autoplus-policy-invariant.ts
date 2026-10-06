export const AUTOPLUS_PROVIDER_CODE = 'RP023';
export const AUTOPLUS_POLICY_CODES = ['POL-0047', 'FP-RP023-RENT'] as const;
export const AUTOPLUS_CANONICAL_POLICY_CODE = 'POL-0047';
export const AUTOPLUS_EXPECTED_ACTIVE_PRODUCT_COUNT = 155;
/** One-time repair already applied and read back on production (docs/NEXT-START-HERE.md, 2026-09-29). */
export const AUTOPLUS_POLICY_REPAIR_APPLIED_RUN_ID = '2026-09-29T04-44-30-502Z-42019aec-9cd2-4fa9-85bf-76c6b1542a68';

/**
 * The repair removes `age_lowering_cost` in place and keeps the prior value only in a local backup.
 * It must not run again; a future correction needs a reviewed status/tombstone change instead.
 */
export function assertAutoplusPolicyRepairRunnable(): void {
  throw new Error(`AUTOPLUS_POLICY_REPAIR_RETIRED: applied as run ${AUTOPLUS_POLICY_REPAIR_APPLIED_RUN_ID}`);
}

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

export function assertAutoplusProductSet(products: { id: string; data: Record<string, unknown> }[]) {
  if (products.length !== AUTOPLUS_EXPECTED_ACTIVE_PRODUCT_COUNT) {
    throw new Error(`Expected ${AUTOPLUS_EXPECTED_ACTIVE_PRODUCT_COUNT} active RP023 products, got ${products.length}`);
  }
  if (new Set(products.map((product) => product.id)).size !== products.length) {
    throw new Error('Duplicate RP023 product id');
  }
  for (const product of products) {
    if (text(product.data.provider_company_code) !== AUTOPLUS_PROVIDER_CODE) {
      throw new Error(`Unexpected provider for products/${product.id}`);
    }
    if (text(product.data.product_type) !== '오플구독') {
      throw new Error(`Unexpected product_type for products/${product.id}`);
    }
  }
}
