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
  rentalTerms: Array<{
    termKey: string;
    termMonths: number;
    mileageKmPerYear?: number;
    isDefaultMileage: boolean;
    monthlyRent: Money;
    deposit: {
      state: 'KNOWN' | 'ZERO' | 'UNKNOWN' | 'NOT_APPLICABLE';
      amount?: Money;
    };
  }>;
  policy: {
    policyId?: string;
    defaultAnnualMileageKm?: number;
    facts: CommercialFact[];
  };
  contractConditions: {
    facts: CommercialFact[];
  };
  review: {
    status: 'READY' | 'NEEDS_DECISION' | 'INVALID';
    decisions: string[];
    invalidFacts: string[];
    unclassifiedPolicyFacts: string[];
  };
};
