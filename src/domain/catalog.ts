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
  | 'NEW_RENT' | 'USED_RENT' | 'NEW_SUBSCRIPTION' | 'USED_SUBSCRIPTION' | 'PICKUP_SUBSCRIPTION';
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
export type Offer = EntityMeta & {
  id: string; productId: string; supplierId: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED';
  validFrom?: string | null; validUntil?: string | null; policyId?: string | null;
  priceTerms: PriceTerm[];
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
  }>;
};
export type ProjectionRelease<T> = {
  releaseId: string; projectionId: string; schemaVersion: string; canonicalRevision: number;
  manifestId: string; inputDigest: string; dataDigest: string;
  status: 'BUILDING' | 'VALIDATING' | 'READY' | 'ACTIVE' | 'FAILED';
  generatedAt: string; activatedAt?: string | null; data: T[];
};
