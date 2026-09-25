import { describe, expect, it } from 'vitest';
import {
  hashSheetPublicationHandoff,
  hashSheetPublicationData,
  validateSheetPublicationHandoff,
  type SheetPublicationHandoff
} from '../src/domain/sheet-publication-handoff.js';

const snapshot = {
  version: 1 as const,
  snapshotId: 'snapshot_test',
  capturedAt: '2026-09-25T07:01:00.000Z',
  products: [{ _key: 'TEST-1', car_number: '12가3456' }],
  policies: [],
  partners: [],
  inventory: {
    registered: 1,
    unavailable: 0,
    open: 1,
    listableDrift: 0,
    statusKindDrift: 0,
    sourceIdentityViolations: 0,
    deletedMarkerViolations: 0,
    blankPlateViolations: 0,
    invalidPlateViolations: 0,
    duplicatePlateViolations: 0,
    depositRuleViolations: 0,
    byStatus: { 즉시출고: 1 }
  }
};

const snapshotDataDigest = hashSheetPublicationData(snapshot);

const unsigned: Omit<SheetPublicationHandoff, 'handoffHash'> = {
  contractVersion: 'freepass-sheet-handoff-v1',
  consumerId: 'google-sheets-f01',
  workbook: 'F01',
  generatedAt: '2026-09-25T07:02:00.000Z',
  releaseAuthority: 'LEGACY_VERIFIED_BRIDGE',
  approvedRelease: {
    projectionId: 'sheet-publication-bridge',
    releaseId: 'rel_test',
    manifestId: 'manifest_test',
    inputDigest: 'input_test',
    dataDigest: snapshotDataDigest,
    observedAt: '2026-09-25T07:00:00.000Z'
  },
  manifest: {
    contractVersion: 'freepass-sheet-manifest-v1',
    manifestId: 'manifest_test',
    releaseId: 'rel_test',
    projectionId: 'sheet-publication-bridge',
    releaseAuthority: 'LEGACY_VERIFIED_BRIDGE',
    sourceCaptureDigest: 'input_test',
    sourceReadTime: '2026-09-25T07:00:00.000Z',
    productCount: snapshot.products.length,
    policyCount: snapshot.policies.length,
    partnerCount: snapshot.partners.length,
    dataDigest: snapshotDataDigest,
    generatedAt: '2026-09-25T07:01:00.000Z'
  },
  snapshot
};

const valid = (): SheetPublicationHandoff => ({
  ...structuredClone(unsigned),
  handoffHash: hashSheetPublicationHandoff(unsigned)
});

describe('sheet publication handoff', () => {
  it('accepts one release-bound writer-ready handoff', () => {
    expect(validateSheetPublicationHandoff(valid())).toEqual({
      status: 'PASS',
      violations: []
    });
  });

  it('fails closed on crossed F01/F86 identity', () => {
    const value = valid();
    value.consumerId = 'google-sheets-f86';
    value.handoffHash = hashSheetPublicationHandoff(
      (({ handoffHash: _hash, ...rest }) => rest)(value)
    );
    expect(validateSheetPublicationHandoff(value)).toMatchObject({
      status: 'HOLD',
      violations: ['CONSUMER_WORKBOOK_MISMATCH']
    });
  });

  it('fails closed on inventory and handoff tamper', () => {
    const value = valid();
    value.snapshot.inventory.registered = 2;
    expect(validateSheetPublicationHandoff(value)).toMatchObject({
      status: 'HOLD'
    });
    expect(validateSheetPublicationHandoff(value).violations).toEqual(
      expect.arrayContaining([
        'REGISTERED_PRODUCT_COUNT_MISMATCH',
        'INVENTORY_TOTAL_MISMATCH',
        'INVENTORY_STATUS_TOTAL_MISMATCH',
        'HANDOFF_HASH_MISMATCH'
      ])
    );
  });
});
