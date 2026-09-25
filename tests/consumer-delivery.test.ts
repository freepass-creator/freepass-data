import { describe, expect, it } from 'vitest';
import {
  validateSheetDeliveryReceipt,
  type SheetDeliveryReceipt
} from '../src/domain/consumer-delivery.js';
import type { ApprovedReleaseEvidence } from '../src/domain/consumer-cutover.js';

const release: ApprovedReleaseEvidence = {
  projectionId: 'erp-public',
  releaseId: 'rel_20260925',
  manifestId: 'manifest_20260925',
  inputDigest: 'input_digest',
  dataDigest: 'data_digest',
  observedAt: '2026-09-25T07:00:00.000Z'
};

function receipt(overrides: Partial<SheetDeliveryReceipt> = {}): SheetDeliveryReceipt {
  return {
    contractVersion: 'freepass-sheet-delivery-v1',
    consumerId: 'google-sheets-f01',
    workbook: 'F01',
    spreadsheetId: 'sheet-f01',
    approvedRelease: { ...release },
    renderedOutput: {
      transformContractId: 'f01-standard-v1',
      vehicleKeyCount: 692,
      dataDigest: 'sheet_output_digest'
    },
    publicationStartedAt: '2026-09-25T07:01:00.000Z',
    publicationCompletedAt: '2026-09-25T07:02:00.000Z',
    readback: {
      verified: true,
      vehicleKeyCount: 692,
      dataDigest: 'sheet_output_digest'
    },
    ...overrides
  };
}

describe('sheet delivery receipt', () => {
  it('accepts a readback-verified receipt even when projection and rendered digests differ by domain', () => {
    expect(validateSheetDeliveryReceipt(receipt(), release)).toEqual({
      status: 'PASS',
      violations: []
    });
  });

  it('fails closed when F01/F86 identity is crossed', () => {
    expect(validateSheetDeliveryReceipt(receipt({
      consumerId: 'google-sheets-f86'
    }), release)).toMatchObject({
      status: 'HOLD',
      violations: ['CONSUMER_WORKBOOK_MISMATCH']
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
    }), release);

    expect(result.status).toBe('HOLD');
    expect(result.violations).toEqual(expect.arrayContaining([
      'RELEASE_ID_MISMATCH',
      'READBACK_OUTPUT_DIGEST_MISMATCH'
    ]));
  });

  it('blocks a rendered/readback vehicle-key count mismatch', () => {
    const result = validateSheetDeliveryReceipt(receipt({
      readback: {
        verified: true,
        vehicleKeyCount: 691,
        dataDigest: 'sheet_output_digest'
      }
    }), release);

    expect(result).toMatchObject({ status: 'HOLD' });
    expect(result.violations).toContain('READBACK_VEHICLE_KEY_COUNT_MISMATCH');
  });

  it('requires actual readback and a valid publication window', () => {
    const result = validateSheetDeliveryReceipt(receipt({
      publicationStartedAt: '2026-09-25T07:03:00.000Z',
      publicationCompletedAt: '2026-09-25T07:02:00.000Z',
      readback: {
        verified: false,
        vehicleKeyCount: 692,
        dataDigest: 'sheet_output_digest'
      }
    }), release);

    expect(result.status).toBe('HOLD');
    expect(result.violations).toEqual(expect.arrayContaining([
      'INVALID_PUBLICATION_WINDOW',
      'READBACK_NOT_VERIFIED'
    ]));
  });
});
