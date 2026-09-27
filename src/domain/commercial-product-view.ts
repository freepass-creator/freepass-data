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
  options: Record<string, CommercialFactValue>;
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
  };
  pricingBasis: Array<{
    termKey: string;
    termMonths: number;
    mileageKmPerYear?: number;
    monthlyRent: Money;
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
