import type { CommercialOfferView } from './commercial-product-view.js';
export type ValidationStatus = 'VALID' | 'WARNING' | 'INVALID';
export type ActorRef = { id: string; kind: 'USER' | 'SERVICE'; organizationId?: string | null };
export type Money = { amount: number; currency: 'KRW' };
export type EntityMeta = {
  schemaVersion: string; revision: number; validationStatus: ValidationStatus;
  createdAt: string; updatedAt: string; createdBy: ActorRef; updatedBy: ActorRef;
  lineageId: string; sourceRevision?: string;
};
export type VehicleModel = EntityMeta & {
  id: string; maker: string; model: string; displayName: string;
  generation?: string | null; subModel?: string | null; trim?: string | null; fuel?: string | null;
  drive?: string | null; seats?: number | null;
};
export type VehicleAssetStatus =
  | 'AVAILABLE' | 'RESERVED' | 'IN_USE' | 'RETURNED'
  | 'MAINTENANCE' | 'ACCIDENT' | 'SOLD' | 'RETIRED';
export type VehicleAsset = EntityMeta & {
  id: string; vehicleModelId: string; status: VehicleAssetStatus;
  plateNumber?: string | null; vin?: string | null; odometerKm?: number | null;
};
export type CommercialType =
  | 'NEW_RENT' | 'USED_RENT' | 'NEW_SUBSCRIPTION' | 'USED_SUBSCRIPTION'
  | 'OGONG_SUBSCRIPTION' | 'PICKUP_SUBSCRIPTION';
export type Product = EntityMeta & {
  id: string; vehicleModelId: string; vehicleAssetId?: string | null;
  commercialType: CommercialType; status: 'ACTIVE' | 'HOLD' | 'SOLD' | 'ARCHIVED';
  displayName: string;
};
export type DepositState = 'KNOWN' | 'ZERO' | 'UNKNOWN' | 'NOT_APPLICABLE';
export type PriceTerm = {
  termKey: string; termMonths: number; monthlyRent: Money; deposit?: Money | null;
  depositState: DepositState; mileageLimitKmPerYear?: number | null;
};
export type TermAmountState = 'KNOWN' | 'ZERO' | 'UNKNOWN' | 'NOT_APPLICABLE';
export type TermAmountCalculation =
  | { kind: 'FIXED'; amount: Money }
  | { kind: 'MULTIPLY'; base: 'MONTHLY_RENT'; multiplier: number }
  | { kind: 'RATE'; base: 'MONTHLY_RENT_X_TERM' | 'VEHICLE_PRICE'; rate: number };
export type TermEconomicAmount = {
  state: TermAmountState;
  amount?: Money | null;
  calculation?: TermAmountCalculation | null;
  sourceRefs: string[];
  ruleId?: string | null;
  policyId?: string;
  reasonCode?: string | null;
};
export type OfferTermEconomics = {
  termKey: string;
  termMonths?: number;
  monthlyRent?: Money;
  depositCalculation: TermEconomicAmount;
  supplierBillingFee: TermEconomicAmount;
  channelPayoutFee: TermEconomicAmount;
};

/** Commission names are from FreePass's perspective, never the caller's perspective. */
export const COMMISSION_CONSUMER_POLICY = {
  SALES_CHANNEL: {
    field: 'channelPayoutFee', label: '프리패스 수수료',
    payer: 'FREEPASS', payee: 'SALES_CHANNEL',
  },
  SUPPLIER: {
    field: 'supplierBillingFee', label: '공급사 청구수수료',
    payer: 'SUPPLIER', payee: 'FREEPASS',
  },
} as const;
export const DEFAULT_COMMISSION_AUDIENCE = 'SALES_CHANNEL' as const;

/**
 * Prepared counterparty projection, not an authorization gate or an API route.
 * The caller must bind audience and counterparty scope from server-owned grants.
 * Rates/source refs and the opposite fee stay internal; no margin is returned.
 */
