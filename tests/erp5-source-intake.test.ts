import { describe, expect, it } from 'vitest';
import {
  ERP5_DOCUMENTS,
  buildErp5RawSourceIntakeBatches,
  type Erp5SourceCapture,
} from '../src/adapters/erp5-source-capture.js';
import { orderedJsonDigest } from '../src/shared/stable-digest.js';

const readTime = '2026-09-27T05:20:00.000Z';

function doc(collection: 'products' | 'policy' | 'partner', id: string) {
  return {
    name: `${ERP5_DOCUMENTS}/${collection}/${id}`,
    createTime: '2026-09-27T05:00:00Z',
    updateTime: readTime,
    fields: collection === 'products'
      ? {
          car_number: { stringValue: '12가3456' },
          maker: { stringValue: '기아' },
          model: { stringValue: '쏘렌토' },
          provider_company_code: { stringValue: 'SUP1' },
          product_type: { stringValue: '중고렌트' },
          vehicle_status: { stringValue: '출고가능' },
          status_kind: { stringValue: '가용' },
          listable: { booleanValue: true },
          price: {
            mapValue: {
              fields: {
                '24_3만': {
                  mapValue: {
                    fields: {
                      rent: { integerValue: '750000' },
                      deposit: { integerValue: '0' },
                    },
                  },
                },
              },
            },
          },
        }
      : {},
  };
}

function capture(): Erp5SourceCapture {
  const unsigned = {
    version: 'erp5-source-capture/1' as const,
    projectId: 'freepasserp5' as const,
    databaseId: '(default)' as const,
    consistency: 'READ_ONLY_TRANSACTION' as const,
    readTime,
    capturedAt: '2026-09-27T05:20:01.000Z',
    collections: {
      products: { count: 1, documents: [doc('products', 'product-1')] },
      policy: { count: 1, documents: [doc('policy', 'policy-1')] },
      partner: { count: 1, documents: [doc('partner', 'partner-1')] },
    },
  };
  return { ...unsigned, digest: orderedJsonDigest(unsigned) };
}

describe('ERP5 raw source intake mapping', () => {
  it('maps products policy and partner into the correct source lanes', () => {
    const input = capture();
    const batches = buildErp5RawSourceIntakeBatches(input);

    expect(batches).toHaveLength(3);
    expect(batches.map((item) => [item.source.sourceId, item.laneId])).toEqual([
      ['freepasserp5/firestore/products', 'PRODUCT_VEHICLE'],
      ['freepasserp5/firestore/policy', 'PRODUCT_VEHICLE'],
      ['freepasserp5/firestore/partner', 'SUPPLIER'],
    ]);

    for (const batch of batches) {
      expect(batch.observedAt).toBe(readTime);
      expect(batch.sourceRevision).toBe(`capture:${input.digest}`);
      expect(batch.checksum).toBe(input.digest);
      expect(batch.coverage).toMatchObject({
        mode: 'FULL',
        completeness: 'COMPLETE',
      });
      expect(batch.records).toHaveLength(1);
      expect(batch.records[0]?.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('preserves the complete raw Firestore document as payload', () => {
    const product = buildErp5RawSourceIntakeBatches(capture())[0]!;
    expect(product.records[0]?.sourceRecordId).toBe('product-1');
    expect(product.records[0]?.payload).toEqual(doc('products', 'product-1'));
  });
});
