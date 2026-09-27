import type { CommercialFactValue, Money } from './commercial-product-view.js';

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
  sourcePolicyKeys: string[];
  mayAffect: PricingTarget[];
};

export type ConditionPredicate =
  | { dimensionKey: string; op: 'EQ' | 'NE'; value: CommercialFactValue }
  | { dimensionKey: string; op: 'IN'; values: CommercialFactValue[] }
  | { dimensionKey: string; op: 'GT' | 'GTE' | 'LT' | 'LTE'; value: number };

export type PriceAdjustmentOperation =
  | { kind: 'ADD_FIXED'; amount: Money }
  | { kind: 'ADD_RATE'; rate: number; base: 'BASIS_MONTHLY_RENT' | 'CURRENT_MONTHLY_RENT' }
  | { kind: 'ADD_PER_UNIT'; unit: number; amount: Money; fromValue?: number }
  | { kind: 'MULTIPLY'; multiplier: number; base: 'BASIS_MONTHLY_RENT' | 'CURRENT_MONTHLY_RENT' | 'CURRENT_DEPOSIT' }
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
