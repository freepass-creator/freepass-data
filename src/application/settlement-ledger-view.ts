import type { AdminWorkflowStore } from '../ports/admin-workflow.js';
import { stableDigest } from '../shared/stable-digest.js';
import {
  SETTLEMENT_LEDGER_VIEW_CONTRACT,
  assertSettlementLedgerReadRequest,
  type SettlementLedgerReadRequest,
  type SettlementLedgerRecord,
  type SettlementLedgerValue,
  type SettlementLedgerView,
} from '../domain/settlement-ledger-view.js';

const stringOrNull = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;
const numberOrNull = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const booleanOrNull = (value: unknown) =>
  typeof value === 'boolean' ? value : null;
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
      receivedAt: stringOrNull(data.receivedAt),
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
      deliveredAt: stringOrNull(data.deliveredAt),
      cancelled: booleanOrNull(data.cancelled),
      billed: booleanOrNull(data.billed),
      billingMonth: stringOrNull(data.billMonth),
      billedAt: stringOrNull(data.billedAt),
      invoiceIssued: booleanOrNull(data.invoiceIssued),
      invoiceAt: stringOrNull(data.invoiceAt),
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
      calculationBasis: stringOrNull(data.calculationBasis),
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
  const data = source.docs.map((document) => projectSettlementLedgerRecord(document.id, document.data));
  return {
    schema: SETTLEMENT_LEDGER_VIEW_CONTRACT,
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
    },
  };
}
