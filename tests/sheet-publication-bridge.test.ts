import { describe, expect, it } from 'vitest';
import {
  buildSheetBridgeHandoff,
  buildSheetBridgeRelease,
  captureErp5SheetSource
} from '../src/application/sheet-publication-bridge.js';
import { ERP5_DOCUMENTS } from '../src/adapters/erp5-source-capture.js';
import { validateSheetPublicationHandoff } from '../src/domain/sheet-publication-handoff.js';

const readTime = '2026-09-25T08:00:00.000Z';

function doc(collection: 'products' | 'policy' | 'partner', id: string) {
  const common = {
    name: `${ERP5_DOCUMENTS}/${collection}/${id}`,
    createTime: '2026-09-24T00:00:00Z',
    updateTime: '2026-09-25T07:59:00Z'
  };
  if (collection === 'products') {
    return {
      ...common,
      fields: {
        car_number: { stringValue: '12가3456' },
        vehicle_status: { stringValue: '즉시출고' },
        listable: { booleanValue: true },
        status_kind: { stringValue: '가용' },
        provider_company_code: { stringValue: 'RP999' },
        source: { stringValue: 'synthetic-source' },
        policy_reference_checked_at: { timestampValue: '2026-09-25T08:00:00.123456789Z' },
        price: {
          mapValue: {
            fields: {
              '24': {
                mapValue: {
                  fields: {
                    rent: { integerValue: '700000' },
                    deposit: { integerValue: '1000000' }
                  }
                }
              }
            }
          }
        }
      }
    };
  }
  if (collection === 'policy') {
    return {
      ...common,
      fields: {
        policy_code: { stringValue: 'POLICY-1' }
      }
    };
  }
  return {
    ...common,
    fields: {
      partner_code: { stringValue: 'RP999' },
      partner_name: { stringValue: 'Synthetic Partner' }
    }
  };
}

function fake() {
  const calls: string[] = [];
  const rpc = async (method: string, body: Record<string, unknown>) => {
    calls.push(method);
    if (method === 'beginTransaction') return { transaction: 'tx-sheet' };
    if (method === 'rollback') return {};
    const query = (body.structuredQuery ?? (body.structuredAggregationQuery as any)?.structuredQuery) as any;
    const collection = query.from[0].collectionId as 'products' | 'policy' | 'partner';
    if (method === 'runAggregationQuery') {
      return [{
        readTime,
        result: { aggregateFields: { total: { integerValue: '1' } } }
      }];
    }
    return [{ readTime, document: doc(collection, `${collection}-1`) }];
  };
  return { rpc: rpc as any, calls };
}

