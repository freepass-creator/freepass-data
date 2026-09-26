import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import healthSchema from '../contracts/sheet-consumer-health-v1.schema.json' with { type: 'json' };
import {
  readSheetConsumerHealth,
  SHEET_CONSUMER_HEALTH_CONTRACT_VERSION,
  SHEET_CONSUMER_HEALTH_SCHEMA_VERSION
} from '../src/application/sheet-consumer-health.js';
import { recordSheetDeliveryEvidence } from '../src/application/sheet-delivery-evidence.js';
import {
  buildSheetDeliveryExpectation,
  type SheetDeliveryReceipt
} from '../src/domain/consumer-delivery.js';
import {
  hashSheetPublicationData,
  hashSheetPublicationHandoff,
  type SheetPublicationHandoff
} from '../src/domain/sheet-publication-handoff.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validate = ajv.compile(healthSchema);

const snapshot = {
  version: 1 as const,
  snapshotId: 'rel_health_001',
  capturedAt: '2026-09-26T08:00:00.000Z',
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

function f01Handoff(): SheetPublicationHandoff {
  const dataDigest = hashSheetPublicationData(snapshot);
  const unsigned: Omit<SheetPublicationHandoff, 'handoffHash'> = {
    contractVersion: 'freepass-sheet-handoff-v1',
    consumerId: 'google-sheets-f01',
    workbook: 'F01',
    generatedAt: '2026-09-26T08:02:00.000Z',
    releaseAuthority: 'LEGACY_VERIFIED_BRIDGE',
    approvedRelease: {
      projectionId: 'sheet-publication-bridge',
      releaseId: 'rel_health_001',
      manifestId: 'manifest_health_001',
      inputDigest: 'input_health_001',
      dataDigest,
      observedAt: '2026-09-26T07:59:00.000Z'
    },
    manifest: {
      contractVersion: 'freepass-sheet-manifest-v1',
      manifestId: 'manifest_health_001',
      releaseId: 'rel_health_001',
      projectionId: 'sheet-publication-bridge',
      releaseAuthority: 'LEGACY_VERIFIED_BRIDGE',
      sourceCaptureDigest: 'input_health_001',
      sourceReadTime: '2026-09-26T07:59:00.000Z',
      productCount: 1,
      policyCount: 0,
      partnerCount: 0,
      dataDigest,
      generatedAt: '2026-09-26T08:01:00.000Z'
    },
    snapshot
  };
  return {
    ...structuredClone(unsigned),
    handoffHash: hashSheetPublicationHandoff(unsigned)
  };
}

function receipt(handoff: SheetPublicationHandoff): SheetDeliveryReceipt {
  const expected = buildSheetDeliveryExpectation(handoff);
  return {
    contractVersion: 'freepass-sheet-delivery-v1',
    consumerId: handoff.consumerId,
    workbook: handoff.workbook,
    spreadsheetId: 'sheet-f01',
    releaseAuthority: handoff.releaseAuthority,
    approvedRelease: structuredClone(handoff.approvedRelease),
    publicationHandoffHash: expected.publicationHandoffHash,
    renderedOutput: {
      transformContractId: 'f01-standard-v1',
      vehicleKeyCount: 1,
      dataDigest: 'rendered_health_digest'
    },
    publicationStartedAt: '2026-09-26T08:03:00.000Z',
    publicationCompletedAt: '2026-09-26T08:04:00.000Z',
    readback: {
      verified: true,
      vehicleKeyCount: 1,
      dataDigest: 'rendered_health_digest'
    }
  };
}

describe('Sheet consumer health projection', () => {
  it('emits a strict versioned report for both registered Sheet consumers', async () => {
    const store = new MemoryDataStore();

    const report = await readSheetConsumerHealth(store, {
      assessedAt: '2026-09-26T08:10:00.000Z',
      maxAgeMs: 30 * 60_000,
      maxFutureSkewMs: 0
    });

    expect(report.contractVersion).toBe(SHEET_CONSUMER_HEALTH_CONTRACT_VERSION);
    expect(report.schemaVersion).toBe(SHEET_CONSUMER_HEALTH_SCHEMA_VERSION);
    expect(report.status).toBe('BLOCKED');
    expect(report.consumers.map((item) => item.consumerId)).toEqual([
      'google-sheets-f01',
      'google-sheets-f86'
    ]);
    expect(report.consumers.every((item) => item.evidence.receiptId === null))
      .toBe(true);
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it('shows fresh bridge evidence while preserving the actual authentication blocker', async () => {
    const store = new MemoryDataStore();
    const handoff = f01Handoff();
    await recordSheetDeliveryEvidence(store, {
      handoff,
      receipt: receipt(handoff),
      recordedAt: '2026-09-26T08:05:00.000Z'
    });

    const report = await readSheetConsumerHealth(store, {
      assessedAt: '2026-09-26T08:10:00.000Z',
      maxAgeMs: 30 * 60_000,
      maxFutureSkewMs: 0
    });

    const f01 = report.consumers[0]!;
    const f86 = report.consumers[1]!;

    expect(f01).toMatchObject({
      consumerId: 'google-sheets-f01',
      workbook: 'F01',
      status: 'BLOCKED',
      currentStage: 'OBSERVE',
      nextStage: 'SHADOW_READ',
      evidence: {
        releaseAuthority: 'LEGACY_VERIFIED_BRIDGE',
        freepassReadVerified: true,
        productionReadbackVerified: false,
        freshness: {
          status: 'PASS',
          blockers: []
        }
      },
      nextTransition: {
        allowed: false,
        from: 'OBSERVE',
        to: 'SHADOW_READ'
      }
    });
    expect(f01.blockers).toContain(
      'missing evidence: authenticationVerified'
    );

    expect(f86).toMatchObject({
      consumerId: 'google-sheets-f86',
      status: 'BLOCKED',
      evidence: {
        receiptId: null,
        releaseAuthority: null,
        freepassReadVerified: false,
        productionReadbackVerified: false,
        freshness: null
      }
    });

    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it('surfaces stale evidence as an explicit health blocker', async () => {
    const store = new MemoryDataStore();
    const handoff = f01Handoff();
    await recordSheetDeliveryEvidence(store, {
      handoff,
      receipt: receipt(handoff),
      recordedAt: '2026-09-26T08:05:00.000Z'
    });

    const report = await readSheetConsumerHealth(store, {
      assessedAt: '2026-09-26T10:10:00.000Z',
      maxAgeMs: 30 * 60_000,
      maxFutureSkewMs: 0
    });

    const f01 = report.consumers[0]!;
    expect(f01.evidence.freshness).toMatchObject({
      status: 'HOLD',
      blockers: expect.arrayContaining([
        'SHEET_READBACK_STALE',
        'SHEET_APPROVED_RELEASE_STALE'
      ])
    });
    expect(f01.blockers).toEqual(expect.arrayContaining([
      'SHEET_READBACK_STALE',
      'SHEET_APPROVED_RELEASE_STALE'
    ]));
    expect(f01.status).toBe('BLOCKED');
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it('keeps the JSON schema contract identity pinned to runtime constants', () => {
    expect(healthSchema.properties.contractVersion.const)
      .toBe(SHEET_CONSUMER_HEALTH_CONTRACT_VERSION);
    expect(healthSchema.properties.schemaVersion.const)
      .toBe(SHEET_CONSUMER_HEALTH_SCHEMA_VERSION);
  });
});
