import {
  buildSheetDeliveryExpectation,
  deriveSheetCutoverEvidence,
  validateSheetDeliveryReceipt,
  type SheetCutoverEvidenceDecision,
  type SheetDeliveryReceipt,
  type StoredSheetDeliveryEvidence
} from '../domain/consumer-delivery.js';
import {
  evaluateConsumerCutover,
  type ConsumerCutoverStage,
  type ConsumerSwitchDecision,
  type ConsumerSwitchRegistration
} from '../domain/consumer-cutover.js';
import type { SheetDeliveryEvidenceStore } from '../ports/catalog-store.js';
import { stableDigest } from '../shared/stable-digest.js';
import type { SheetPublicationHandoff } from '../domain/sheet-publication-handoff.js';

function evidencePayloadDigest(
  expectation: StoredSheetDeliveryEvidence['expectation'],
  receipt: SheetDeliveryReceipt
) {
  return stableDigest({ expectation, receipt });
}

export function sheetDeliveryReceiptId(
  expectation: StoredSheetDeliveryEvidence['expectation'],
  receipt: SheetDeliveryReceipt
) {
  return `sheet_receipt_${evidencePayloadDigest(expectation, receipt)}`;
}

export function assertStoredSheetDeliveryEvidence(
  evidence: StoredSheetDeliveryEvidence
): void {
  if (evidence.contractVersion !== 'freepass-sheet-delivery-evidence-v1') {
    throw new Error('UNSUPPORTED_SHEET_DELIVERY_EVIDENCE_CONTRACT');
  }
  if (!Number.isFinite(Date.parse(evidence.recordedAt))) {
    throw new Error('INVALID_SHEET_DELIVERY_EVIDENCE_RECORDED_AT');
  }
  if (
    evidence.consumerId !== evidence.receipt.consumerId ||
    evidence.consumerId !== evidence.expectation.consumerId ||
    evidence.workbook !== evidence.receipt.workbook ||
    evidence.workbook !== evidence.expectation.workbook
  ) {
    throw new Error('SHEET_DELIVERY_EVIDENCE_TARGET_MISMATCH');
  }
  const expectedReceiptId = sheetDeliveryReceiptId(
    evidence.expectation,
    evidence.receipt
  );
  if (evidence.receiptId !== expectedReceiptId) {
    throw new Error('SHEET_DELIVERY_EVIDENCE_ID_MISMATCH');
  }
  const decision = validateSheetDeliveryReceipt(
    evidence.receipt,
    evidence.expectation
  );
  if (decision.status !== 'PASS') {
    throw new Error(
      `SHEET_DELIVERY_EVIDENCE_INVALID:${decision.violations.join(',')}`
    );
  }
}

export async function recordSheetDeliveryEvidence(
  store: SheetDeliveryEvidenceStore,
  input: {
    handoff: SheetPublicationHandoff;
    receipt: SheetDeliveryReceipt;
    recordedAt?: string;
  }
): Promise<StoredSheetDeliveryEvidence> {
  const expectation = buildSheetDeliveryExpectation(input.handoff);
  const decision = validateSheetDeliveryReceipt(input.receipt, expectation);
  if (decision.status !== 'PASS') {
    throw new Error(
      `SHEET_DELIVERY_RECEIPT_INVALID:${decision.violations.join(',')}`
    );
  }

  const recordedAt = input.recordedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(recordedAt))) {
    throw new Error('INVALID_SHEET_DELIVERY_EVIDENCE_RECORDED_AT');
  }

  const receiptId = sheetDeliveryReceiptId(expectation, input.receipt);
  const evidence: StoredSheetDeliveryEvidence = {
    contractVersion: 'freepass-sheet-delivery-evidence-v1',
    receiptId,
    consumerId: input.receipt.consumerId,
    workbook: input.receipt.workbook,
    recordedAt,
    expectation: structuredClone(expectation),
    receipt: structuredClone(input.receipt)
  };

  const existing = await store.getSheetDeliveryEvidence(receiptId);
  if (existing) {
    assertStoredSheetDeliveryEvidence(existing);
    if (
      evidencePayloadDigest(existing.expectation, existing.receipt) !==
      evidencePayloadDigest(evidence.expectation, evidence.receipt)
    ) {
      throw new Error('SHEET_DELIVERY_EVIDENCE_ID_COLLISION');
    }
    return existing;
  }

  await store.putSheetDeliveryEvidence(evidence);
  return structuredClone(evidence);
}

export async function readSheetDeliveryEvidence(
  store: SheetDeliveryEvidenceStore,
  receiptId: string
): Promise<StoredSheetDeliveryEvidence | null> {
  const evidence = await store.getSheetDeliveryEvidence(receiptId);
  if (!evidence) return null;
  assertStoredSheetDeliveryEvidence(evidence);
  return structuredClone(evidence);
}

function latestEvidence(
  values: StoredSheetDeliveryEvidence[]
): StoredSheetDeliveryEvidence | null {
  if (!values.length) return null;
  return [...values]
    .sort((a, b) =>
      a.receipt.publicationCompletedAt.localeCompare(
        b.receipt.publicationCompletedAt
      ) ||
      a.recordedAt.localeCompare(b.recordedAt) ||
      a.receiptId.localeCompare(b.receiptId)
    )
    .at(-1) ?? null;
}

export type SheetConsumerCutoverAssessment = {
  record: StoredSheetDeliveryEvidence | null;
  delivery: SheetCutoverEvidenceDecision | null;
  registration: ConsumerSwitchRegistration;
  decision: ConsumerSwitchDecision;
};

export async function assessLatestSheetConsumerCutover(
  store: SheetDeliveryEvidenceStore,
  registration: ConsumerSwitchRegistration,
  target: ConsumerCutoverStage
): Promise<SheetConsumerCutoverAssessment> {
  if (
    registration.consumerId !== 'google-sheets-f01' &&
    registration.consumerId !== 'google-sheets-f86'
  ) {
    throw new Error('SHEET_CUTOVER_REQUIRES_SHEET_CONSUMER');
  }

  const records = await store.listSheetDeliveryEvidence(
    registration.consumerId
  );
  for (const record of records) {
    assertStoredSheetDeliveryEvidence(record);
    if (record.consumerId !== registration.consumerId) {
      throw new Error('SHEET_DELIVERY_EVIDENCE_STORE_SCOPE_MISMATCH');
    }
  }

  const record = latestEvidence(records);
  const delivery = record
    ? deriveSheetCutoverEvidence(record.receipt, record.expectation)
    : null;

  const effective: ConsumerSwitchRegistration = {
    ...registration,
    evidence: {
      ...registration.evidence,
      freepassReadVerified:
        delivery?.evidence.freepassReadVerified ?? false,
      productionReadbackVerified:
        delivery?.evidence.productionReadbackVerified ?? false,
      approvedRelease:
        delivery?.evidence.approvedRelease ?? null
    }
  };

  return {
    record: record ? structuredClone(record) : null,
    delivery: delivery ? structuredClone(delivery) : null,
    registration: effective,
    decision: evaluateConsumerCutover(effective, target)
  };
}
