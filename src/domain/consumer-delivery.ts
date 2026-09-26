import type { ApprovedReleaseEvidence, ConsumerCutoverEvidence } from './consumer-cutover.js';
import {
  validateSheetPublicationHandoff,
  type SheetPublicationHandoff
} from './sheet-publication-handoff.js';

export type SheetConsumerId = 'google-sheets-f01' | 'google-sheets-f86';
export type SheetWorkbook = 'F01' | 'F86';

export type SheetRenderedOutputEvidence = {
  transformContractId: string;
  vehicleKeyCount: number;
  dataDigest: string;
};

export type SheetDeliveryReceipt = {
  contractVersion: 'freepass-sheet-delivery-v1';
  consumerId: SheetConsumerId;
  workbook: SheetWorkbook;
  spreadsheetId: string;
  releaseAuthority: 'LEGACY_VERIFIED_BRIDGE' | 'CANONICAL_ACTIVE';
  approvedRelease: ApprovedReleaseEvidence;
  publicationHandoffHash: string;
  renderedOutput: SheetRenderedOutputEvidence;
  publicationStartedAt: string;
  publicationCompletedAt: string;
  readback: {
    verified: boolean;
    vehicleKeyCount: number;
    dataDigest: string;
  };
};

export type SheetDeliveryExpectation = {
  consumerId: SheetConsumerId;
  workbook: SheetWorkbook;
  releaseAuthority: 'LEGACY_VERIFIED_BRIDGE' | 'CANONICAL_ACTIVE';
  approvedRelease: ApprovedReleaseEvidence;
  publicationHandoffHash: string;
  handoffGeneratedAt: string;
};

export type SheetDeliveryDecision = {
  status: 'PASS' | 'HOLD';
  violations: string[];
};

export type SheetCutoverEvidenceDecision = {
  status: 'PASS' | 'HOLD';
  authority: SheetDeliveryReceipt['releaseAuthority'];
  evidence: Pick<
    ConsumerCutoverEvidence,
    'freepassReadVerified' | 'productionReadbackVerified' | 'approvedRelease'
  >;
  blockers: string[];
};

export type StoredSheetDeliveryEvidence = {
  contractVersion: 'freepass-sheet-delivery-evidence-v1';
  receiptId: string;
  evidenceDigest: string;
  consumerId: SheetConsumerId;
  workbook: SheetWorkbook;
  recordedAt: string;
  expectation: SheetDeliveryExpectation;
  receipt: SheetDeliveryReceipt;
};

const expectedConsumer = (workbook: SheetWorkbook): SheetConsumerId =>
  workbook === 'F01' ? 'google-sheets-f01' : 'google-sheets-f86';

const nonEmpty = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0;

const validCount = (value: unknown) =>
  Number.isInteger(value) && Number(value) >= 0;

const validDigest = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function buildSheetDeliveryExpectation(
  handoff: SheetPublicationHandoff
): SheetDeliveryExpectation {
  const decision = validateSheetPublicationHandoff(handoff);
  if (decision.status !== 'PASS') {
    throw new Error(
      `INVALID_SHEET_PUBLICATION_HANDOFF:${decision.violations.join(',')}`
    );
  }
  return {
    consumerId: handoff.consumerId,
    workbook: handoff.workbook,
    releaseAuthority: handoff.releaseAuthority,
    approvedRelease: structuredClone(handoff.approvedRelease),
    publicationHandoffHash: handoff.handoffHash,
    handoffGeneratedAt: handoff.generatedAt
  };
}

