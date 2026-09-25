import { stableDigest } from '../shared/stable-digest.js';
import type { ApprovedReleaseEvidence } from './consumer-cutover.js';

export type SheetHandoffConsumerId = 'google-sheets-f01' | 'google-sheets-f86';
export type SheetHandoffWorkbook = 'F01' | 'F86';

export type SheetInventorySummary = {
  registered: number;
  unavailable: number;
  open: number;
  listableDrift: number;
  statusKindDrift: number;
  sourceIdentityViolations: number;
  deletedMarkerViolations: number;
  blankPlateViolations: number;
  invalidPlateViolations: number;
  duplicatePlateViolations: number;
  byStatus: Record<string, number>;
};

export type SheetPublicationHandoff = {
  contractVersion: 'freepass-sheet-handoff-v1';
  consumerId: SheetHandoffConsumerId;
  workbook: SheetHandoffWorkbook;
  generatedAt: string;
  releaseAuthority: 'LEGACY_VERIFIED_BRIDGE' | 'CANONICAL_ACTIVE';
  approvedRelease: ApprovedReleaseEvidence;
  snapshot: {
    version: 1;
    snapshotId: string;
    capturedAt: string;
    products: Record<string, unknown>[];
    policies: Record<string, unknown>[];
    partners: Record<string, unknown>[];
    inventory: SheetInventorySummary;
  };
  handoffHash: string;
};

const expectedConsumer = (workbook: SheetHandoffWorkbook): SheetHandoffConsumerId =>
  workbook === 'F01' ? 'google-sheets-f01' : 'google-sheets-f86';

const nonEmpty = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0;

export const hashSheetPublicationHandoff = (
  value: Omit<SheetPublicationHandoff, 'handoffHash'>
) => stableDigest(value);

export function validateSheetPublicationHandoff(
  handoff: SheetPublicationHandoff
): { status: 'PASS' | 'HOLD'; violations: string[] } {
  const violations: string[] = [];

  if (handoff.contractVersion !== 'freepass-sheet-handoff-v1') {
    violations.push('UNSUPPORTED_HANDOFF_CONTRACT');
  }
  if (handoff.consumerId !== expectedConsumer(handoff.workbook)) {
    violations.push('CONSUMER_WORKBOOK_MISMATCH');
  }
  if (!Number.isFinite(Date.parse(handoff.generatedAt))) {
    violations.push('INVALID_GENERATED_AT');
  }

  const releaseFields = [
    'projectionId',
    'releaseId',
    'manifestId',
    'inputDigest',
    'dataDigest',
    'observedAt'
  ] as const;
  if (
    releaseFields.some((key) => !nonEmpty(handoff.approvedRelease?.[key])) ||
    !Number.isFinite(Date.parse(handoff.approvedRelease?.observedAt))
  ) {
    violations.push('INCOMPLETE_APPROVED_RELEASE');
  }

  if (
    handoff.snapshot.version !== 1 ||
    !nonEmpty(handoff.snapshot.snapshotId) ||
    !Number.isFinite(Date.parse(handoff.snapshot.capturedAt)) ||
    !Array.isArray(handoff.snapshot.products) ||
    !Array.isArray(handoff.snapshot.policies) ||
    !Array.isArray(handoff.snapshot.partners)
  ) {
    violations.push('INCOMPLETE_SNAPSHOT');
  }

  const inventory = handoff.snapshot.inventory;
  const counters = [
    inventory.registered,
    inventory.unavailable,
    inventory.open,
    inventory.listableDrift,
    inventory.statusKindDrift,
    inventory.sourceIdentityViolations,
    inventory.deletedMarkerViolations,
    inventory.blankPlateViolations,
    inventory.invalidPlateViolations,
    inventory.duplicatePlateViolations
  ];
  if (counters.some((value) => !Number.isInteger(value) || value < 0)) {
    violations.push('INVALID_INVENTORY_COUNTER');
  } else {
    if (inventory.registered !== handoff.snapshot.products.length) {
      violations.push('REGISTERED_PRODUCT_COUNT_MISMATCH');
    }
    if (inventory.open + inventory.unavailable !== inventory.registered) {
      violations.push('INVENTORY_TOTAL_MISMATCH');
    }
    const byStatusTotal = Object.values(inventory.byStatus)
      .reduce((sum, value) => sum + value, 0);
    if (
      Object.values(inventory.byStatus)
        .some((value) => !Number.isInteger(value) || value < 0) ||
      byStatusTotal !== inventory.registered
    ) {
      violations.push('INVENTORY_STATUS_TOTAL_MISMATCH');
    }
  }

  const { handoffHash, ...unsigned } = handoff;
  if (!/^[a-f0-9]{64}$/.test(handoffHash) ||
      hashSheetPublicationHandoff(unsigned) !== handoffHash) {
    violations.push('HANDOFF_HASH_MISMATCH');
  }

  return {
    status: violations.length ? 'HOLD' : 'PASS',
    violations
  };
}
