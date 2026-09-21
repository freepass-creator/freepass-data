import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { captureErp5Source, decodeErp5Value, erp5ReadTransport, inspectErp5Capture, ERP5_DOCUMENTS } from '../src/adapters/erp5-source-capture.js';
const readTime = '2026-09-21T10:00:00.123456Z';
function doc(collection = 'products', id = 'synthetic') {
  return {
    name: `${ERP5_DOCUMENTS}/${collection}/${id}`,
    createTime: '2026-09-20T10:00:00Z', updateTime: '2026-09-21T09:59:00Z',
    fields: collection === 'products' ? {
      car_number: { stringValue: '12가3456' }, maker: { stringValue: '합성제조사' }, model: { stringValue: '합성모델' },
      provider_company_code: { stringValue: 'SYNTHETIC' }, product_type: { stringValue: '중고렌트' },
      vehicle_status: { stringValue: '출고가능' }, status_kind: { stringValue: '가용' }, listable: { booleanValue: true },
      price: { mapValue: { fields: { '24_3만': { mapValue: { fields: { rent: { integerValue: '750000' }, deposit: { integerValue: '0' } } } } } } }
    } : {}
  };
}
function fake(options: { products?: Record<string, unknown>[]; drift?: boolean; failPolicy?: boolean; count?: string; extraRow?: unknown } = {}) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const products = options.products ?? [doc()];
  const rpc = async (method: string, body: Record<string, unknown>) => {
    calls.push({ method, body });
    if (method === 'beginTransaction') return { transaction: 'synthetic-private-transaction' };
    if (method === 'rollback') return {};
    expect(body.transaction).toBe('synthetic-private-transaction');
    const query = (body.structuredQuery ?? (body.structuredAggregationQuery as any)?.structuredQuery) as any;
    expect(Object.keys(query)).toEqual(['from']);
    const collection = query.from[0].collectionId;
    if (collection === 'policy' && options.failPolicy) throw new Error('synthetic failure');
    if (method === 'runAggregationQuery') return [{ readTime: options.drift && collection === 'policy' ? '2026-09-21T10:01:00Z' : readTime,
      result: { aggregateFields: { total: { integerValue: options.count ?? String(collection === 'products' ? products.length : 1) } } } }];
    const rows: unknown[] = (collection === 'products' ? products : [doc('policy')]).map(document => ({ readTime, document }));
    if (!rows.length) rows.push({ readTime });
    if (options.extraRow) rows.push(options.extraRow);
    return rows;
  };
  return { calls, rpc };
}

