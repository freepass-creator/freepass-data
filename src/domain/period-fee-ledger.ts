type LedgerFeeState = 'CALCULATED' | 'CALCULATED_APPROX' | 'UNKNOWN' | 'NOT_APPLICABLE';
type DepositState = 'KNOWN' | 'ZERO' | 'UNKNOWN' | 'NOT_APPLICABLE';
type LedgerEvidenceScope = 'BASELINE_NOT_CONTRACT_EVIDENCE' | 'OBSERVED_AT_SNAPSHOT' | 'UNKNOWN_SCOPE';
type VehicleValueEvidence = {
  grade: 'CONFIRMED' | 'APPROX';
  source: 'SUPPLIER_RAW' | 'CONSUMER_PRICE' | 'NEW_CAR_TRIM';
  amount: number;
  differenceAmount?: number;
};

type LedgerFeeAmount = {
  state: LedgerFeeState;
  amount: { amount: number; currency: 'KRW' } | null;
  vatTreatment: 'EXCLUDED' | 'INCLUDED' | 'UNKNOWN' | null;
  vatAmount: number | null;
  totalAmount: number | null;
  reasonCode: string | null;
  ruleId: string | null;
  policyId: string | null;
  sourceRefs: string[];
};

type DepositEvidenceKind = 'SOURCE_AMOUNT' | 'SUPPLIER_RULE_NOTE' | 'VERIFIED_ZERO_TEXT' | 'UNKNOWN';

type LedgerDepositEvidence = {
  kind: DepositEvidenceKind;
  ruleCode: string | null;
  noteField: 'deposit_note' | string | null;
  noteText: string | null;
  sourcePriceKey: string;
  calculationBasis: string | null;
  policyCode: string | null;
};

export type PeriodFeeLedgerRow = {
  schemaVersion: 'period-fee-ledger/v1';
  snapshotId: string;
  snapshotDateKst: string;
  computedAt: string;
  valueBasis: 'CURRENT_AT_SNAPSHOT';
  valueAsOf: string;
  evidenceScope: LedgerEvidenceScope;
  engineRevision: string;
  sourceDigest: string;
  documentKey: string;
  applyState: 'READY' | 'HOLD';
  holdReasonCode: string | null;
  vehicleUid: string | null;
  assetId: string | null;
  plateLookupKey: string | null;
  plateLast4ForReport: string | null;
  supplierId: string;
  productId: string;
  offerId: string;
  offerRevision: number;
  productUpdateTime: string | null;
  termKey: string;
  termMonths: number;
  monthlyRent: { amount: number; currency: 'KRW'; state: 'KNOWN' | 'UNKNOWN'; reasonCode: string | null };
  deposit: {
    state: DepositState;
    amount: { amount: number; currency: 'KRW' } | null;
    reasonCode: string | null;
    sourceRefs: string[];
    depositEvidence: LedgerDepositEvidence;
  };
  vehicleValueEvidence?: VehicleValueEvidence | null;
  supplierBillingFee: LedgerFeeAmount;
  channelPayoutFee: LedgerFeeAmount;
  ruleIds: string[];
  policyIds: string[];
  priceSourceRefs: string[];
  inputRefs: {
    productPath: string;
    offerPath: string;
    priceTermRef: string;
    internalEconomicsRef: string | null;
  };
};

export type ProductChangeHistoryRow = {
  schemaVersion: 'product-change-history/v1';
  productKey: string;
  kind: 'STATUS' | 'RENT' | 'DEPOSIT';
  fieldPath: 'vehicle_status' | 'status' | 'status_kind' | 'listable' | 'priceTerms.monthlyRent' | 'priceTerms.deposit';
  before: unknown;
  after: unknown;
  changedAtKst: string;
  snapshotId: string;
  sourceObservationRef: string | null;
};

export type ProductChangeHistoryBaselineRow = {
  schemaVersion: 'product-change-history/v1';
  productKey: string;
  kind: 'BASELINE';
  fieldPath: 'status';
  before: null;
  after: Record<string, unknown>;
  changedAtKst: string;
  snapshotId: string;
  sourceObservationRef: string | null;
};

export type PeriodFeeSnapshotRun = {
  schemaVersion: 'period-fee-snapshot-run/v1';
  runId: string;
  snapshotId: string;
  planDigest: string;
  status: 'PREPARED' | 'ACTIVE' | 'SUPERSEDED' | 'ROLLING_BACK' | 'ROLLED_BACK' | 'INACTIVE' | 'FAILED';
  active: boolean;
  previousActiveRunId: string | null;
  preparedAt: string;
  activatedAt: string | null;
  rowCount: number;
  rowKeysDigest: string;
  rowContentDigest: string;
  readyRowCount: number;
  holdNoUidCount: number;
  historyRowCount: number;
  historyKeysDigest: string;
  historyContentDigest: string;
  readbackSampleCount: number;
  readbackDigest: string | null;
};

export type PeriodFeeSnapshotWriteLock = {
  schemaVersion: 'period-fee-snapshot-write-lock/v1';
  lockId: '_apply_lock';
  ownerId: string;
  acquiredAt: string;
  leaseExpiresAt: string;
};

export type PeriodFeeLedgerFeeState = LedgerFeeState;
export type PeriodFeeDepositState = DepositState;
export type PeriodFeeLedgerEvidenceScope = LedgerEvidenceScope;
export type PeriodFeeDepositEvidenceKind = DepositEvidenceKind;
export type PeriodFeeLedgerFeeAmount = LedgerFeeAmount;
export type PeriodFeeLedgerDepositEvidence = LedgerDepositEvidence;
export type PeriodFeeVehicleValueEvidence = VehicleValueEvidence;
