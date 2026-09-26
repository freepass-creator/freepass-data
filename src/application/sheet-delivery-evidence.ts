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

function receiptPayloadDigest(
  expectation: StoredSheetDeliveryEvidence['expectation'],
  receipt: SheetDeliveryReceipt
) {
  return stableDigest({ expectation, receipt });
}

function storedEvidenceDigest(
  evidence: Omit<StoredSheetDeliveryEvidence, 'evidenceDigest'>
) {
  return stableDigest(evidence);
}

export function sheetDeliveryReceiptId(
  expectation: StoredSheetDeliveryEvidence['expectation'],
  receipt: SheetDeliveryReceipt
) {
  return `sheet_receipt_${receiptPayloadDigest(expectation, receipt)}`;
}

export function sheetDeliveryEvidenceDigest(
  evidence: Omit<StoredSheetDeliveryEvidence, 'evidenceDigest'>
) {
  return storedEvidenceDigest(evidence);
}

export function assertStoredSheetDeliveryEvidence(
  evidence: StoredSheetDeliveryEvidence
): void {
  if (evidence.contractVersion !== 'freepass-sheet-delivery-evidence-v1') {
    throw new Error('UNSUPPORTED_SHEET_DELIVERY_EVIDENCE_CONTRACT');
  }

  const recordedAt = Date.parse(evidence.recordedAt);
  const completedAt = Date.parse(evidence.receipt.publicationCompletedAt);
  if (!Number.isFinite(recordedAt)) {
    throw new Error('INVALID_SHEET_DELIVERY_EVIDENCE_RECORDED_AT');
  }
  if (!Number.isFinite(completedAt) || recordedAt < completedAt) {
    throw new Error('SHEET_DELIVERY_EVIDENCE_RECORDED_BEFORE_READBACK');
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

  const { evidenceDigest, ...unsigned } = evidence;
  if (
    !/^[a-f0-9]{64}$/.test(evidenceDigest) ||
    sheetDeliveryEvidenceDigest(unsigned) !== evidenceDigest
  ) {
    throw new Error('SHEET_DELIVERY_EVIDENCE_DIGEST_MISMATCH');
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
  const recordedAtMs = Date.parse(recordedAt);
  const completedAtMs = Date.parse(input.receipt.publicationCompletedAt);
  if (!Number.isFinite(recordedAtMs)) {
    throw new Error('INVALID_SHEET_DELIVERY_EVIDENCE_RECORDED_AT');
  }
  if (!Number.isFinite(completedAtMs) || recordedAtMs < completedAtMs) {
    throw new Error('SHEET_DELIVERY_EVIDENCE_RECORDED_BEFORE_READBACK');
  }

  const receiptId = sheetDeliveryReceiptId(expectation, input.receipt);
  const unsigned: Omit<StoredSheetDeliveryEvidence, 'evidenceDigest'> = {
    contractVersion: 'freepass-sheet-delivery-evidence-v1',
    receiptId,
    consumerId: input.receipt.consumerId,
    workbook: input.receipt.workbook,
    recordedAt,
    expectation: structuredClone(expectation),
    receipt: structuredClone(input.receipt)
  };
  const evidence: StoredSheetDeliveryEvidence = {
    ...unsigned,
    evidenceDigest: sheetDeliveryEvidenceDigest(unsigned)
  };

  const existing = await store.getSheetDeliveryEvidence(receiptId);
  if (existing) {
    assertStoredSheetDeliveryEvidence(existing);
    if (
      receiptPayloadDigest(existing.expectation, existing.receipt) !==
      receiptPayloadDigest(evidence.expectation, evidence.receipt)
    ) {
      throw new Error('SHEET_DELIVERY_EVIDENCE_ID_COLLISION');
    }
    return existing;
  }

  await store.putSheetDeliveryEvidence(evidence);

  const persisted = await store.getSheetDeliveryEvidence(receiptId);
  if (!persisted) {
    throw new Error('SHEET_DELIVERY_EVIDENCE_READBACK_MISSING');
  }
  assertStoredSheetDeliveryEvidence(persisted);
  if (persisted.evidenceDigest !== evidence.evidenceDigest) {
    throw new Error('SHEET_DELIVERY_EVIDENCE_READBACK_MISMATCH');
  }

  return structuredClone(persisted);
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
      Date.parse(a.receipt.publicationCompletedAt) -
        Date.parse(b.receipt.publicationCompletedAt) ||
      Date.parse(a.recordedAt) - Date.parse(b.recordedAt) ||
      a.receiptId.localeCompare(b.receiptId)
    )
    .at(-1) ?? null;
}

export type SheetEvidenceFreshnessPolicy = {
  assessedAt: string;
  maxAgeMs: number;
  maxFutureSkewMs?: number;
};

export type SheetEvidenceFreshnessDecision = {
  status: 'PASS' | 'HOLD';
  readbackAgeMs: number | null;
  releaseObservationAgeMs: number | null;
  blockers: string[];
};

function assertFreshnessPolicy(policy: SheetEvidenceFreshnessPolicy) {
  if (
    !Number.isFinite(Date.parse(policy.assessedAt)) ||
    !Number.isSafeInteger(policy.maxAgeMs) ||
    policy.maxAgeMs <= 0 ||
    (policy.maxFutureSkewMs !== undefined &&
      (!Number.isSafeInteger(policy.maxFutureSkewMs) ||
        policy.maxFutureSkewMs < 0))
  ) {
    throw new Error('INVALID_SHEET_EVIDENCE_FRESHNESS_POLICY');
  }
}

export function assessSheetEvidenceFreshness(
  record: StoredSheetDeliveryEvidence,
  policy: SheetEvidenceFreshnessPolicy
): SheetEvidenceFreshnessDecision {
  assertStoredSheetDeliveryEvidence(record);
  assertFreshnessPolicy(policy);

  const assessedAt = Date.parse(policy.assessedAt);
  const completedAt = Date.parse(record.receipt.publicationCompletedAt);
  const observedAt = Date.parse(record.receipt.approvedRelease.observedAt);
  const recordedAt = Date.parse(record.recordedAt);
  const skew = policy.maxFutureSkewMs ?? 0;
  const blockers: string[] = [];

  if (completedAt > assessedAt + skew) {
    blockers.push('SHEET_READBACK_FROM_FUTURE');
  }
  if (observedAt > assessedAt + skew) {
    blockers.push('SHEET_RELEASE_OBSERVATION_FROM_FUTURE');
  }
  if (recordedAt > assessedAt + skew) {
    blockers.push('SHEET_EVIDENCE_RECORD_FROM_FUTURE');
  }

  const readbackAgeMs = Math.max(0, assessedAt - completedAt);
  const releaseObservationAgeMs = Math.max(0, assessedAt - observedAt);

  if (readbackAgeMs > policy.maxAgeMs) {
    blockers.push('SHEET_READBACK_STALE');
  }
  if (releaseObservationAgeMs > policy.maxAgeMs) {
    blockers.push('SHEET_APPROVED_RELEASE_STALE');
  }

  return {
    status: blockers.length ? 'HOLD' : 'PASS',
    readbackAgeMs,
    releaseObservationAgeMs,
    blockers
  };
}

export type SheetConsumerCutoverAssessment = {
  record: StoredSheetDeliveryEvidence | null;
  delivery: SheetCutoverEvidenceDecision | null;
  freshness: SheetEvidenceFreshnessDecision | null;
  registration: ConsumerSwitchRegistration;
  decision: ConsumerSwitchDecision;
};

export async function assessLatestSheetConsumerCutover(
  store: SheetDeliveryEvidenceStore,
  registration: ConsumerSwitchRegistration,
  target: ConsumerCutoverStage,
  freshnessPolicy: SheetEvidenceFreshnessPolicy
): Promise<SheetConsumerCutoverAssessment> {
  assertFreshnessPolicy(freshnessPolicy);

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
  const freshness = record
    ? assessSheetEvidenceFreshness(record, freshnessPolicy)
    : null;
  const fresh = freshness?.status === 'PASS';

  const effective: ConsumerSwitchRegistration = {
    ...registration,
    evidence: {
      ...registration.evidence,
      freepassReadVerified:
        Boolean(delivery?.evidence.freepassReadVerified && fresh),
      productionReadbackVerified:
        Boolean(delivery?.evidence.productionReadbackVerified && fresh),
      approvedRelease:
        delivery?.evidence.freepassReadVerified && fresh
          ? delivery.evidence.approvedRelease
          : null
    }
  };

  const decision = evaluateConsumerCutover(effective, target);
  if (freshness?.status === 'HOLD') {
    decision.allowed = false;
    decision.blockers.push(...freshness.blockers);
  }

  return {
    record: record ? structuredClone(record) : null,
    delivery: delivery ? structuredClone(delivery) : null,
    freshness: freshness ? structuredClone(freshness) : null,
    registration: effective,
    decision
  };
}
