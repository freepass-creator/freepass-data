export const SETTLEMENT_LEDGER_VIEW_CONTRACT = 'freepass-data.settlement-ledger/v1' as const;

export const SETTLEMENT_LEDGER_FILTER_FIELDS = [
  'code',
  'plate',
  'receivedAt',
  'billMonth',
  'claimStage',
  'payStage',
  'supplierCode',
  'channelCode',
  'agent',
  'customer',
] as const;

export type SettlementLedgerFilterField = typeof SETTLEMENT_LEDGER_FILTER_FIELDS[number];

export type SettlementLedgerReadRequest = { viewVersion?: 1 | 2 } & (
  | { kind: 'doc'; id: string }
  | {
      kind: 'query';
      filters: Array<{ field: SettlementLedgerFilterField; value: string }>;
      limit?: number;
    });

export type SettlementMoneyFact = {
  supply: number | null;
  vat: number | null;
  total: number | null;
  sourceFields: string[];
};

export type SettlementReconciliation = {
  recorded: { claim: SettlementMoneyFact; pay: SettlementMoneyFact };
  written: { claim: SettlementMoneyFact; pay: SettlementMoneyFact };
  calculated: { claim: SettlementMoneyFact; pay: SettlementMoneyFact };
  confirmed: { claim: SettlementMoneyFact; pay: SettlementMoneyFact };
  cash: {
    claim: { amount: number | null; at: string | null; reportedComplete: boolean | null };
    pay: { amount: number | null; at: string | null; reportedComplete: boolean | null };
    verification: 'RECORDED_UNVERIFIED';
    eventsState: 'READ' | 'UNAVAILABLE' | 'LIMIT_REACHED' | 'IDENTITY_MISSING';
    eventsDigest: string | null;
    events: Array<{ id: string; axis: string | null; kind: string | null; amount: number | null; day: string | null; by: string | null; createdAt: string | null }>;
  };
  audit: {
    createdBy: string | null; updatedBy: string | null;
    createdAt: string | null; updatedAt: string | null; businessDate: string | null;
    historyState: 'IDENTITY_MISSING' | 'READ' | 'UNAVAILABLE';
    history: Array<{ id: string; at: string | null; by: string | null; field: string | null; from: SettlementLedgerValue; to: SettlementLedgerValue }>;
    historyDigest: string | null;
  };
  evidence: { sourceDigest: string | null; receiptRow: number | null; syncedAt: string | null };
};

export type SettlementSnapshotSummary = {
  scope: 'MONTH' | 'FILTERED';
  billingMonth: string | null;
  completeness: 'COMPLETE' | 'LIMIT_REACHED' | 'ELIGIBILITY_UNKNOWN';
  entryIds: string[];
  excludedIds: string[];
  uncertainEligibilityIds: string[];
  storedSummaryComparison: { state: 'MATCH' | 'MISMATCH' | 'UNAVAILABLE' | 'NOT_COMPARABLE'; sourceDigest: string | null; components?: Record<'ids' | 'supply' | 'vat' | 'total', 'MATCH' | 'MISMATCH' | 'UNKNOWN'> };
  totals: Record<'recordedClaim' | 'recordedPay' | 'writtenClaim' | 'writtenPay' | 'calculatedClaim' | 'calculatedPay' | 'confirmedClaim' | 'confirmedPay', {
    knownSubtotal: number;
    missingCount: number;
    supply: number | null;
    vat: { knownSubtotal: number; missingCount: number; amount: number | null };
    total: { knownSubtotal: number; missingCount: number; amount: number | null };
  }>;
};

export type SettlementLedgerValue = string | number | boolean | null;

