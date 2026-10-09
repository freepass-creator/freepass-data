import type { AdminWorkflowStore } from '../ports/admin-workflow.js';
import { stableDigest } from '../shared/stable-digest.js';
import {
  SETTLEMENT_LEDGER_VIEW_CONTRACT,
  assertSettlementLedgerReadRequest,
  type SettlementLedgerReadRequest,
  type SettlementLedgerRecord,
  type SettlementLedgerValue,
  type SettlementLedgerView,
  type SettlementReconciliation,
  type SettlementSnapshotSummary,
} from '../domain/settlement-ledger-view.js';

const stringOrNull = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;
const numberOrNull = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const booleanOrNull = (value: unknown) =>
  typeof value === 'boolean' ? value : null;
const dateOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const day = text.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const parsed = new Date(day + 'T00:00:00Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return null;
  if (text === day) return day;
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(text) || Number.isNaN(Date.parse(text))) return null;
  // Timestamp dates are Korean calendar dates, independent of the host's timezone.
  // The original timestamp remains in v2 dateSourceValues; businessDate is never inferred.
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(text));
  return ['year', 'month', 'day'].map((type) => parts.find((part) => part.type === type)!.value).join('-');
};
const timestampOrNull = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (value && typeof value === 'object') {
    const time = value as { seconds?: unknown; _seconds?: unknown; nanoseconds?: unknown; _nanoseconds?: unknown };
    const seconds = time.seconds ?? time._seconds, nanos = time.nanoseconds ?? time._nanoseconds ?? 0;
    if (typeof seconds === 'number' && typeof nanos === 'number' && Number.isFinite(seconds) && Number.isFinite(nanos)) {
      return timestampOrNull(seconds * 1000 + Math.floor(nanos / 1000000));
    }
  }
  return null;
};
const rawScalar = (value: unknown): SettlementLedgerValue =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? value
    : null;

export function projectSettlementLedgerRecord(
  documentId: string,
  data: Record<string, unknown>,
): SettlementLedgerRecord {
  return {
    ledgerId: stringOrNull(data.code) ?? documentId,
    identity: {
      vehicleNumber: stringOrNull(data.plate),
      receivedAt: dateOrNull(data.receivedAt),
    },
    contract: {
      customerName: stringOrNull(data.customer),
      model: stringOrNull(data.model),
      productKind: stringOrNull(data.product),
      paymentKind: stringOrNull(data.payKind),
      paidRounds: numberOrNull(data.paidRounds),
    },
    parties: {
      supplierName: stringOrNull(data.supplier),
      supplierCode: stringOrNull(data.supplierCode),
      channelName: stringOrNull(data.channel),
      channelCode: stringOrNull(data.channelCode),
      agentName: stringOrNull(data.agent),
      agentCode: stringOrNull(data.agentCode),
    },
    progress: {
      contractDocumentReceived: booleanOrNull(data.paper),
      delivered: booleanOrNull(data.delivered),
      deliveredAt: dateOrNull(data.deliveredAt),
      cancelled: booleanOrNull(data.cancelled),
      billed: booleanOrNull(data.billed),
      billingMonth: stringOrNull(data.billMonth),
      billedAt: dateOrNull(data.billedAt),
      invoiceIssued: booleanOrNull(data.invoiceIssued),
      invoiceAt: dateOrNull(data.invoiceAt),
      collected: booleanOrNull(data.collected),
      collectedAmount: numberOrNull(data.collectedAmt),
      paid: booleanOrNull(data.paid),
      paidAmount: numberOrNull(data.paidAmt),
      billingHold: booleanOrNull(data.billHold),
      settlementExcluded: booleanOrNull(data.settleExclude),
      claimStage: stringOrNull(data.claimStage),
      payStage: stringOrNull(data.payStage),
    },
    money: {
      claimAmount: numberOrNull(data.claimWritten),
      payAmount: numberOrNull(data.payWritten),
      claimAdjustment: numberOrNull(data.claimAdjust),
      payAdjustment: numberOrNull(data.payAdjust),
      adjustmentReason: stringOrNull(data.adjustReason),
      calculationBasis: typeof data.calculationBasis === 'string' ? data.calculationBasis : null,
      supplierFeeRaw: rawScalar(data.supplierRate),
      channelFeeRaw: rawScalar(data.agentRate),
    },
    source: {
      authority: 'FREEPASS_DATA_SETTLEMENT',
      project: 'freepasserp5',
      collection: 'settlement_rows',
      documentId,
    },
  };
}

