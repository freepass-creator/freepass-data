import type { Policy } from '../domain/catalog.js';
import type {
  CommercialFactValue,
  MonthlyRentModifier,
  PricingConditionScope,
} from '../domain/commercial-product-view.js';

export const PRICING_SCOPE_POLICY_KEYS = [
  'annual_mileage',
  'max_annual_mileage',
  'basic_driver_age',
  'driver_age_lowering',
  'driver_age_upper_limit',
  'license_period',
  'personal_driver_scope',
  'business_driver_scope',
  'additional_driver_allowance_count',
  'insurance_included',
  'maintenance_service',
] as const;

export const MONTHLY_RENT_MODIFIER_KEYS = [
  'mileage_upcharge_per_10000km',
  'age_lowering_cost',
  'additional_driver_cost',
] as const;

export function policyScalar(value: unknown): CommercialFactValue | undefined {
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return [...value];
  return undefined;
}

export function numberFromPolicy(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const normalized = value.replaceAll(',', '').trim();
  if (!normalized || /^(?:불가|협의|없음|제한없음|무제한)$/i.test(normalized)) return undefined;
  const match = normalized.match(/\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const n = Number(match[0]);
  if (!Number.isFinite(n) || n < 0) return undefined;
  if (/만\s*(?:km|킬로)/i.test(normalized)) return Math.round(n * 10000);
  return n;
}

export function buildPricingConditionScope(input: {
  termMonths: number;
  mileageKmPerYear?: number;
  policy?: Policy;
}): PricingConditionScope {
  const { termMonths, mileageKmPerYear, policy } = input;
  const facts = policy?.facts ?? {};
  const basicAge = numberFromPolicy(facts.basic_driver_age);
  const lowerAge = numberFromPolicy(facts.driver_age_lowering);
  const upperAge = numberFromPolicy(facts.driver_age_upper_limit);
  const maxMileage = numberFromPolicy(facts.max_annual_mileage);
  const maxAdditionalDrivers = numberFromPolicy(facts.additional_driver_allowance_count);

  const personalScope = typeof facts.personal_driver_scope === 'string'
    ? facts.personal_driver_scope.trim() || undefined
    : undefined;
  const businessScope = typeof facts.business_driver_scope === 'string'
    ? facts.business_driver_scope.trim() || undefined
    : undefined;

  const licensePeriod = policyScalar(facts.license_period);
  const insuranceIncluded = policyScalar(facts.insurance_included);
  const maintenanceService = policyScalar(facts.maintenance_service);

  return {
    termMonths,
    mileage: {
      ...(mileageKmPerYear !== undefined ? { pricedUpToKmPerYear: mileageKmPerYear } : {}),
      ...(maxMileage !== undefined ? { maxSelectableKmPerYear: maxMileage } : {}),
    },
    driverAge: {
      ...(basicAge !== undefined ? { includedFromAge: basicAge } : {}),
      ...(lowerAge !== undefined ? { lowerableToAge: lowerAge } : {}),
      ...(upperAge !== undefined ? { allowedToAge: upperAge } : {}),
    },
    drivers: {
      ...(maxAdditionalDrivers !== undefined ? { maxAdditionalDriverCount: maxAdditionalDrivers } : {}),
      ...(personalScope ? { personalScope } : {}),
      ...(businessScope ? { businessScope } : {}),
    },
    ...(licensePeriod !== undefined ? { licensePeriod } : {}),
    ...(insuranceIncluded !== undefined ? { insuranceIncluded } : {}),
    ...(maintenanceService !== undefined ? { maintenanceService } : {}),
  };
}

export function buildMonthlyRentModifiers(policy?: Policy): MonthlyRentModifier[] {
  if (!policy) return [];
  const specs = [
    ['mileage_upcharge_per_10000km', 'MILEAGE', 'PER_10000KM'],
    ['age_lowering_cost', 'DRIVER_AGE', 'ON_AGE_LOWERING'],
    ['additional_driver_cost', 'ADDITIONAL_DRIVER', 'PER_ADDITIONAL_DRIVER'],
  ] as const;
  const out: MonthlyRentModifier[] = [];
  for (const [key, dimension, unit] of specs) {
    const rawValue = policyScalar(policy.facts[key]);
    if (rawValue === undefined) continue;
    out.push({ key, dimension, target: 'MONTHLY_RENT', cadence: 'MONTHLY', unit, rawValue });
  }
  return out;
}
