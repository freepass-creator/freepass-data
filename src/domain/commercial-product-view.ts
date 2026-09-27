import type { CommercialType, Money, VehicleAssetStatus } from './catalog.js';

export type CommercialFactValue = boolean | number | string | string[];

export type CommercialFact = {
  key: string;
  value: CommercialFactValue;
};

export type ProductConditionSelection = {
  termMonths?: number;
  mileageKmPerYear?: number;
  driverAge?: number;
  additionalDriverCount?: number;
  options: Record<string, CommercialFactValue>;
};

export type PricingConditionScope = {
  termMonths: number;
  mileage: {
    pricedUpToKmPerYear?: number;
    maxSelectableKmPerYear?: number;
  };
  driverAge: {
    includedFromAge?: number;
    lowerableToAge?: number;
    allowedToAge?: number;
  };
  drivers: {
    includedAdditionalDriverCount?: number;
    maxAdditionalDriverCount?: number;
    personalScope?: string;
    businessScope?: string;
  };
  licensePeriod?: CommercialFactValue;
  insuranceIncluded?: CommercialFactValue;
  maintenanceService?: CommercialFactValue;
};

export type PriceConditionEvidence = {
  dimensionKey: string;
  status: 'KNOWN' | 'UNKNOWN';
  value?: CommercialFactValue;
  origin:
    | 'SOURCE_PRICE_KEY'
    | 'CANONICAL_PRICE_TERM'
    | 'LINKED_POLICY_FACT'
    | 'UNRESOLVED';
  sourceRef?: string;
};

export type PriceBasisAttribution = {
  status: 'COMPLETE' | 'PARTIAL';
  conditions: PriceConditionEvidence[];
  unknownConditionKeys: string[];
  monthlyRentOrigin: {
    origin: 'CANONICAL_PRICE_TERM';
    sourceRef: string;
  };
  depositOrigin: {
    origin: 'CANONICAL_PRICE_TERM' | 'UNRESOLVED';
    sourceRef?: string;
  };
};

export type MonthlyRentModifier = {
  key: 'mileage_upcharge_per_10000km' | 'age_lowering_cost' | 'additional_driver_cost';
  dimension: 'MILEAGE' | 'DRIVER_AGE' | 'ADDITIONAL_DRIVER';
  target: 'MONTHLY_RENT';
  cadence: 'MONTHLY';
  unit: 'PER_10000KM' | 'ON_AGE_LOWERING' | 'PER_ADDITIONAL_DRIVER';
  rawValue: CommercialFactValue;
};

export type ProductPriceResult = {
  status: 'READY' | 'NEEDS_DECISION' | 'INVALID';
  selection: ProductConditionSelection;
  basisTermKey?: string;
  monthlyRent?: Money;
  deposit?: {
    state: 'KNOWN' | 'ZERO' | 'UNKNOWN' | 'NOT_APPLICABLE';
    amount?: Money;
  };
  decisions: string[];
  invalidFacts: string[];
};

export type CommercialProductView = {
  vehicle: {
    productId: string;
    commercialType: CommercialType;
    displayName: string;
    vehicleModelId: string;
    vehicleAssetId?: string;
    maker: string;
    model: string;
    generation?: string | null;
    subModel?: string | null;
    trim?: string | null;
    fuel?: string | null;
    drive?: string | null;
    seats?: number | null;
    assetStatus?: VehicleAssetStatus;
    plateNumber?: string | null;
    odometerKm?: number | null;
  };
  conditionProfile: {
    defaults: ProductConditionSelection;
    available: {
      termMonths: number[];
      mileageKmPerYear: number[];
    };
    monthlyRentModifiers: MonthlyRentModifier[];
  };
  pricingBasis: Array<{
    termKey: string;
    conditionScope: PricingConditionScope;
    monthlyRent: Money;
    attribution: PriceBasisAttribution;
    deposit: {
      state: 'KNOWN' | 'ZERO' | 'UNKNOWN' | 'NOT_APPLICABLE';
      amount?: Money;
    };
  }>;
  policy: {
    policyId?: string;
    facts: CommercialFact[];
  };
  contractConditions: {
    facts: CommercialFact[];
  };
  preview: ProductPriceResult;
  review: {
    status: 'READY' | 'NEEDS_DECISION' | 'INVALID';
    decisions: string[];
    invalidFacts: string[];
    unclassifiedPolicyFacts: string[];
  };
};