/** Read recorded facts only. Never infer VAT, confirmation, actors or bank evidence. */
export function projectSettlementReconciliation(data: Record<string, unknown>): SettlementReconciliation {
  const fact = (supply: string, vat?: string, total?: string) => ({
    supply: numberOrNull(data[supply]),
    vat: vat ? numberOrNull(data[vat]) : null,
    total: total ? numberOrNull(data[total]) : null,
    sourceFields: [supply, ...(vat ? [vat] : []), ...(total ? [total] : [])],
  });
  return {
    recorded: {
      claim: fact('sourceReceiptClaim', 'sourceReceiptClaimVat', 'sourceReceiptClaimGross'),
      pay: fact('sourceReceiptPay', 'sourceReceiptPayVat', 'sourceReceiptPayGross'),
    },
    written: { claim: fact('claimWritten', 'claimVat', 'claimTotal'), pay: fact('payWritten', 'payVat', 'payTotal') },
    calculated: { claim: fact('computedBillingFee'), pay: fact('computedPayoutFee') },
    confirmed: { claim: fact('confirmedClaimAmount'), pay: fact('confirmedPayAmount') },
    cash: {
      claim: { amount: numberOrNull(data.collectedAmt), at: stringOrNull(data.collectedAt), reportedComplete: booleanOrNull(data.collected) },
      pay: { amount: numberOrNull(data.paidAmt), at: stringOrNull(data.paidAt), reportedComplete: booleanOrNull(data.paid) },
      verification: 'RECORDED_UNVERIFIED',
      eventsState: 'IDENTITY_MISSING', eventsDigest: null, events: [],
    },
    audit: {
      createdBy: stringOrNull(data.createdBy), updatedBy: stringOrNull(data.updatedBy),
      createdAt: timestampOrNull(data.createdAt), updatedAt: timestampOrNull(data.updatedAt),
      businessDate: stringOrNull(data.businessDate), historyState: 'IDENTITY_MISSING', history: [], historyDigest: null,
      dateSourceValues: (['receivedAt', 'deliveredAt', 'billedAt', 'invoiceAt'] as const).map((field) => ({ field, rawValue: rawScalar(data[field]) })),
    },
    evidence: { sourceDigest: stringOrNull(data.sourceReceiptDigest), receiptRow: numberOrNull(data.sourceReceiptRow), syncedAt: timestampOrNull(data.sourceReceiptSyncedAt) },
  };
}

