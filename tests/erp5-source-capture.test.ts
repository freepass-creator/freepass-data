import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { buildErp5CanonicalDryRun, captureErp5Source, compareErp5ProductCaptures, decodeErp5Value, erp5ReadTransport, inspectErp5Capture, profileErp5CaptureFields, ERP5_DOCUMENTS } from '../src/adapters/erp5-source-capture.js';
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

  it('builds a complete deterministic private dry run without authorizing writes', async () => {
    const held = doc('products', 'held');
    delete (held.fields as Record<string, unknown>).maker;
    const capture = await captureErp5Source(fake({ products: [doc(), held] }).rpc);
    const first = buildErp5CanonicalDryRun(capture);
    const second = buildErp5CanonicalDryRun(structuredClone(capture));

    expect(first.digest).toBe(second.digest);
    expect(first.status).toBe('HOLD');
    expect(first.canonicalWriteAuthorized).toBe(false);
    expect(first.cutoverAuthorized).toBe(false);
    expect(first.counts).toEqual({
      sourceProducts: 2,
      candidates: 2,
      mappedForReview: 1,
      hold: 1
    });
    expect(first.records.map((record) => record.sourceRecordId)).toEqual(['held', 'synthetic']);
    expect(first.records[0]!.holdReasons).toContain('MISSING_REQUIRED:maker');
    expect(first.records[0]!.reviewAxes).toContain('IDENTITY');
    expect(first.reviewAxisCounts.IDENTITY).toBe(1);
    expect(Object.values(first.reviewComplexityCounts).reduce((sum, count) => sum + count, 0)).toBe(2);
    expect('raw' in first.records[0]!).toBe(false);
    expect(first.fieldProfile.documentCount).toBe(2);
    expect(first.fieldProfile.fields.find((field) => field.path === 'maker')).toMatchObject({
      presentDocuments: 1, missingDocuments: 1, firestoreKinds: { stringValue: 1 }
    });
    expect(JSON.stringify(first.fieldProfile)).not.toContain('합성제조사');
  });

  it('profiles nested maps and repeated arrays without exposing scalar values', async () => {
    const product = doc();
    Object.assign(product.fields, {
      empty: { stringValue: '' },
      tags: { arrayValue: { values: [{ stringValue: 'private-a' }, { stringValue: 'private-b' }] } }
    });
    const capture = await captureErp5Source(fake({ products: [product] }).rpc);
    const profile = profileErp5CaptureFields(capture, 'products');
    expect(profile.fields.find((field) => field.path === 'price.24_3만.rent')).toMatchObject({
      presentDocuments: 1, occurrences: 1, firestoreKinds: { integerValue: 1 }, distinctValueCount: 1
    });
    expect(profile.fields.find((field) => field.path === 'tags[]')).toMatchObject({
      presentDocuments: 1, occurrences: 2, firestoreKinds: { stringValue: 2 }, distinctValueCount: 2
    });
    expect(profile.fields.find((field) => field.path === 'empty')?.emptyStringCount).toBe(1);
    expect(JSON.stringify(profile)).not.toContain('private-a');
    expect(JSON.stringify(profile)).not.toContain('750000');
  });

  it('classifies full-capture additions, field changes, unchanged and missing records without deleting', async () => {
    const changedBefore = doc('products', 'changed');
    const changedAfter = structuredClone(changedBefore);
    (changedAfter.fields as any).vehicle_status = { stringValue: '출고불가' };
    (changedAfter.fields as any).status_kind = { stringValue: '불가' };
    (changedAfter.fields as any).listable = { booleanValue: false };
    const previous = await captureErp5Source(fake({ products: [doc('products', 'same'), changedBefore, doc('products', 'missing')] }).rpc);
    const current = await captureErp5Source(fake({ products: [doc('products', 'same'), changedAfter, doc('products', 'added')] }).rpc);
    const delta = compareErp5ProductCaptures(previous, current);

    expect(delta.counts).toEqual({ ADDED: 1, CHANGED: 1, UNCHANGED: 1, MISSING_FROM_SOURCE: 1 });
    expect(delta.inventoryTransitionCount).toBe(1);
    expect(delta.status).toBe('HOLD');
    expect(delta.canonicalWriteAuthorized).toBe(false);
    expect(delta.destructiveActionAuthorized).toBe(false);
    expect(delta.records.find((item) => item.sourceRecordId === 'changed')?.inventoryTransition).toEqual({
      before: { vehicleStatus: '출고가능', listable: true },
      after: { vehicleStatus: '출고불가', listable: false }
    });
    expect(delta.records.find((item) => item.sourceRecordId === 'missing')?.kind).toBe('MISSING_FROM_SOURCE');
    expect(delta.records.every((item) => item.destructiveActionAuthorized === false)).toBe(true);
  });

  it('produces a deterministic no-change delta and rejects reversed capture order', async () => {
    const previous = await captureErp5Source(fake().rpc);
    const same = structuredClone(previous);
    const first = compareErp5ProductCaptures(previous, same);
    const second = compareErp5ProductCaptures(structuredClone(previous), structuredClone(same));
    expect(first.digest).toBe(second.digest);
    expect(first.status).toBe('NO_CHANGE');
    expect(first.counts).toEqual({ ADDED: 0, CHANGED: 0, UNCHANGED: 1, MISSING_FROM_SOURCE: 0 });

    const older = structuredClone(previous);
    older.readTime = '2026-09-20T10:00:00Z';
    const { digest: _digest, ...unsigned } = older;
    older.digest = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
    expect(() => compareErp5ProductCaptures(previous, older)).toThrow('CAPTURE_ORDER_INVALID');
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
    const dryRun = buildErp5CanonicalDryRun(capture);
    expect(dryRun.publicationGate).toMatchObject({
      decision: 'HOLD',
      activeReleaseAuthorized: false,
      sourceCoverage: { mode: 'FULL', completeness: 'COMPLETE', observedProducts: 0, candidateProducts: 0 },
      reviewCoverage: { mappedForReview: 0, mappingHold: 0, approvedCanonicalProducts: 0 }
    });
    expect(dryRun.publicationGate.reasons).toEqual(expect.arrayContaining([
      'SOURCE_CATALOG_EMPTY',
      'NO_CANDIDATES_READY_FOR_REVIEW',
      'REVIEW_APPROVALS_NOT_INCLUDED',
      'CANONICAL_RELEASE_NOT_BUILT'
    ]));
  });
  it('keeps a fully mapped review candidate on publication HOLD until approval and release evidence exist', async () => {
    const capture = await captureErp5Source(fake().rpc);
    const dryRun = buildErp5CanonicalDryRun(capture);
    expect(dryRun.counts).toEqual({ sourceProducts: 1, candidates: 1, mappedForReview: 1, hold: 0 });
    expect(dryRun.publicationGate).toMatchObject({
      decision: 'HOLD',
      activeReleaseAuthorized: false,
      reviewCoverage: { mappedForReview: 1, mappingHold: 0, approvedCanonicalProducts: 0 }
    });
    expect(dryRun.publicationGate.reasons).not.toContain('MAPPING_HOLD_PRESENT');
    expect(dryRun.publicationGate.reasons).not.toContain('NO_CANDIDATES_READY_FOR_REVIEW');
    expect(dryRun.publicationGate.reasons).toEqual(expect.arrayContaining([
      'REVIEW_APPROVALS_NOT_INCLUDED',
      'CANONICAL_RELEASE_NOT_BUILT'
    ]));
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