export function projectCounterpartyCommission(
  term: OfferTermEconomics,
  audience: 'SALES_CHANNEL' | 'SUPPLIER' = DEFAULT_COMMISSION_AUDIENCE,
) {
  if (audience !== 'SALES_CHANNEL' && audience !== 'SUPPLIER') {
    throw new Error('Unsupported commission audience');
  }
  const policy = COMMISSION_CONSUMER_POLICY[audience];
  const fee = term[policy.field];
  const validAmount = fee.amount?.currency === 'KRW' &&
    Number.isSafeInteger(fee.amount.amount) && fee.amount.amount >= 0;
  const resolved = validAmount && (
    (fee.state === 'KNOWN' && fee.amount!.amount > 0) ||
    (fee.state === 'ZERO' && fee.amount!.amount === 0)
  );
  return {
    termKey: term.termKey,
    audience,
    feeType: policy.field,
    label: policy.label,
    payer: policy.payer,
    payee: policy.payee,
    state: fee.state === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' as const
      : resolved ? fee.state : 'UNKNOWN' as const,
    amount: resolved ? { ...fee.amount! } : null,
  };
}
export type Offer = EntityMeta & {
  id: string; productId: string; supplierId: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED';
  validFrom?: string | null; validUntil?: string | null; policyId?: string | null;
  priceTerms: PriceTerm[];
  /** Internal product economics. Never include this field in public/white-label projections. */
  internalEconomicsTerms?: OfferTermEconomics[];
};
export type Policy = EntityMeta & {
  id: string; kind: 'INSURANCE' | 'MILEAGE' | 'RETURN' | 'EARLY_TERMINATION' | 'OTHER';
  version: string; effectiveFrom: string; effectiveTo?: string | null;
  facts: Record<string, unknown>;
};
export type AuditEvent = {
  eventId: string; commandId: string; actor: ActorRef; entityType: string; entityId: string;
  action: string; before: unknown; after: unknown; reason: string;
  writerId?: string; authorityRuleId?: string;
  revisionBefore: number; revisionAfter: number; occurredAt: string;
};
export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'DONE' | 'DEAD_LETTER';
export type OutboxEvent = {
  eventId: string; eventType: string; entityType: string; entityId: string;
  sourceRevision: number; targetRevision: number; commandId: string;
  correlationId: string; causationId: string; occurredAt: string;
  status: OutboxStatus; attempts: number; nextAttemptAt?: string | null;
  leaseOwner?: string | null; leaseUntil?: string | null; lastError?: string | null;
};
export type CommandReceipt = {
  idempotencyKey: string; commandId: string; status: 'CANONICAL_COMMITTED';
  entityType: string; entityId: string; revision: number; committedAt: string;
  requestDigest?: string; writerId?: string; authorityRuleId?: string;
};
export type ErpPublicProduct = {
  productId: string; productRevision: number; vehicleModelId: string;
  vehicleAssetId?: string | null; displayName: string; commercialType: CommercialType;
  vehicle: {
    maker: string; model: string; generation?: string | null; subModel?: string | null; trim?: string | null;
    fuel?: string | null; drive?: string | null; seats?: number | null;
    assetStatus?: VehicleAssetStatus | null; plateNumber?: string | null; odometerKm?: number | null;
  };
  offers: Array<{
    offerId: string; supplierId: string; offerRevision: number;
    policyId?: string | null; priceTerms: PriceTerm[];
    commercial?: CommercialOfferView;
  }>;
};
export type AdminPolicyValue =
  | { policyId: string; type: 'BOOLEAN'; value: boolean }
  | { policyId: string; type: 'NUMBER' | 'MONEY' | 'PERCENTAGE'; value: number }
  | { policyId: string; type: 'SINGLE_SELECT' | 'TEXT' | 'DATE'; value: string }
  | { policyId: string; type: 'MULTI_SELECT'; value: string[] };

export type AdminPolicyState = 'COMPLETE' | 'MISSING' | 'INVALID';
export type AdminPriceTerm = PriceTerm & {
  supplierBillingFee: TermEconomicAmount;
  channelPayoutFee: TermEconomicAmount;
};
export type EconomicsCoverage = {
  economicsCoverage: 'COMPLETE' | 'INCOMPLETE';
  economicsTermCounts: {
    supplierBillingFee: Record<TermAmountState, number>;
    channelPayoutFee: Record<TermAmountState, number>;
  };
};

export type AdminCatalogProduct = {
  productId: string;
  productRevision: number;
  updatedAt: string;
  displayName: string;
  commercialType: CommercialType;
  vehicleModel: {
    id: string;
    maker: string;
    model: string;
    generation?: string | null;
    subModel?: string | null;
    trim?: string | null;
    fuel?: string | null;
    drive?: string | null;
    seats?: number | null;
  };
  vehicleAsset?: {
    id: string;
    status: VehicleAssetStatus;
    plateNumber?: string | null;
    vin?: string | null;
    odometerKm?: number | null;
  } | null;
  offers: Array<{
    offerId: string;
    offerRevision: number;
    supplierId: string;
    policyId?: string | null;
    policyState: AdminPolicyState;
    policyValues: AdminPolicyValue[];
    invalidPolicyFactRefs: string[];
    priceTerms: AdminPriceTerm[];
    commercial?: CommercialOfferView;
  }>;
};

export type ProjectionProduct = ErpPublicProduct | AdminCatalogProduct;

export type ProjectionRelease<T> = {
  releaseId: string; projectionId: string; schemaVersion: string; canonicalRevision: number;
  manifestId: string; inputDigest: string; dataDigest: string;
  status: 'BUILDING' | 'VALIDATING' | 'READY' | 'ACTIVE' | 'FAILED';
  generatedAt: string; activatedAt?: string | null; data: T[];
  /** Internal Admin release only; gateway recomputes from digest-verified data. */
  economics?: EconomicsCoverage;
};
