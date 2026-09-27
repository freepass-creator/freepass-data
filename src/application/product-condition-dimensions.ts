import type { Policy } from '../domain/catalog.js';
import type {
  ConditionDimension,
  ProductConditionPricingModel,
} from '../domain/pricing-condition-model.js';
import type { CommercialFactValue } from '../domain/commercial-product-view.js';
import { policyScalar } from './product-pricing-policy.js';

type DimensionSpec = Omit<ConditionDimension, 'defaultValue' | 'allowedValues'> & {
  defaultPolicyKey?: string;
  allowedPolicyKeys?: string[];
};

export const CONDITION_DIMENSION_SPECS: DimensionSpec[] = [
  {
    key: 'term_months', label: '대여기간', group: 'TERM', valueType: 'NUMBER', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['default_term_months'], defaultPolicyKey: 'default_term_months',
    mayAffect: ['MONTHLY_RENT', 'DEPOSIT'],
  },
  {
    key: 'annual_mileage_km', label: '약정 주행거리', group: 'MILEAGE', valueType: 'NUMBER', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['annual_mileage', 'max_annual_mileage', 'mileage_upcharge_per_10000km'],
    defaultPolicyKey: 'annual_mileage', mayAffect: ['MONTHLY_RENT', 'DEPOSIT'],
  },
  {
    key: 'driver_age', label: '운전자 연령', group: 'DRIVER', valueType: 'NUMBER', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['basic_driver_age', 'driver_age_lowering', 'driver_age_upper_limit', 'age_lowering_cost'],
    defaultPolicyKey: 'basic_driver_age', mayAffect: ['MONTHLY_RENT', 'DEPOSIT', 'ELIGIBILITY'],
  },
  {
    key: 'additional_driver_count', label: '추가 운전자 수', group: 'DRIVER', valueType: 'NUMBER', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['additional_driver_allowance_count', 'additional_driver_cost'],
    mayAffect: ['MONTHLY_RENT', 'ELIGIBILITY'],
  },
  {
    key: 'driver_scope', label: '운전자 범위', group: 'DRIVER', valueType: 'ENUM', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['personal_driver_scope', 'business_driver_scope'],
    mayAffect: ['MONTHLY_RENT', 'ELIGIBILITY'],
  },
  {
    key: 'license_period', label: '면허 경력', group: 'DRIVER', valueType: 'ENUM', role: 'ELIGIBILITY',
    sourcePolicyKeys: ['license_period'], mayAffect: ['ELIGIBILITY'],
  },
  {
    key: 'insurance_included', label: '보험 포함 여부', group: 'INSURANCE', valueType: 'ENUM', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['insurance_included'], defaultPolicyKey: 'insurance_included',
    mayAffect: ['MONTHLY_RENT', 'DEPOSIT'],
  },
  {
    key: 'property_compensation_limit', label: '대물 보상한도', group: 'INSURANCE', valueType: 'MONEY', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['property_compensation_limit'], defaultPolicyKey: 'property_compensation_limit',
    mayAffect: ['MONTHLY_RENT', 'DEPOSIT'],
  },
  {
    key: 'injury_compensation_limit', label: '대인 보상한도', group: 'INSURANCE', valueType: 'ENUM', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['injury_compensation_limit'], defaultPolicyKey: 'injury_compensation_limit',
    mayAffect: ['MONTHLY_RENT', 'DEPOSIT'],
  },
  {
    key: 'self_body_accident_limit', label: '자기신체사고 보상', group: 'INSURANCE', valueType: 'MONEY', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['self_body_accident'], defaultPolicyKey: 'self_body_accident',
    mayAffect: ['MONTHLY_RENT', 'DEPOSIT'],
  },
  {
    key: 'uninsured_damage_limit', label: '무보험차상해 보상', group: 'INSURANCE', valueType: 'ENUM', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['uninsured_damage'], defaultPolicyKey: 'uninsured_damage',
    mayAffect: ['MONTHLY_RENT', 'DEPOSIT'],
  },
  {
    key: 'own_damage_compensation', label: '자차 보상기준', group: 'INSURANCE', valueType: 'ENUM', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['own_damage_compensation'], defaultPolicyKey: 'own_damage_compensation',
    mayAffect: ['MONTHLY_RENT', 'DEPOSIT'],
  },
  {
    key: 'own_damage_repair_ratio', label: '자차 자기부담률', group: 'INSURANCE', valueType: 'NUMBER', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['own_damage_repair_ratio'], defaultPolicyKey: 'own_damage_repair_ratio',
    mayAffect: ['MONTHLY_RENT', 'DEPOSIT'],
  },
  {
    key: 'own_damage_min_deductible', label: '자차 최소 면책금', group: 'INSURANCE', valueType: 'MONEY', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['own_damage_min_deductible'], defaultPolicyKey: 'own_damage_min_deductible',
    mayAffect: ['MONTHLY_RENT', 'DEPOSIT'],
  },
  {
    key: 'own_damage_max_deductible', label: '자차 최대 면책금', group: 'INSURANCE', valueType: 'MONEY', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['own_damage_max_deductible'], defaultPolicyKey: 'own_damage_max_deductible',
    mayAffect: ['MONTHLY_RENT', 'DEPOSIT'],
  },
  {
    key: 'maintenance_service', label: '정비 서비스', group: 'MAINTENANCE', valueType: 'ENUM', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['maintenance_service'], defaultPolicyKey: 'maintenance_service',
    mayAffect: ['MONTHLY_RENT', 'DEPOSIT'],
  },
  {
    key: 'roadside_assistance', label: '긴급출동', group: 'MAINTENANCE', valueType: 'ENUM', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['annual_roadside_assistance'], defaultPolicyKey: 'annual_roadside_assistance',
    mayAffect: ['MONTHLY_RENT'],
  },
  {
    key: 'replacement_car', label: '대차 제공', group: 'MAINTENANCE', valueType: 'ENUM', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['replacement_car_policy'], defaultPolicyKey: 'replacement_car_policy',
    mayAffect: ['MONTHLY_RENT'],
  },
  {
    key: 'rental_card_payment', label: '대여료 카드결제', group: 'PAYMENT', valueType: 'ENUM', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['rental_card_payment'], defaultPolicyKey: 'rental_card_payment',
    mayAffect: ['MONTHLY_RENT'],
  },
  {
    key: 'deposit_card_payment', label: '보증금 카드결제', group: 'PAYMENT', valueType: 'ENUM', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['deposit_card_payment'], defaultPolicyKey: 'deposit_card_payment',
    mayAffect: ['DEPOSIT', 'UPFRONT_FEE'],
  },
  {
    key: 'delivery', label: '탁송', group: 'DELIVERY', valueType: 'ENUM', role: 'PRICE_INPUT',
    sourcePolicyKeys: ['delivery_fee'], defaultPolicyKey: 'delivery_fee',
    mayAffect: ['UPFRONT_FEE'],
  },
  {
    key: 'settlement_type', label: '만기 반납/인수', group: 'SETTLEMENT', valueType: 'ENUM', role: 'PRICE_INPUT',
    sourcePolicyKeys: [], mayAffect: ['MONTHLY_RENT', 'DEPOSIT'],
  },
];

function values(...raw: unknown[]): CommercialFactValue[] {
  return raw.map(policyScalar).filter((value): value is CommercialFactValue => value !== undefined);
}

export function buildConditionDimensions(policy?: Policy): ConditionDimension[] {
  const facts = policy?.facts ?? {};
  return CONDITION_DIMENSION_SPECS.map((spec) => {
    const defaultValue = spec.defaultPolicyKey ? policyScalar(facts[spec.defaultPolicyKey]) : undefined;
    const allowedValues = spec.allowedPolicyKeys
      ? values(...spec.allowedPolicyKeys.map((key) => facts[key]))
      : undefined;
    return {
      key: spec.key,
      label: spec.label,
      group: spec.group,
      valueType: spec.valueType,
      role: spec.role,
      sourcePolicyKeys: [...spec.sourcePolicyKeys],
      mayAffect: [...spec.mayAffect],
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      ...(allowedValues?.length ? { allowedValues } : {}),
    };
  });
}

export function buildOpenConditionPricingModel(policy?: Policy): ProductConditionPricingModel {
  return {
    dimensions: buildConditionDimensions(policy),
    adjustmentRules: [],
    eligibilityRules: [],
  };
}
