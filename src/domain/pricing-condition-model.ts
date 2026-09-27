import type { Money } from './catalog.js';
import type { CommercialFactValue } from './commercial-product-view.js';

export type PricingTarget =
  | 'MONTHLY_RENT'
  | 'DEPOSIT'
  | 'UPFRONT_FEE'
  | 'ELIGIBILITY';

export type ConditionValueType =
  | 'BOOLEAN'
  | 'NUMBER'
  | 'MONEY'
  | 'ENUM'
  | 'TEXT';

export type ConditionOption = {
  value: CommercialFactValue;
  label?: string;
  availability: 'SELECTABLE' | 'NOT_ALLOWED' | 'CONSULT';
  priceImpact:
    | { status: 'NOT_PROVIDED' }
    | { status: 'NO_CHANGE' }
    | { status: 'RULED'; ruleIds: string[] }
    | { status: 'EXPLICIT_VARIANT_REQUIRED' }
    | { status: 'CONSULT' };
};

export type ConditionDimension = {
  key: string;
  label: string;
  group:
    | 'TERM'
    | 'MILEAGE'
    | 'DRIVER'
    | 'INSURANCE'
    | 'MAINTENANCE'
    | 'PAYMENT'
    | 'DELIVERY'
    | 'SETTLEMENT'
    | 'OTHER';
  valueType: ConditionValueType;
  role: 'PRICE_INPUT' | 'ELIGIBILITY' | 'CONTRACT_ONLY';
  defaultValue?: CommercialFactValue;
  allowedValues?: CommercialFactValue[];
  options?: ConditionOption[];
  sourcePolicyKeys: string[];
  mayAffect: PricingTarget[];
};

export type ConditionPredicate =
  | { dimensionKey: string; op: 'EQ' | 'NE'; value: CommercialFactValue }
  | { dimensionKey: string; op: 'IN'; values: CommercialFactValue[] }
  | { dimensionKey: string; op: 'GT' | 'GTE' | 'LT' | 'LTE'; value: number };

export type PriceBaseRef =
  | 'BASIS_MONTHLY_RENT'
  | 'CURRENT_MONTHLY_RENT'
  | 'BASIS_DEPOSIT'
  | 'CURRENT_DEPOSIT'
  | `CONTEXT:${string}`;

export type PriceAdjustmentOperation =
  | { kind: 'ADD_FIXED'; amount: Money }
  | { kind: 'ADD_RATE'; rate: number; base: PriceBaseRef }
  | { kind: 'ADD_PER_UNIT'; unit: number; amount: Money; fromValue?: number }
  | { kind: 'MULTIPLY'; multiplier: number; base: PriceBaseRef }
  | { kind: 'SET_FIXED'; amount: Money }
  | { kind: 'REQUIRE_EXPLICIT_VARIANT' };

export type ProductConditionAdjustmentRule = {
  ruleId: string;
  dimensionKey: string;
  target: Exclude<PricingTarget, 'ELIGIBILITY'>;
  when: ConditionPredicate[];
  operation: PriceAdjustmentOperation;
  priority: number;
  source: {
    policyId?: string;
    policyKey?: string;
    note?: string;
  };
};

export type EligibilityRule = {
  ruleId: string;
  when: ConditionPredicate[];
  decision: 'ALLOW' | 'DENY' | 'REVIEW';
  source: {
    policyId?: string;
    policyKey?: string;
    note?: string;
  };
};

export type ProductConditionPricingModel = {
  dimensions: ConditionDimension[];
  adjustmentRules: ProductConditionAdjustmentRule[];
  eligibilityRules: EligibilityRule[];
};