describe('ERP5 same-transaction raw capture', () => {
  it('uses a read-only transaction and independent counts for full products and policy', async () => {
    const { rpc, calls } = fake();
    const capture = await captureErp5Source(rpc);
    expect(calls[0]).toEqual({ method: 'beginTransaction', body: { options: { readOnly: {} } } });
    expect(calls.map(c => c.method)).toEqual(['beginTransaction', 'runAggregationQuery', 'runQuery', 'runAggregationQuery', 'runQuery', 'rollback']);
    expect(capture.readTime).toBe(readTime);
    expect(capture.collections.products.documents[0]).toEqual(doc());
    expect(JSON.stringify(capture)).not.toContain('synthetic-private-transaction');
    const report = inspectErp5Capture(capture);
    expect(report.mappedForReview).toBe(1);
    expect(report.status).toBe('HOLD');
    expect(report.cutoverAuthorized).toBe(false);
    expect(report.canonicalWriteAuthorized).toBe(false);
    expect(JSON.stringify(report)).not.toContain('12가3456');
    expect(JSON.stringify(report)).not.toContain('합성모델');
  });

  it('detects a truncated response instead of comparing its length to itself', async () => {
    const { rpc, calls } = fake({ count: '2' });
    await expect(captureErp5Source(rpc)).rejects.toThrow('INCOMPLETE_COLLECTION');
    expect(calls.at(-1)!.method).toBe('rollback');
  });
  it.each([
    { products: [doc(), doc()] },
    { products: [{ ...doc(), name: 'projects/wrong/databases/(default)/documents/products/x' }] },
    { products: [{ ...doc(), name: `${ERP5_DOCUMENTS}/products/x/nested/y` }] },
    { products: [{ ...doc(), updateTime: 'invalid' }] },
    { drift: true }, { count: '-1' }, { count: '999999999999999999' },
    { extraRow: { error: { message: 'synthetic server error' } } },
    { extraRow: { skippedResults: 1 } }
  ])('rejects invalid or conflicting source evidence: %j', async options => {
    const { rpc, calls } = fake(options);
    await expect(captureErp5Source(rpc)).rejects.toThrow();
    expect(calls.at(-1)!.method).toBe('rollback');
  });
  it('rolls back and fails the entire capture when policy collection fails', async () => {
    const { rpc, calls } = fake({ failPolicy: true });
    await expect(captureErp5Source(rpc)).rejects.toThrow();
    expect(calls.at(-1)!.method).toBe('rollback');
  });
  it('preserves an empty collection as evidence, never authorizes production', async () => {
    const capture = await captureErp5Source(fake({ products: [] }).rpc);
    expect(inspectErp5Capture(capture).products).toBe(0);
    expect(inspectErp5Capture(capture).status).toBe('HOLD');
  });
  it('detects file corruption before mapping', async () => {
    const capture = await captureErp5Source(fake().rpc);
    capture.collections.products.documents[0]!.fields = {};
    expect(() => inspectErp5Capture(capture)).toThrow('CAPTURE_DIGEST_MISMATCH');
  });
  it('retains unsupported Firestore types in raw and counts the entire record as HOLD', async () => {
    const product = doc();
    Object.assign(product.fields, { sdk_timestamp: { timestampValue: readTime } });
    const capture = await captureErp5Source(fake({ products: [product] }).rpc);
    expect(capture.collections.products.documents[0]).toEqual(product);
    expect(inspectErp5Capture(capture).decodeFailed).toBe(1);
    expect(inspectErp5Capture(capture).mappedForReview).toBe(0);
    expect(inspectErp5Capture(capture).decodeFailureCounts).toEqual({ UNSUPPORTED_FIRESTORE_VALUE: 1 });
    expect(inspectErp5Capture(capture).plateChecked).toBe(1);
  });
  it.each(['2026-09-21T09:00:00Z', '2026-09-21T09:00:00.123456789Z', '2026-09-21T18:00:00.123456+09:00'])('supports known metadata timestamp %s without changing typed evidence or digest', async timestamp => {
    const product = doc();
    Object.assign(product.fields, { updated_at: { timestampValue: timestamp }, policy_reference_checked_at: { timestampValue: timestamp } });
    const capture = await captureErp5Source(fake({ products: [product] }).rpc);
    const before = JSON.stringify(capture);
    const report = inspectErp5Capture(capture);
    expect(report.decodeFailed).toBe(0);
    expect(report.mappedForReview).toBe(1);
    expect(report.metadataTimestampFields).toBe(2);
    expect(JSON.stringify(capture)).toBe(before);
  });
  it.each(['2026-02-30T00:00:00Z', '2026-09-21T24:00:00Z', '2026-09-21', '2026-09-21T10:00:00+25:00', 'bad'])('holds invalid metadata timestamp %s', async timestamp => {
    const product = doc();
    Object.assign(product.fields, { updated_at: { timestampValue: timestamp } });
    const capture = await captureErp5Source(fake({ products: [product] }).rpc);
    expect(inspectErp5Capture(capture).decodeFailureCounts).toEqual({ INVALID_METADATA_TIMESTAMP: 1 });
  });
  it('never makes business model/year timestamps ordinary candidate text', async () => {
    const product = doc();
    Object.assign(product.fields, { model: { timestampValue: readTime } });
    const capture = await captureErp5Source(fake({ products: [product] }).rpc);
    expect(inspectErp5Capture(capture).decodeFailed).toBe(1);
    expect(inspectErp5Capture(capture).mappedForReview).toBe(0);
  });
  it('does not propagate the metadata allowlist into a nested map', async () => {
    const product = doc();
    Object.assign(product.fields, { nested: { mapValue: { fields: { updated_at: { timestampValue: readTime } } } } });
    const capture = await captureErp5Source(fake({ products: [product] }).rpc);
    expect(inspectErp5Capture(capture).decodeFailed).toBe(1);
  });
  it('counts duplicate plate evidence without discarding either document', async () => {
    const capture = await captureErp5Source(fake({ products: [doc(), doc('products', 'second')] }).rpc);
    expect(inspectErp5Capture(capture).duplicatePlateCount).toBe(1);
    expect(inspectErp5Capture(capture).products).toBe(2);
  });
  it('does not claim plate coverage for records without readable identity', async () => {
    const product = doc();
    Object.assign(product.fields, { car_number: { integerValue: '123' } });
    const capture = await captureErp5Source(fake({ products: [product] }).rpc);
    expect(inspectErp5Capture(capture).plateUnchecked).toBe(1);
    expect(inspectErp5Capture(capture).plateChecked).toBe(0);
  });
  it('rejects inconsistent stored counts even when a file digest was recomputed', async () => {
    const capture = await captureErp5Source(fake().rpc);
    capture.collections.products.count = 2;
    const { digest: _digest, ...unsigned } = capture;
    capture.digest = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
    expect(() => inspectErp5Capture(capture)).toThrow('INVALID_CAPTURE_COVERAGE');
  });
});

describe('lossless Firestore decode boundary', () => {
  it.each([
    [{ nullValue: null }, null], [{ integerValue: '0' }, 0], [{ booleanValue: false }, false],
    [{ stringValue: '' }, ''], [{ mapValue: {} }, {}], [{ arrayValue: {} }, []],
    [{ arrayValue: { values: [{ integerValue: '42' }] } }, [42]]
  ])('decodes explicit empty and zero values %j without guessing', (raw, expected) => expect(decodeErp5Value(raw)).toEqual(expected));
  it.each([
    { integerValue: '9007199254740993' }, { integerValue: '1.2' }, { doubleValue: 'NaN' },
    { booleanValue: 'false' }, { stringValue: 'x', integerValue: '1' },
    { referenceValue: 'synthetic' }, { bytesValue: 'AA==' }, { geoPointValue: { latitude: 0, longitude: 0 } },
    { arrayValue: { values: 'not an array' } }, { mapValue: { fields: [] } }
  ])('fails closed for unsupported/malformed typed value %j', raw => expect(() => decodeErp5Value(raw)).toThrow());
});

describe('network boundary', () => {
  it('uses the fixed Google endpoint and refuses redirects without logging error bodies', async () => {
    const fetcher = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response('sensitive server error', { status: 403 }));
    const rpc = erp5ReadTransport('synthetic-token', fetcher as typeof fetch);
    await expect(rpc('beginTransaction', { options: { readOnly: {} } })).rejects.toThrow('ERP5_READ_HTTP_403');
    expect(fetcher.mock.calls[0]![0]).toBe(`https://firestore.googleapis.com/v1/${ERP5_DOCUMENTS}:beginTransaction`);
    expect((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('error');
  });
  it('does not accept a write RPC even through an untyped caller', async () => {
    const fetcher = vi.fn();
    const rpc = erp5ReadTransport('synthetic-token', fetcher as typeof fetch);
    await expect((rpc as any)('commit', { writes: [] })).rejects.toThrow('FORBIDDEN_RPC');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
