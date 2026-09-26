import { describe, expect, it } from 'vitest';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import {
  assessLatestSheetConsumerCutover,
  readSheetDeliveryEvidence,
  recordSheetDeliveryEvidence
} from '../src/application/sheet-delivery-evidence.js';
import {
  buildSheetDeliveryExpectation,
  type SheetDeliveryReceipt
} from '../src/domain/consumer-delivery.js';
import {
  hashSheetPublicationData,
  hashSheetPublicationHandoff,
  type SheetPublicationHandoff
} from '../src/domain/sheet-publication-handoff.js';
import type { ConsumerSwitchRegistration } from '../src/domain/consumer-cutover.js';

const snapshot = {
  version: 1 as const,
  snapshotId: 'rel_sheet_001',
  capturedAt: '2026-09-26T07:00:00.000Z',
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

function handoff(
  authority: 'LEGACY_VERIFIED_BRIDGE' | 'CANONICAL_ACTIVE',
  generatedAt = '2026-09-26T07:02:00.000Z'
): SheetPublicationHandoff {
  const projectionId = authority === 'LEGACY_VERIFIED_BRIDGE'
    ? 'sheet-publication-bridge'
    : 'erp-public';
  const dataDigest = hashSheetPublicationData(snapshot);
  const unsigned: Omit<SheetPublicationHandoff, 'handoffHash'> = {
    contractVersion: 'freepass-sheet-handoff-v1',
    consumerId: 'google-sheets-f01',
    workbook: 'F01',
    generatedAt,
    releaseAuthority: authority,
    approvedRelease: {
      projectionId,
      releaseId: 'rel_sheet_001',
      manifestId: 'manifest_sheet_001',
      inputDigest: 'input_sheet_001',
      dataDigest,
      observedAt: '2026-09-26T06:59:00.000Z'
    },
    manifest: {
      contractVersion: 'freepass-sheet-manifest-v1',
      manifestId: 'manifest_sheet_001',
      releaseId: 'rel_sheet_001',
      projectionId,
      releaseAuthority: authority,
      sourceCaptureDigest: 'input_sheet_001',
      sourceReadTime: '2026-09-26T06:59:00.000Z',
      productCount: 1,
      policyCount: 0,
      partnerCount: 0,
      dataDigest,
      generatedAt: '2026-09-26T07:01:00.000Z'
    },
    snapshot
  };
  return {
    ...structuredClone(unsigned),
    handoffHash: hashSheetPublicationHandoff(unsigned)
  };
}

function receipt(
  boundHandoff: SheetPublicationHandoff,
  completedAt = '2026-09-26T07:04:00.000Z'
): SheetDeliveryReceipt {
  const expected = buildSheetDeliveryExpectation(boundHandoff);
  return {
    contractVersion: 'freepass-sheet-delivery-v1',
    consumerId: boundHandoff.consumerId,
    workbook: boundHandoff.workbook,
    spreadsheetId: 'sheet-f01',
    releaseAuthority: boundHandoff.releaseAuthority,
    approvedRelease: structuredClone(boundHandoff.approvedRelease),
    publicationHandoffHash: expected.publicationHandoffHash,
    renderedOutput: {
      transformContractId: 'f01-standard-v1',
      vehicleKeyCount: 1,
      dataDigest: 'rendered_sheet_digest'
    },
    publicationStartedAt: '2026-09-26T07:03:00.000Z',
    publicationCompletedAt: completedAt,
    readback: {
      verified: true,
      vehicleKeyCount: 1,
      dataDigest: 'rendered_sheet_digest'
    }
  };
}

function registration(
  stage: ConsumerSwitchRegistration['stage']
): ConsumerSwitchRegistration {
  return {
    consumerId: 'google-sheets-f01',
    project: 'Google Sheets F01',
    repository: 'freepass-creator/freepasserp4',
    domains: ['catalog'],
    stage,
    activeReadOwner: 'legacy',
    targetReadOwner: 'freepass-data',
    switchKey: 'FREEPASS_DATA_F01_READ_MODE',
    evidence: {
      contractReady: true,
      authenticationVerified: true,
      legacyReadVerified: true,
      freepassReadVerified: false,
      parityVerified: true,
      fallbackVerified: true,
      productionReadbackVerified: false,
      approvedRelease: null
    },
    holdReasons: []
  };
}

describe('durable Sheet delivery evidence', () => {
  it('records, re-reads and idempotently reuses one validated receipt', async () => {
    const store = new MemoryDataStore();
    const h = handoff('LEGACY_VERIFIED_BRIDGE');
    const r = receipt(h);

    const first = await recordSheetDeliveryEvidence(store, {
      handoff: h,
      receipt: r,
      recordedAt: '2026-09-26T07:05:00.000Z'
    });
    const second = await recordSheetDeliveryEvidence(store, {
      handoff: h,
      receipt: r,
      recordedAt: '2026-09-26T07:06:00.000Z'
    });
    const reread = await readSheetDeliveryEvidence(store, first.receiptId);

    expect(first.receiptId).toMatch(/^sheet_receipt_[a-f0-9]{64}$/);
    expect(second).toEqual(first);
    expect(reread).toEqual(first);
    expect(await store.listSheetDeliveryEvidence('google-sheets-f01'))
      .toHaveLength(1);
  });

  it('never persists an invalid receipt', async () => {
    const store = new MemoryDataStore();
    const h = handoff('LEGACY_VERIFIED_BRIDGE');
    const invalid = receipt(h);
    invalid.readback.verified = false;

    await expect(recordSheetDeliveryEvidence(store, {
      handoff: h,
      receipt: invalid
    })).rejects.toThrow('SHEET_DELIVERY_RECEIPT_INVALID');

    expect(await store.listSheetDeliveryEvidence('google-sheets-f01'))
      .toEqual([]);
  });

  it('uses a stored bridge receipt to unlock shadow read but not production readback', async () => {
    const store = new MemoryDataStore();
    const h = handoff('LEGACY_VERIFIED_BRIDGE');
    await recordSheetDeliveryEvidence(store, {
      handoff: h,
      receipt: receipt(h)
    });

    const assessed = await assessLatestSheetConsumerCutover(
      store,
      registration('OBSERVE'),
      'SHADOW_READ'
    );

    expect(assessed.delivery).toMatchObject({
      authority: 'LEGACY_VERIFIED_BRIDGE',
      evidence: {
        freepassReadVerified: true,
        productionReadbackVerified: false
      }
    });
    expect(assessed.decision.allowed).toBe(true);
  });

  it('uses a stored canonical receipt as final production readback evidence', async () => {
    const store = new MemoryDataStore();
    const h = handoff('CANONICAL_ACTIVE');
    await recordSheetDeliveryEvidence(store, {
      handoff: h,
      receipt: receipt(h)
    });

    const assessed = await assessLatestSheetConsumerCutover(
      store,
      registration('PARITY_VERIFIED'),
      'FREEPASS_DATA_READ'
    );

    expect(assessed.delivery).toMatchObject({
      status: 'PASS',
      authority: 'CANONICAL_ACTIVE',
      evidence: {
        freepassReadVerified: true,
        productionReadbackVerified: true
      }
    });
    expect(assessed.decision).toMatchObject({
      allowed: true,
      from: 'PARITY_VERIFIED',
      to: 'FREEPASS_DATA_READ',
      blockers: []
    });
  });

  it('fails closed when the latest durable receipt falls back to bridge authority', async () => {
    const store = new MemoryDataStore();
    const canonical = handoff('CANONICAL_ACTIVE');
    await recordSheetDeliveryEvidence(store, {
      handoff: canonical,
      receipt: receipt(canonical, '2026-09-26T07:04:00.000Z'),
      recordedAt: '2026-09-26T07:04:30.000Z'
    });

    const bridge = handoff(
      'LEGACY_VERIFIED_BRIDGE',
      '2026-09-26T07:05:00.000Z'
    );
    const bridgeReceipt = receipt(
      bridge,
      '2026-09-26T07:07:00.000Z'
    );
    bridgeReceipt.publicationStartedAt = '2026-09-26T07:06:00.000Z';
    await recordSheetDeliveryEvidence(store, {
      handoff: bridge,
      receipt: bridgeReceipt,
      recordedAt: '2026-09-26T07:07:30.000Z'
    });

    const assessed = await assessLatestSheetConsumerCutover(
      store,
      registration('PARITY_VERIFIED'),
      'FREEPASS_DATA_READ'
    );

    expect(assessed.record?.receipt.releaseAuthority)
      .toBe('LEGACY_VERIFIED_BRIDGE');
    expect(assessed.registration.evidence.productionReadbackVerified)
      .toBe(false);
    expect(assessed.decision.allowed).toBe(false);
    expect(assessed.decision.blockers).toEqual(expect.arrayContaining([
      'missing evidence: productionReadbackVerified',
      'migration bridge release cannot authorize final cutover'
    ]));
  });
});
