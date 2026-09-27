import type { Money } from './catalog.js';

export type CommercialTermsStatus = 'READY' | 'NEEDS_DECISION' | 'INVALID';

export type MileageResolution =
  | { state: 'KNOWN'; kmPerYear: number; source: 'TERM' | 'POLICY_DEFAULT'; isDefault: boolean }
  | { state: 'UNKNOWN'; source: 'UNRESOLVED'; isDefault: false };

export type DepositResolution =
  | { state: 'KNOWN' | 'ZERO'; amount: Money; source: 'TERM' }
  | { state: 'NOT_APPLICABLE'; source: 'TERM' }
  | { state: 'UNKNOWN'; source: 'UNRESOLVED' };

export type ResolvedCommercialTerm = {
  termKey: string;
  termMonths: number;
  monthlyRent: Money;
  mileage: MileageResolution;
  deposit: DepositResolution;
};

export type OfferCommercialTerms = {
  offerId: string;
  productId: string;
  supplierId: string;
  policyId?: string;
  defaultMileage:
    | { state: 'KNOWN'; kmPerYear: number; source: 'POLICY' }
    | { state: 'UNKNOWN'; source: 'UNRESOLVED' };
  terms: ResolvedCommercialTerm[];
  status: CommercialTermsStatus;
  decisions: string[];
  invalidFacts: string[];
};