function snapshotSummary(data: SettlementLedgerRecord[], request: SettlementLedgerReadRequest): SettlementSnapshotSummary {
  const included = data.filter((row) => row.progress.cancelled !== true && row.progress.settlementExcluded !== true);
  const excluded = data.filter((row) => !included.includes(row));
  const uncertainEligibilityIds = included.filter((row) => row.progress.cancelled === null || row.progress.settlementExcluded === null).map((row) => row.source.documentId);
  const limited = request.kind === 'query' && data.length >= (request.limit ?? 50);
  const complete = !limited && uncertainEligibilityIds.length === 0;
  const totals = {} as SettlementSnapshotSummary['totals'];
  for (const stage of ['recorded', 'written', 'calculated', 'confirmed'] as const) {
    for (const side of ['claim', 'pay'] as const) {
      const values = included.map((row) => row.reconciliation![stage][side].supply);
      const missingCount = values.filter((value) => value === null).length;
      const knownSubtotal = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      const key = `${stage}${side === 'claim' ? 'Claim' : 'Pay'}` as keyof typeof totals;
      const sumComponent = (component: 'vat' | 'total') => {
        const values = included.map((row) => row.reconciliation![stage][side][component]);
        const missingCount = values.filter((value) => value === null).length;
        const knownSubtotal = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
        return { knownSubtotal, missingCount, amount: complete && missingCount === 0 ? knownSubtotal : null };
      };
      totals[key] = { knownSubtotal, missingCount, supply: complete && missingCount === 0 ? knownSubtotal : null, vat: sumComponent('vat'), total: sumComponent('total') };
    }
  }
  const month = request.kind === 'query' && request.filters.length === 1 && request.filters[0]?.field === 'billMonth'
    ? request.filters[0].value : null;
  return {
    scope: month ? 'MONTH' : 'FILTERED', billingMonth: month,
    completeness: limited ? 'LIMIT_REACHED' : uncertainEligibilityIds.length ? 'ELIGIBILITY_UNKNOWN' : 'COMPLETE',
    entryIds: included.map((row) => row.source.documentId), excludedIds: excluded.map((row) => row.source.documentId),
    uncertainEligibilityIds,
    storedSummaryComparison: { state: 'NOT_COMPARABLE', sourceDigest: null },
    totals,
  };
}

