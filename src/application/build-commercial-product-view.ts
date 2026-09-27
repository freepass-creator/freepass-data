import type { Offer, Policy, Product, VehicleAsset, VehicleModel } from '../domain/catalog.js';
import type { CommercialFact, CommercialFactValue, CommercialProductView } from '../domain/commercial-product-view.js';
import { resolveOfferCommercialTerms } from './resolve-offer-commercial-terms.js';
import {
  buildDefaultProductConditionSelection,
  evaluateProductConditions,
} from './evaluate-product-conditions.js';
import {
  buildMonthlyRentModifiers,
  buildPricingConditionScope,
  MONTHLY_RENT_MODIFIER_KEYS,
  PRICING_SCOPE_POLICY_KEYS,
} from './product-pricing-policy.js';

export const PRODUCT_POLICY_FACT_KEYS = [
  'default_term_months',
  ...PRICING_SCOPE_POLICY_KEYS,
  ...MONTHLY_RENT_MODIFIER_KEYS,
] as const;

export const CONTRACT_CONDITION_FACT_KEYS = [
  'succession_fee',
  'own_damage_min_deductible',
  'own_damage_max_deductible',
  'self_body_deductible',
  'property_deductible',
  'injury_deductible',
  'early_termination_rate_under1y',
  'early_termination_rate_over1y',
  'own_damage_repair_ratio',
  'late_fee_rate',
  'accident_termination_count',
  'deposit_return_days',
  'auto_terminate_overdue_days',
  'deposit_card_payment',
  'deposit_installment',
  'succession_allowed',
] as const;

const policyKeys = new Set<string>(PRODUCT_POLICY_FACT_KEYS);
const contractKeys = new Set<string>(CONTRACT_CONDITION_FACT_KEYS);

function factValue(value: unknown): value is CommercialFactValue {
  return typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
    || typeof value === 'string'
    || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

function classifyPolicyFacts(policy: Policy | undefined) {
  const policyFacts: CommercialFact[] = [];
  const contractFacts: CommercialFact[] = [];
  const unclassifiedPolicyFacts: string[] = [];

  if (!policy) return { policyFacts, contractFacts, unclassifiedPolicyFacts };

  for (const [key, value] of Object.entries(policy.facts)) {
    if (!factValue(value)) {
      unclassifiedPolicyFacts.push(key);
      continue;
    }
    if (policyKeys.has(key)) {
      policyFacts.push({ key, value });
      continue;
    }
    if (contractKeys.has(key)) {
      contractFacts.push({ key, value });
      continue;
    }
    unclassifiedPolicyFacts.push(key);
  }

  const byKey = (a: CommercialFact, b: CommercialFact) => a.key.localeCompare(b.key);
  policyFacts.sort(byKey);
  contractFacts.sort(byKey);
  unclassifiedPolicyFacts.sort();
  return { policyFacts, contractFacts, unclassifiedPolicyFacts };
}

export function buildCommercialProductView(input: {
  product: Product;
  vehicleModel: VehicleModel;
  vehicleAsset?: VehicleAsset;
  offer: Offer;
  policy?: Policy;
}): CommercialProductView {
  const { product, vehicleModel, vehicleAsset, offer, policy } = input;
  if (product.vehicleModelId !== vehicleModel.id) throw new Error('PRODUCT_VEHICLE_MODEL_MISMATCH');
  if (offer.productId !== product.id) throw new Error('OFFER_PRODUCT_MISMATCH');
  if (product.vehicleAssetId && (!vehicleAsset || vehicleAsset.id !== product.vehicleAssetId)) {
    throw new Error('PRODUCT_VEHICLE_ASSET_MISMATCH');
  }
  if (vehicleAsset && vehicleAsset.vehicleModelId !== vehicleModel.id) {
    throw new Error('ASSET_VEHICLE_MODEL_MISMATCH');
  }

  const commercial = resolveOfferCommercialTerms(offer, policy);
  const classified = classifyPolicyFacts(policy);
  const defaults = buildDefaultProductConditionSelection(offer, policy);
  const preview = evaluateProductConditions(offer, policy, defaults.selection);

  const pricingBasis = commercial.terms.map((term) => ({
    termKey: term.termKey,
    conditionScope: buildPricingConditionScope({
      termMonths: term.termMonths,
      ...(term.mileage.state === 'KNOWN' ? { mileageKmPerYear: term.mileage.kmPerYear } : {}),
      ...(policy ? { policy } : {}),
    }),
    monthlyRent: structuredClone(term.monthlyRent),
    deposit: {
      state: term.deposit.state,
      ...('amount' in term.deposit ? { amount: structuredClone(term.deposit.amount) } : {}),
    },
  }));

  const decisions = [
    ...commercial.decisions,
    ...defaults.decisions,
    ...preview.decisions,
  ];
  if (classified.unclassifiedPolicyFacts.length) decisions.push('POLICY_FACT_CLASSIFICATION_REQUIRED');
  const invalidFacts = [
    ...commercial.invalidFacts,
    ...defaults.invalidFacts,
    ...preview.invalidFacts,
  ];

  return {
    vehicle: {
      productId: product.id,
      commercialType: product.commercialType,
      displayName: product.displayName,
      vehicleModelId: vehicleModel.id,
      ...(vehicleAsset ? { vehicleAssetId: vehicleAsset.id } : {}),
      maker: vehicleModel.maker,
      model: vehicleModel.model,
      ...(vehicleModel.generation !== undefined ? { generation: vehicleModel.generation } : {}),
      ...(vehicleModel.subModel !== undefined ? { subModel: vehicleModel.subModel } : {}),
      ...(vehicleModel.trim !== undefined ? { trim: vehicleModel.trim } : {}),
      ...(vehicleModel.fuel !== undefined ? { fuel: vehicleModel.fuel } : {}),
      ...(vehicleModel.drive !== undefined ? { drive: vehicleModel.drive } : {}),
      ...(vehicleModel.seats !== undefined ? { seats: vehicleModel.seats } : {}),
      ...(vehicleAsset ? {
        assetStatus: vehicleAsset.status,
        ...(vehicleAsset.plateNumber !== undefined ? { plateNumber: vehicleAsset.plateNumber } : {}),
        ...(vehicleAsset.odometerKm !== undefined ? { odometerKm: vehicleAsset.odometerKm } : {}),
      } : {}),
    },
    conditionProfile: {
      defaults: defaults.selection,
      available: {
        termMonths: [...new Set(pricingBasis.map((term) => term.conditionScope.termMonths))].sort((a, b) => a - b),
        mileageKmPerYear: [...new Set(pricingBasis.flatMap((term) =>
          term.conditionScope.mileage.pricedUpToKmPerYear === undefined
            ? []
            : [term.conditionScope.mileage.pricedUpToKmPerYear]
        ))].sort((a, b) => a - b),
      },
      monthlyRentModifiers: buildMonthlyRentModifiers(policy),
    },
    pricingBasis,
    policy: {
      ...(offer.policyId ? { policyId: offer.policyId } : {}),
      facts: classified.policyFacts,
    },
    contractConditions: {
      facts: classified.contractFacts,
    },
    preview,
    review: {
      status: invalidFacts.length
        ? 'INVALID'
        : decisions.length
          ? 'NEEDS_DECISION'
          : 'READY',
      decisions: [...new Set(decisions)].sort(),
      invalidFacts: [...new Set(invalidFacts)].sort(),
      unclassifiedPolicyFacts: classified.unclassifiedPolicyFacts,
    },
  };
}
