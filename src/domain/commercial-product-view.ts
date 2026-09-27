import type { CommercialType, Money, VehicleAssetStatus } from './catalog.js';

export type CommercialFactValue = boolean | number | string | string[];

export type CommercialFact = {
  key: string;
  value: CommercialFactValue;
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
  rentalRates: Array<{
    termKey: string;
    termMonths: number;
    mileageKmPerYear?: number;
    isDefaultMileage: boolean;
    monthlyRent: Money;
  }>;
  policy: {
    policyId?: string;
    defaultAnnualMileageKm?: number;
    facts: CommercialFact[];
  };
  contractConditions: {
    depositByTerm: Array<{
      termKey: string;
      state: 'KNOWN' | 'ZERO' | 'UNKNOWN' | 'NOT_APPLICABLE';
      amount?: Money;
    }>;
    facts: CommercialFact[];
  };
  review: {
    status: 'READY' | 'NEEDS_DECISION' | 'INVALID';
    decisions: string[];
    invalidFacts: string[];
    unclassifiedPolicyFacts: string[];
  };
};
