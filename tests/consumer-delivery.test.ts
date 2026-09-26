import { describe, expect, it } from 'vitest';
import {
  buildSheetDeliveryExpectation,
  validateSheetDeliveryReceipt,
  type SheetDeliveryReceipt
} from '../src/domain/consumer-delivery.js';
import {
  hashSheetPublicationData,
  hashSheetPublicationHandoff,
  type SheetPublicationHandoff
} from '../src/domain/sheet-publication-handoff.js';
import type { ApprovedReleaseEvidence } from '../src/domain/consumer-cutover.js';

const snapshot = {
  version: 1 as const,
  snapshotId: 'rel_20260925',
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

const release: ApprovedReleaseEvidence = {
  projectionId: 'sheet-publication-bridge',
  releaseId: 'rel_20260925',
  manifestId: 'manifest_20260925',
  inputDigest: 'input_digest',
  dataDigest: hashSheetPublicationData(snapshot),
  observedAt: '2026-09-25T07:00:00.000Z'
};

const unsignedHandoff: Omit<SheetPublicationHandoff, 'handoffHash'> = {
  contractVersion: 'freepass-sheet-handoff-v1',
  consumerId: 'google-sheets-f01',
  workbook: 'F01',
  generatedAt: '2026-09-25T07:02:00.000Z',
  releaseAuthority: 'LEGACY_VERIFIED_BRIDGE',
  approvedRelease: { ...release },
  manifest: {
    contractVersion: 'freepass-sheet-manifest-v1',
    manifestId: release.manifestId,
    releaseId: release.releaseId,
    projectionId: release.projectionId,
    releaseAuthority: 'LEGACY_VERIFIED_BRIDGE',
    sourceCaptureDigest: release.inputDigest,
    sourceReadTime: release.observedAt,
    productCount: snapshot.products.length,
    policyCount: snapshot.policies.length,
    partnerCount: snapshot.partners.length,
    dataDigest: release.dataDigest,
    generatedAt: '2026-09-25T07:01:30.000Z'
  },
  snapshot
};

function handoff(): SheetPublicationHandoff {
  const value = structuredClone(unsignedHandoff);
  return {
    ...value,
    handoffHash: hashSheetPublicationHandoff(value)
  };
}

function expectation() {
  return buildSheetDeliveryExpectation(handoff());
}

function receipt(overrides: Partial<SheetDeliveryReceipt> = {}): SheetDeliveryReceipt {
  const expected = expectation();
  return {
    contractVersion: 'freepass-sheet-delivery-v1',
    consumerId: 'google-sheets-f01',
    workbook: 'F01',
    spreadsheetId: 'sheet-f01',
    releaseAuthority: 'LEGACY_VERIFIED_BRIDGE',
    approvedRelease: { ...release },
    publicationHandoffHash: expected.publicationHandoffHash,
    renderedOutput: {
      transformContractId: 'f01-standard-v1',
      vehicleKeyCount: 692,
      dataDigest: 'sheet_output_digest'
    },
    publicationStartedAt: '2026-09-25T07:03:00.000Z',
    publicationCompletedAt: '2026-09-25T07:04:00.000Z',
    readback: {
      verified: true,
      vehicleKeyCount: 692,
      dataDigest: 'sheet_output_digest'
    },
    ...overrides
  };
}

describe('sheet delivery receipt', () => {
  it('builds expectations only from a valid release-bound handoff', () => {
    expect(expectation()).toMatchObject({
      consumerId: 'google-sheets-f01',
      workbook: 'F01',
      releaseAuthority: 'LEGACY_VERIFIED_BRIDGE',
      approvedRelease: release,
      handoffGeneratedAt: '2026-09-25T07:02:00.000Z'
    });

    const invalid = handoff();
    invalid.snapshot.snapshotId = 'rel_other';
    expect(() => buildSheetDeliveryExpectation(invalid))
      .toThrow('INVALID_SHEET_PUBLICATION_HANDOFF');
  });

  it('accepts a readback-verified receipt bound to the exact publication handoff', () => {
    expect(validateSheetDeliveryReceipt(receipt(), expectation())).toEqual({
      status: 'PASS',
      violations: []
    });
  });

  it('blocks a receipt copied from another handoff even when the approved release is identical', () => {
    const otherHash = 'a'.repeat(64);
    const result = validateSheetDeliveryReceipt(receipt({
      publicationHandoffHash: otherHash
    }), expectation());

    expect(result.status).toBe('HOLD');
    expect(result.violations).toContain('PUBLICATION_HANDOFF_HASH_MISMATCH');
  });

  it('blocks a bridge receipt that claims canonical authority', () => {
    const result = validateSheetDeliveryReceipt(receipt({
      releaseAuthority: 'CANONICAL_ACTIVE',
      approvedRelease: {
        ...release,
        projectionId: 'sheet-publication-bridge'
      }
    }), expectation());
    expect(result.violations).toEqual(expect.arrayContaining([
      'RELEASE_AUTHORITY_PROJECTION_MISMATCH',
      'RELEASE_AUTHORITY_MISMATCH'
    ]));
  });

  it('fails closed when F01/F86 identity is crossed', () => {
    expect(validateSheetDeliveryReceipt(receipt({
      consumerId: 'google-sheets-f86'
    }), expectation())).toMatchObject({
      status: 'HOLD',
      violations: expect.arrayContaining([
        'CONSUMER_WORKBOOK_MISMATCH',
        'PUBLICATION_TARGET_MISMATCH'
      ])
    });
  });

  it('fails closed when the writer used another release or digest', () => {
    const result = validateSheetDeliveryReceipt(receipt({
      approvedRelease: {
        ...release,
        releaseId: 'rel_other'
      },
      readback: {
        verified: true,
        vehicleKeyCount: 692,
        dataDigest: 'other_digest'
      }
    }), expectation());

    expect(result.status).toBe('HOLD');
    expect(result.violations).toEqual(expect.arrayContaining([
      'RELEASE_ID_MISMATCH',
      'READBACK_OUTPUT_DIGEST_MISMATCH'
    ]));
  });

  it('fails closed when a receipt reuses release identity with a different observation time', () => {
    const result = validateSheetDeliveryReceipt(receipt({
      approvedRelease: {
        ...release,
        observedAt: '2026-09-25T07:00:01.000Z'
      }
    }), expectation());

    expect(result.status).toBe('HOLD');
    expect(result.violations).toContain('OBSERVED_AT_MISMATCH');
  });

  it('blocks a rendered/readback vehicle-key count mismatch', () => {
    const result = validateSheetDeliveryReceipt(receipt({
      readback: {
        verified: true,
        vehicleKeyCount: 691,
        dataDigest: 'sheet_output_digest'
      }
    }), expectation());

    expect(result).toMatchObject({ status: 'HOLD' });
    expect(result.violations).toContain('READBACK_VEHICLE_KEY_COUNT_MISMATCH');
  });

  it('requires publication to start after the bound handoff exists', () => {
    const result = validateSheetDeliveryReceipt(receipt({
      publicationStartedAt: '2026-09-25T07:01:59.000Z',
      publicationCompletedAt: '2026-09-25T07:04:00.000Z'
    }), expectation());

    expect(result.status).toBe('HOLD');
    expect(result.violations).toContain('PUBLICATION_BEFORE_HANDOFF');
  });

  it('requires actual readback and a valid publication window', () => {
    const result = validateSheetDeliveryReceipt(receipt({
      publicationStartedAt: '2026-09-25T07:05:00.000Z',
      publicationCompletedAt: '2026-09-25T07:04:00.000Z',
      readback: {
        verified: false,
        vehicleKeyCount: 692,
        dataDigest: 'sheet_output_digest'
      }
    }), expectation());

    expect(result.status).toBe('HOLD');
    expect(result.violations).toEqual(expect.arrayContaining([
      'INVALID_PUBLICATION_WINDOW',
      'READBACK_NOT_VERIFIED'
    ]));
  });
});