export async function readSettlementLedgerView(
  store: AdminWorkflowStore,
  consumerId: string,
  request: SettlementLedgerReadRequest,
  observedAt = new Date().toISOString(),
): Promise<SettlementLedgerView> {
  assertSettlementLedgerReadRequest(request);
  const source = await store.read(request.kind === 'doc'
    ? { kind: 'doc', resource: 'settlementRows', id: request.id }
    : {
        kind: 'query',
        resource: 'settlementRows',
        filters: request.filters.map((filter) => ({ ...filter, op: '==' as const })),
        limit: request.limit ?? 50,
      });
  const extended = request.viewVersion === 2;
  const data = source.docs.map((document) => ({
    ...projectSettlementLedgerRecord(document.id, document.data),
    ...(extended ? { reconciliation: projectSettlementReconciliation(document.data) } : {}),
  }));
  if (extended) {
    // Separate evidence read; monthly totals still use only the single row snapshot above.
    await Promise.all(data.map(async (row, index) => {
      const raw = source.docs[index]!.data;
      // Adapter for Admin's existing intakeEventDocId (domain/settlement/code.ts), not a new ledger identity.
      const product = stringOrNull(raw.sourceProductId), intakeRequest = stringOrNull(raw.intakeRequestId);
      const identity = product ? `product:${product}` : raw.intakeIdentityMode === 'request' && intakeRequest ? `request:${intakeRequest}` : stringOrNull(raw.plate)?.replace(/\s/g, '') ?? (intakeRequest ? `request:${intakeRequest}` : null);
      const receivedAt = stringOrNull(raw.receivedAt);
      const eventId = stringOrNull(raw.auditEventId) ?? (identity && receivedAt ? `${identity}|${receivedAt}`.replace(/[.$#[\]/\s|:]/g, '_') : null);
      const audit = row.reconciliation!.audit;
      if (eventId && !/[\/\u0000-\u001f]/.test(eventId)) try {
        const events = await store.read({ kind: 'doc', resource: 'settlementEvents', id: eventId });
        audit.history = Object.entries(events.docs[0]?.data ?? {}).filter(([key, value]) => key.startsWith('aud_') && value && typeof value === 'object' && !Array.isArray(value)).map(([id, value]) => {
          const event = value as Record<string, unknown>;
          return { id, at: timestampOrNull(event.at), by: stringOrNull(event.by), field: stringOrNull(event.field), from: rawScalar(event.from), to: rawScalar(event.to) };
        }).sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '') || a.id.localeCompare(b.id));
        audit.historyState = 'READ'; audit.historyDigest = events.digest;
      } catch { audit.historyState = 'UNAVAILABLE'; }
      const code = stringOrNull(raw.code);
      if (code) try {
        const cash = await store.read({ kind: 'query', resource: 'settlementCashEvents', filters: [{ field: 'code', op: '==', value: code }], limit: 100 });
        const target = row.reconciliation!.cash;
        target.events = cash.docs.map((event) => ({ id: event.id, axis: stringOrNull(event.data.axis), kind: stringOrNull(event.data.kind), amount: numberOrNull(event.data.amount), day: stringOrNull(event.data.day), by: stringOrNull(event.data.by), createdAt: timestampOrNull(event.data.createdAt) }));
        target.eventsDigest = cash.digest; target.eventsState = cash.docs.length >= 100 ? 'LIMIT_REACHED' : 'READ';
      } catch { row.reconciliation!.cash.eventsState = 'UNAVAILABLE'; }
    }));
  }
  const summary = extended ? snapshotSummary(data, request) : undefined;
  if (summary?.scope === 'MONTH' && summary.completeness !== 'LIMIT_REACHED') {
    try {
      const rules = await store.read({ kind: 'doc', resource: 'settlementRules', id: 'f04-confirmed-receipt-sync' });
      const months = rules.docs[0]?.data.monthlyReceiptSummaries as Record<string, unknown> | undefined;
      const raw = months?.[summary.billingMonth!] as Record<string, unknown> | undefined;
      if (!raw || !Array.isArray(raw.entryIds)) {
        summary.storedSummaryComparison = { state: 'UNAVAILABLE', sourceDigest: rules.digest };
      } else {
        const sameIds = stableDigest([...summary.entryIds].sort()) === stableDigest([...raw.entryIds].sort());
        const compare = (component: 'supply' | 'vat' | 'total', fields: [string, string]): 'MATCH' | 'MISMATCH' | 'UNKNOWN' => {
          const values = (['recordedClaim', 'recordedPay'] as const).map((key, index) => {
            const value = component === 'supply' ? summary.totals[key] : summary.totals[key][component];
            return { missing: value.missingCount, actual: value.knownSubtotal, expected: numberOrNull(raw[fields[index]!]) };
          });
          if (values.some((value) => value.missing > 0 || value.expected === null)) return 'UNKNOWN';
          return values.every((value) => value.actual === value.expected) ? 'MATCH' : 'MISMATCH';
        };
        const components = { ids: sameIds ? 'MATCH' as const : 'MISMATCH' as const, supply: compare('supply', ['claimAmount', 'payAmount']), vat: compare('vat', ['claimVatAmount', 'payVatAmount']), total: compare('total', ['claimGrossAmount', 'payGrossAmount']) };
        const states = Object.values(components);
        summary.storedSummaryComparison = { state: states.includes('MISMATCH') ? 'MISMATCH' : states.includes('UNKNOWN') ? 'UNAVAILABLE' : 'MATCH', sourceDigest: rules.digest, components };
      }
    } catch { summary.storedSummaryComparison = { state: 'UNAVAILABLE', sourceDigest: null }; }
  }
  return {
    schema: extended ? 'freepass-data.settlement-ledger/v2' : SETTLEMENT_LEDGER_VIEW_CONTRACT,
    data,
    meta: {
      consumerId,
      authority: 'FREEPASS_DATA_SETTLEMENT',
      sourceProject: 'freepasserp5',
      sourceCollection: 'settlement_rows',
      observedAt,
      count: data.length,
      sourceDigest: source.digest,
      dataDigest: stableDigest(data),
      ...(summary ? { snapshotSummary: summary } : {}),
      ...(extended ? { sourceFreshness: { state: 'UNVERIFIED' as const, reason: 'SOURCE_NOT_VERIFIED_BY_THIS_READ' as const } } : {}),
    },
  };
}
