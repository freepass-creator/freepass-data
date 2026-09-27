import type { Offer, Policy, Product, VehicleAsset, VehicleModel } from '../domain/catalog.js';
import type { CommercialFact, CommercialFactValue, CommercialProductView } from '../domain/commercial-product-view.js';
import { resolveOfferCommercialTerms } from './resolve-offer-commercial-terms.js';

export const PRODUCT_POLICY_FACT_KEYS = [
  'annual_mileage',
  'max_annual_mileage',
  'mileage_upcharge_per_10000km',
  'over_mileage_rate_domestic',
  'over_mileage_rate_imported',
  'over_mileage_rate_per_km',
] as const;

export const CONTRACT_CONDITION_FACT_KEYS = [
  'additional_driver_cost',
  'age_lowering_cost',
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
  'basic_driver_age',
  'driver_age_lowering',
  'driver_age_upper_limit',
  'deposit_card_payment',
  'deposit_installment',
  'succession_allowed',
  'maintenance_service',
  'insurance_included',
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

  const rentalRates = commercial.terms.map((term) => ({
    termKey: term.termKey,
    termMonths: term.termMonths,
    ...(term.mileage.state === 'KNOWN' ? { mileageKmPerYear: term.mileage.kmPerYear } : {}),
    isDefaultMileage: term.mileage.state === 'KNOWN' ? term.mileage.isDefault : false,
    monthlyRent: structuredClone(term.monthlyRent),
  }));

  const depositByTerm = commercial.terms.map((term) => ({
    termKey: term.termKey,
    state: term.deposit.state,
    ...('amount' in term.deposit ? { amount: structuredClone(term.deposit.amount) } : {}),
  }));

  const decisions = [...commercial.decisions];
  if (classified.unclassifiedPolicyFacts.length) decisions.push('POLICY_FACT_CLASSIFICATION_REQUIRED');

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
    rentalRates,
    policy: {
      ...(offer.policyId ? { policyId: offer.policyId } : {}),
      ...(commercial.defaultMileage.state === 'KNOWN'
        ? { defaultAnnualMileageKm: commercial.defaultMileage.kmPerYear }
        : {}),
      facts: classified.policyFacts,
    },
    contractConditions: {
      depositByTerm,
      facts: classified.contractFacts,
    },
    review: {
      status: commercial.invalidFacts.length
        ? 'INVALID'
        : decisions.length
          ? 'NEEDS_DECISION'
          : 'READY',
      decisions: [...new Set(decisions)].sort(),
      invalidFacts: [...commercial.invalidFacts],
      unclassifiedPolicyFacts: classified.unclassifiedPolicyFacts,
    },
  };
}