describe('Data-owned sheet publication bridge', () => {
  it('captures products, policy and partner in one read-only transaction and builds F01/F86 handoffs', async () => {
    const { rpc, calls } = fake();
    const capture = await captureErp5SheetSource(rpc, '2026-09-25T08:01:00.000Z');

    expect(calls).toEqual([
      'beginTransaction',
      'runAggregationQuery', 'runQuery',
      'runAggregationQuery', 'runQuery',
      'runAggregationQuery', 'runQuery',
      'rollback'
    ]);
    expect(capture.collections.products.count).toBe(1);
    expect(capture.collections.policy.count).toBe(1);
    expect(capture.collections.partner.count).toBe(1);

    const bridge = buildSheetBridgeRelease(capture);
    expect(bridge.releaseAuthority).toBe('LEGACY_VERIFIED_BRIDGE');
    expect(bridge.release.projectionId).toBe('sheet-publication-bridge');
    expect(bridge.inventory).toMatchObject({
      registered: 1,
      unavailable: 0,
      open: 1,
      listableDrift: 0,
      statusKindDrift: 0,
      sourceIdentityViolations: 0,
      duplicatePlateViolations: 0,
      depositRuleViolations: 0
    });

    const f01 = buildSheetBridgeHandoff(
      bridge,
      'F01',
      '2026-09-25T08:02:00.000Z'
    );
    const f86 = buildSheetBridgeHandoff(
      bridge,
      'F86',
      '2026-09-25T08:02:00.000Z'
    );

    expect(validateSheetPublicationHandoff(f01)).toEqual({
      status: 'PASS',
      violations: []
    });
    expect(validateSheetPublicationHandoff(f86)).toEqual({
      status: 'PASS',
      violations: []
    });
    expect(f01.approvedRelease).toEqual(f86.approvedRelease);
    expect(f01.manifest.sourceReadTime).toBe(readTime);
    expect(f01.snapshot.capturedAt).toBe('2026-09-25T08:02:00.000Z');
    expect(f86.snapshot.capturedAt).toBe('2026-09-25T08:02:00.000Z');
    expect(f01.snapshot.products).toEqual(f86.snapshot.products);
  });

  it('preserves Firestore Timestamp in the same JSON shape as the production SDK snapshot', async () => {
    const bridge = buildSheetBridgeRelease(
      await captureErp5SheetSource(fake().rpc, '2026-09-25T08:01:00.000Z')
    );
    expect(bridge.products[0]?.policy_reference_checked_at).toEqual({
      _seconds: Date.parse('2026-09-25T08:00:00Z') / 1000,
      _nanoseconds: 123456789
    });
  });

  it('applies the current production deposit-rule publication gate in the legacy bridge', async () => {
    const capture = await captureErp5SheetSource(
      fake().rpc,
      '2026-09-25T08:01:00.000Z'
    );
    const product = capture.collections.products.documents[0]!;
    Object.assign(product.fields as Record<string, unknown>, {
      deposit_note: { stringValue: '월 대여료 × 약정연수 (최대 3개월)' },
      product_type: { stringValue: '픽업구독' }
    });

    const { createHash } = await import('node:crypto');
    const { digest: _old, ...unsigned } = capture;
    capture.digest = createHash('sha256')
      .update(JSON.stringify(unsigned))
      .digest('hex');

    expect(() => buildSheetBridgeRelease(capture))
      .toThrow('SHEET_BRIDGE_INVENTORY_VIOLATION');
  });

  it('detects handoff payload tampering independently of the handoff hash', async () => {
    const bridge = buildSheetBridgeRelease(
      await captureErp5SheetSource(fake().rpc, '2026-09-25T08:01:00.000Z')
    );
    const handoff = buildSheetBridgeHandoff(
      bridge,
      'F01',
      '2026-09-25T08:02:00.000Z'
    );
    handoff.snapshot.products[0]!.vehicle_status = '출고불가';

    expect(validateSheetPublicationHandoff(handoff)).toMatchObject({
      status: 'HOLD'
    });
    expect(validateSheetPublicationHandoff(handoff).violations).toEqual(
      expect.arrayContaining([
        'SNAPSHOT_DATA_DIGEST_MISMATCH',
        'HANDOFF_HASH_MISMATCH'
      ])
    );
  });

  it('holds bridge publication when inventory invariants drift', async () => {
    const capture = await captureErp5SheetSource(
      fake().rpc,
      '2026-09-25T08:01:00.000Z'
    );
    const product = capture.collections.products.documents[0]!;
    (product.fields as any).listable = { booleanValue: false };

    const { createHash } = await import('node:crypto');
    const { digest: _old, ...unsigned } = capture;
    capture.digest = createHash('sha256')
      .update(JSON.stringify(unsigned))
      .digest('hex');

    expect(() => buildSheetBridgeRelease(capture))
      .toThrow('SHEET_BRIDGE_INVENTORY_VIOLATION');
  });

  it('fails the whole capture if partner evidence drifts to another read time', async () => {
    const { rpc } = fake();
    const drifting = async (method: string, body: Record<string, unknown>) => {
      const result = await rpc(method, body);
      const query = (body.structuredQuery ?? (body.structuredAggregationQuery as any)?.structuredQuery) as any;
      if (
        method === 'runAggregationQuery' &&
        query?.from?.[0]?.collectionId === 'partner'
      ) {
        return [{ ...(result as any[])[0], readTime: '2026-09-25T08:00:01.000Z' }];
      }
      return result;
    };

    await expect(
      captureErp5SheetSource(drifting as any, '2026-09-25T08:01:00.000Z')
    ).rejects.toThrow('SHEET_SOURCE_READ_TIME_DRIFT');
  });
});
