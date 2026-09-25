import type { ApprovedReleaseEvidence } from './consumer-cutover.js';

export type SheetConsumerId = 'google-sheets-f01' | 'google-sheets-f86';
export type SheetWorkbook = 'F01' | 'F86';

export type SheetDeliveryReceipt = {
  contractVersion: 'freepass-sheet-delivery-v1';
  consumerId: SheetConsumerId;
  workbook: SheetWorkbook;
  spreadsheetId: string;
  approvedRelease: ApprovedReleaseEvidence;
  publicationStartedAt: string;
  publicationCompletedAt: string;
  readback: {
    verified: boolean;
    vehicleKeyCount: number;
    dataDigest: string;
  };
};

export type SheetDeliveryDecision = {
  status: 'PASS' | 'HOLD';
  violations: string[];
};

const expectedConsumer = (workbook: SheetWorkbook): SheetConsumerId =>
  workbook === 'F01' ? 'google-sheets-f01' : 'google-sheets-f86';

const nonEmpty = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0;

export function validateSheetDeliveryReceipt(
  receipt: SheetDeliveryReceipt,
  expectedRelease: ApprovedReleaseEvidence
): SheetDeliveryDecision {
  const violations: string[] = [];

  if (receipt.contractVersion !== 'freepass-sheet-delivery-v1') {
    violations.push('UNSUPPORTED_RECEIPT_CONTRACT');
  }
  if (receipt.consumerId !== expectedConsumer(receipt.workbook)) {
    violations.push('CONSUMER_WORKBOOK_MISMATCH');
  }
  if (!nonEmpty(receipt.spreadsheetId)) {
    violations.push('MISSING_SPREADSHEET_ID');
  }

  const releaseFields = {
    projectionId: 'PROJECTION_ID_MISMATCH',
    releaseId: 'RELEASE_ID_MISMATCH',
    manifestId: 'MANIFEST_ID_MISMATCH',
    inputDigest: 'INPUT_DIGEST_MISMATCH',
    dataDigest: 'DATA_DIGEST_MISMATCH'
  } as const;

  for (const [key, code] of Object.entries(releaseFields) as Array<
    [keyof typeof releaseFields, (typeof releaseFields)[keyof typeof releaseFields]]
  >) {
    if (receipt.approvedRelease[key] !== expectedRelease[key]) {
      violations.push(code);
    }
  }

  if (
    !Number.isFinite(Date.parse(receipt.approvedRelease.observedAt)) ||
    !Number.isFinite(Date.parse(receipt.publicationStartedAt)) ||
    !Number.isFinite(Date.parse(receipt.publicationCompletedAt))
  ) {
    violations.push('INVALID_TIMESTAMP');
  } else if (
    Date.parse(receipt.publicationCompletedAt) <
    Date.parse(receipt.publicationStartedAt)
  ) {
    violations.push('INVALID_PUBLICATION_WINDOW');
  }

  if (!receipt.readback.verified) {
    violations.push('READBACK_NOT_VERIFIED');
  }
  if (
    !Number.isInteger(receipt.readback.vehicleKeyCount) ||
    receipt.readback.vehicleKeyCount < 0
  ) {
    violations.push('INVALID_VEHICLE_KEY_COUNT');
  }
  if (receipt.readback.dataDigest !== expectedRelease.dataDigest) {
    violations.push('READBACK_DATA_DIGEST_MISMATCH');
  }

  return {
    status: violations.length ? 'HOLD' : 'PASS',
    violations
  };
}