export type SettlementLedgerRecord = {
  ledgerId: string;
  reconciliation?: SettlementReconciliation;
  identity: {
    vehicleNumber: string | null;
    receivedAt: string | null;
  };
  contract: {
    customerName: string | null;
    model: string | null;
    productKind: string | null;
    paymentKind: string | null;
    paidRounds: number | null;
  };
  parties: {
    supplierName: string | null;
    supplierCode: string | null;
    channelName: string | null;
    channelCode: string | null;
    agentName: string | null;
    agentCode: string | null;
  };
  progress: {
    contractDocumentReceived: boolean | null;
    delivered: boolean | null;
    deliveredAt: string | null;
    cancelled: boolean | null;
    billed: boolean | null;
    billingMonth: string | null;
    billedAt: string | null;
    invoiceIssued: boolean | null;
    invoiceAt: string | null;
    collected: boolean | null;
    collectedAmount: number | null;
    paid: boolean | null;
    paidAmount: number | null;
    billingHold: boolean | null;
    settlementExcluded: boolean | null;
    claimStage: string | null;
    payStage: string | null;
  };
  money: {
    claimAmount: number | null;
    payAmount: number | null;
    claimAdjustment: number | null;
    payAdjustment: number | null;
    adjustmentReason: string | null;
    calculationBasis: string | null;
    supplierFeeRaw: SettlementLedgerValue;
    channelFeeRaw: SettlementLedgerValue;
  };
  source: {
    authority: 'FREEPASS_DATA_SETTLEMENT';
    project: 'freepasserp5';
    collection: 'settlement_rows';
    documentId: string;
  };
};

export type SettlementLedgerView = {
  schema: typeof SETTLEMENT_LEDGER_VIEW_CONTRACT | 'freepass-data.settlement-ledger/v2';
  data: SettlementLedgerRecord[];
  meta: {
    consumerId: string;
    authority: 'FREEPASS_DATA_SETTLEMENT';
    sourceProject: 'freepasserp5';
    sourceCollection: 'settlement_rows';
    observedAt: string;
    count: number;
    sourceDigest: string;
    dataDigest: string;
    snapshotSummary?: SettlementSnapshotSummary;
    sourceFreshness?: { state: 'UNVERIFIED'; reason: 'SOURCE_NOT_VERIFIED_BY_THIS_READ' };
  };
};

const safeId = (value: unknown) =>
  typeof value === 'string'
  && value.trim() === value
  && value.length > 0
  && value.length <= 256
  && !/[\u0000-\u001f\u007f]/.test(value);

export function assertSettlementLedgerReadRequest(
  value: unknown,
): asserts value is SettlementLedgerReadRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_SETTLEMENT_LEDGER_READ');
  }
  const request = value as Record<string, unknown>;
  if (request.viewVersion !== undefined && request.viewVersion !== 1 && request.viewVersion !== 2) {
    throw new Error('INVALID_SETTLEMENT_LEDGER_READ');
  }
  if (request.kind === 'doc') {
    if (!safeId(request.id)) throw new Error('INVALID_SETTLEMENT_LEDGER_DOCUMENT_ID');
    return;
  }
  if (request.kind !== 'query' || !Array.isArray(request.filters)) {
    throw new Error('INVALID_SETTLEMENT_LEDGER_READ');
  }
  if (request.filters.length < 1 || request.filters.length > 4) {
    throw new Error('SETTLEMENT_LEDGER_QUERY_REQUIRES_FILTER');
  }
  const allowed = new Set<string>(SETTLEMENT_LEDGER_FILTER_FIELDS);
  for (const raw of request.filters) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('INVALID_SETTLEMENT_LEDGER_FILTER');
    }
    const filter = raw as Record<string, unknown>;
    if (!allowed.has(String(filter.field)) || !safeId(filter.value)) {
      throw new Error('INVALID_SETTLEMENT_LEDGER_FILTER');
    }
  }
  const fields = new Set(request.filters.map((raw) => (raw as { field: string }).field));
  if (fields.has('agent') !== fields.has('customer')) {
    throw new Error('SETTLEMENT_LEDGER_PERSON_LOOKUP_REQUIRES_AGENT_AND_CUSTOMER');
  }
  if (
    request.limit !== undefined
    && (!Number.isSafeInteger(request.limit) || Number(request.limit) < 1 || Number(request.limit) > 100)
  ) {
    throw new Error('INVALID_SETTLEMENT_LEDGER_LIMIT');
  }
}