export function validateSheetDeliveryReceipt(
  receipt: SheetDeliveryReceipt,
  expected: SheetDeliveryExpectation
): SheetDeliveryDecision {
  const violations: string[] = [];

  if (receipt.contractVersion !== 'freepass-sheet-delivery-v1') {
    violations.push('UNSUPPORTED_RECEIPT_CONTRACT');
  }
  if (receipt.consumerId !== expectedConsumer(receipt.workbook)) {
    violations.push('CONSUMER_WORKBOOK_MISMATCH');
  }
  if (
    receipt.consumerId !== expected.consumerId ||
    receipt.workbook !== expected.workbook
  ) {
    violations.push('PUBLICATION_TARGET_MISMATCH');
  }
  if (!nonEmpty(receipt.spreadsheetId)) {
    violations.push('MISSING_SPREADSHEET_ID');
  }
  const authorityValid =
    receipt.releaseAuthority === 'LEGACY_VERIFIED_BRIDGE' ||
    receipt.releaseAuthority === 'CANONICAL_ACTIVE';
  if (!authorityValid) {
    violations.push('INVALID_RELEASE_AUTHORITY');
  } else {
    const isBridgeProjection = receipt.approvedRelease?.projectionId === 'sheet-publication-bridge';
    if (
      (receipt.releaseAuthority === 'LEGACY_VERIFIED_BRIDGE' && !isBridgeProjection) ||
      (receipt.releaseAuthority === 'CANONICAL_ACTIVE' && isBridgeProjection)
    ) {
      violations.push('RELEASE_AUTHORITY_PROJECTION_MISMATCH');
    }
    if (receipt.releaseAuthority !== expected.releaseAuthority) {
      violations.push('RELEASE_AUTHORITY_MISMATCH');
    }
  }

  if (
    !validDigest(receipt.publicationHandoffHash) ||
    receipt.publicationHandoffHash !== expected.publicationHandoffHash
  ) {
    violations.push('PUBLICATION_HANDOFF_HASH_MISMATCH');
  }

  const releaseFields = {
    projectionId: 'PROJECTION_ID_MISMATCH',
    releaseId: 'RELEASE_ID_MISMATCH',
    manifestId: 'MANIFEST_ID_MISMATCH',
    inputDigest: 'INPUT_DIGEST_MISMATCH',
    dataDigest: 'DATA_DIGEST_MISMATCH',
    observedAt: 'OBSERVED_AT_MISMATCH'
  } as const;

  for (const [key, code] of Object.entries(releaseFields) as Array<
    [keyof typeof releaseFields, (typeof releaseFields)[keyof typeof releaseFields]]
  >) {
    if (receipt.approvedRelease[key] !== expected.approvedRelease[key]) {
      violations.push(code);
    }
  }

  if (
    !Number.isFinite(Date.parse(receipt.approvedRelease.observedAt)) ||
    !Number.isFinite(Date.parse(expected.handoffGeneratedAt)) ||
    !Number.isFinite(Date.parse(receipt.publicationStartedAt)) ||
    !Number.isFinite(Date.parse(receipt.publicationCompletedAt))
  ) {
    violations.push('INVALID_TIMESTAMP');
  } else {
    if (
      Date.parse(receipt.publicationStartedAt) <
      Date.parse(expected.handoffGeneratedAt)
    ) {
      violations.push('PUBLICATION_BEFORE_HANDOFF');
    }
    if (
      Date.parse(receipt.publicationCompletedAt) <
      Date.parse(receipt.publicationStartedAt)
    ) {
      violations.push('INVALID_PUBLICATION_WINDOW');
    }
  }

  if (!nonEmpty(receipt.renderedOutput.transformContractId)) violations.push('MISSING_TRANSFORM_CONTRACT_ID');
  if (!validCount(receipt.renderedOutput.vehicleKeyCount)) violations.push('INVALID_RENDERED_VEHICLE_KEY_COUNT');
  if (!nonEmpty(receipt.renderedOutput.dataDigest)) violations.push('MISSING_RENDERED_OUTPUT_DIGEST');
  if (!receipt.readback.verified) violations.push('READBACK_NOT_VERIFIED');
  if (!validCount(receipt.readback.vehicleKeyCount)) violations.push('INVALID_READBACK_VEHICLE_KEY_COUNT');
  if (!nonEmpty(receipt.readback.dataDigest)) violations.push('MISSING_READBACK_OUTPUT_DIGEST');
  if (validCount(receipt.renderedOutput.vehicleKeyCount) && validCount(receipt.readback.vehicleKeyCount) && receipt.readback.vehicleKeyCount !== receipt.renderedOutput.vehicleKeyCount) violations.push('READBACK_VEHICLE_KEY_COUNT_MISMATCH');
  if (nonEmpty(receipt.renderedOutput.dataDigest) && nonEmpty(receipt.readback.dataDigest) && receipt.readback.dataDigest !== receipt.renderedOutput.dataDigest) violations.push('READBACK_OUTPUT_DIGEST_MISMATCH');

  return {
    status: violations.length ? 'HOLD' : 'PASS',
    violations
  };
}

export function deriveSheetCutoverEvidence(
  receipt: SheetDeliveryReceipt,
  expected: SheetDeliveryExpectation
): SheetCutoverEvidenceDecision {
  const delivery = validateSheetDeliveryReceipt(receipt, expected);
  const blockers = [...delivery.violations];

  if (
    delivery.status === 'PASS' &&
    receipt.releaseAuthority === 'LEGACY_VERIFIED_BRIDGE'
  ) {
    blockers.push('LEGACY_BRIDGE_NOT_CANONICAL_READBACK');
  }

  const canonicalReadback =
    delivery.status === 'PASS' &&
    receipt.releaseAuthority === 'CANONICAL_ACTIVE';

  return {
    status: blockers.length ? 'HOLD' : 'PASS',
    authority: receipt.releaseAuthority,
    evidence: {
      freepassReadVerified: delivery.status === 'PASS',
      productionReadbackVerified: canonicalReadback,
      approvedRelease: delivery.status === 'PASS'
        ? structuredClone(receipt.approvedRelease)
        : null
    },
    blockers
  };
}
