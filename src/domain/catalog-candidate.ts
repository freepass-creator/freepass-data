import type { CommercialType, PriceTerm } from './catalog.js';

export type CatalogCandidate = {
  sourceRecordId: string;
  sourceFingerprint: string;
  productCode?: string;
  carNumber?: string;
  maker?: string;
  model?: string;
  subModel?: string;
  trimName?: string;
  commercialType?: CommercialType;
  providerCompanyCode?: string;
  policyCode?: string;
  vehicleStatusRaw?: string;
  year?: string;
  fuelType?: string;
  mileageKm?: number;
  driveType?: string;
  seats?: number;
  origin?: string;
  priceTerms: PriceTerm[];
  issues: string[];
};
