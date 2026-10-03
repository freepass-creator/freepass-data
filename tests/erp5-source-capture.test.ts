import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { analyzeErp5Deposits } from '../src/adapters/erp5-deposit-analysis.js';
import { buildErp5CanonicalDryRun, captureErp5Source, compareErp5ProductCaptures, decodeErp5Value, erp5ReadTransport, inspectErp5Capture, readErp5PolicyFacts, parseAnnualMileageText, profileErp5CaptureFields, summarizeErp5DecisionInputs, ERP5_DOCUMENTS } from '../src/adapters/erp5-source-capture.js';
const readTime = '2026-09-21T10:00:00.123456Z';
function doc(collection = 'products', id = 'synthetic') {
  return {
    name: `${ERP5_DOCUMENTS}/${collection}/${id}`,
    createTime: '2026-09-20T10:00:00Z', updateTime: '2026-09-21T09:59:00Z',
    fields: collection === 'products' ? {
      car_number: { stringValue: '12가3456' }, maker: { stringValue: '합성제조사' }, model: { stringValue: '합성모델' },
      provider_company_code: { stringValue: 'SYNTHETIC' }, product_type: { stringValue: '중고렌트' },
      vehicle_status: { stringValue: '출고가능' }, status_kind: { stringValue: '가용' }, listable: { booleanValue: true },
      deposit_note: { stringValue: '무보증' },
      price: { mapValue: { fields: { '24_3만': { mapValue: { fields: { rent: { integerValue: '750000' }, deposit: { integerValue: '0' } } } } } } }
    } : {}
  };
}
function fake(options: { products?: Record<string, unknown>[]; policies?: Record<string, unknown>[]; drift?: boolean; failPolicy?: boolean; count?: string; extraRow?: unknown } = {}) {
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
    const documents = collection === 'products' ? products : collection === 'policy' ? options.policies ?? [doc(collection)] : [doc(collection)];
    if (collection === 'policy' && options.failPolicy) throw new Error('synthetic failure');
    if (method === 'runAggregationQuery') return [{ readTime: options.drift && collection === 'policy' ? '2026-09-21T10:01:00Z' : readTime,
      result: { aggregateFields: { total: { integerValue: options.count ?? String(documents.length) } } } }];
    const rows: unknown[] = documents.map(document => ({ readTime, document }));
    if (!rows.length) rows.push({ readTime });
    if (options.extraRow) rows.push(options.extraRow);
    return rows;
  };
  return { calls, rpc };
}

describe('ERP5 same-transaction raw capture', () => {
  it('audits deposit fields across full coverage despite unrelated unsupported metadata', async () => {
    const row = doc();
    (row.fields as Record<string, unknown>).unrelated = { timestampValue: '2026-09-21T09:00:00Z' };
    const capture = await captureErp5Source(fake({ products: [row] }).rpc);
    const before = JSON.stringify(capture);
    const audit = analyzeErp5Deposits(capture);
    expect(audit).toMatchObject({ productCount: 1, paidTermCount: 1, counts: { ZERO: 1, UNKNOWN: 0, KNOWN: 0 }, decodeFailures: [], writeAuthorized: false, decision: 'HOLD' });
    expect(audit.findings[0]).toMatchObject({ productId: 'synthetic', termKey: '24_3만', depositStatusLabel: '무보증' });
    expect(JSON.stringify(capture)).toBe(before);
    expect(() => analyzeErp5Deposits({ ...capture, digest: '0'.repeat(64) })).toThrow('CAPTURE_DIGEST_MISMATCH');
  });
  it('uses a read-only transaction and independent counts for full products and policy', async () => {
    const { rpc, calls } = fake();
    const capture = await captureErp5Source(rpc);
    expect(calls[0]).toEqual({ method: 'beginTransaction', body: { options: { readOnly: {} } } });
    expect(calls.map(c => c.method)).toEqual(['beginTransaction', 'runAggregationQuery', 'runQuery', 'runAggregationQuery', 'runQuery', 'runAggregationQuery', 'runQuery', 'rollback']);
    expect(capture.readTime).toBe(readTime);
    expect(capture.collections.products.documents[0]).toEqual(doc());
    expect(JSON.stringify(capture)).not.toContain('synthetic-private-transaction');
    const report = inspectErp5Capture(capture);
    expect(report.mappedForReview).toBe(1);
    expect(report.partners).toBe(1);
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

  it('accepts a digest-valid pre-partner capture only as the previous product-delta baseline', async () => {
    const previous = await captureErp5Source(fake({
      products: [doc('products', 'same'), doc('products', 'legacy-only')]
    }).rpc);
    const legacy = structuredClone(previous) as any;
    delete legacy.collections.partner;
    const { digest: _legacyDigest, ...legacyUnsigned } = legacy;
    legacy.digest = createHash('sha256')
      .update(JSON.stringify(legacyUnsigned))
      .digest('hex');

    const current = await captureErp5Source(fake({
      products: [doc('products', 'same'), doc('products', 'new-only')]
    }).rpc);

    const delta = compareErp5ProductCaptures(legacy, current);
    expect(delta.counts).toEqual({
      ADDED: 1,
      CHANGED: 0,
      UNCHANGED: 1,
      MISSING_FROM_SOURCE: 1
    });
    expect(delta.destructiveActionAuthorized).toBe(false);
  });

  it('still rejects a current capture that omits partner even when its digest is recomputed', async () => {
    const previous = await captureErp5Source(fake().rpc);
    const current = structuredClone(previous) as any;
    delete current.collections.partner;
    const { digest: _digest, ...unsigned } = current;
    current.digest = createHash('sha256')
      .update(JSON.stringify(unsigned))
      .digest('hex');

    expect(() => compareErp5ProductCaptures(previous, current))
      .toThrow('INVALID_CAPTURE_COVERAGE');
  });

  it('rejects damaged or expanded legacy delta baselines instead of weakening coverage checks', async () => {
    const current = await captureErp5Source(fake().rpc);

    const badCount = structuredClone(current) as any;
    delete badCount.collections.partner;
    badCount.collections.products.count += 1;
    {
      const { digest: _digest, ...unsigned } = badCount;
      badCount.digest = createHash('sha256')
        .update(JSON.stringify(unsigned))
        .digest('hex');
    }
    expect(() => compareErp5ProductCaptures(badCount, current))
      .toThrow('INVALID_CAPTURE_COVERAGE');

    const unknownCollection = structuredClone(current) as any;
    delete unknownCollection.collections.partner;
    unknownCollection.collections.unknown = {
      count: 0,
      documents: []
    };
    {
      const { digest: _digest, ...unsigned } = unknownCollection;
      unknownCollection.digest = createHash('sha256')
        .update(JSON.stringify(unsigned))
        .digest('hex');
    }
    expect(() => compareErp5ProductCaptures(unknownCollection, current))
      .toThrow('INVALID_CAPTURE_COVERAGE');
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
  it('keeps a policy whose only timestamp is updated_at metadata, without changing the capture', async () => {
    const policy = doc('policy', 'synthetic-private-policy');
    Object.assign(policy.fields, { updated_at: { timestampValue: readTime }, annual_mileage: { integerValue: '30000' } });
    const capture = await captureErp5Source(fake({ policies: [policy] }).rpc);
    const before = JSON.stringify(capture);
    const report = inspectErp5Capture(capture);
    expect(readErp5PolicyFacts(capture)).toEqual([{ policyCode: 'synthetic-private-policy', annualMileageKm: 30000 }]);
    expect(report.policyFactCoverage).toMatchObject({
      sourceDocuments: 1, factsProduced: 1, skippedDocuments: 0, decodeFailureCounts: {},
      skippedWithTopLevelTimestampFields: 0, factsWithAnnualMileage: 1
    });
    expect(JSON.stringify(report)).not.toContain('synthetic-private-policy');
    expect(JSON.stringify(capture)).toBe(before);
    expect(report.cutoverAuthorized).toBe(false);
  });
  it('still skips a policy with a timestamp outside the metadata allowlist or nested in a map', async () => {
    const created = doc('policy', 'created-at');
    Object.assign(created.fields, { created_at: { timestampValue: readTime } });
    const nested = doc('policy', 'nested');
    Object.assign(nested.fields, { meta: { mapValue: { fields: { updated_at: { timestampValue: readTime } } } } });
    const capture = await captureErp5Source(fake({ policies: [created, nested] }).rpc);
    expect(readErp5PolicyFacts(capture)).toEqual([]);
    expect(inspectErp5Capture(capture).policyFactCoverage).toMatchObject({
      sourceDocuments: 2, factsProduced: 0, skippedDocuments: 2,
      decodeFailureCounts: { UNSUPPORTED_FIRESTORE_VALUE: 2 }, skippedWithTopLevelTimestampFields: 1
    });
  });
  it('distinguishes explicit zero, parsed text, uninterpreted units and missing policy mileage', async () => {
    const policies = ['numeric', 'text', 'monthly', 'missing'].map(id => doc('policy', id));
    Object.assign(policies[0]!.fields, { annual_mileage: { integerValue: '0' } });
    Object.assign(policies[1]!.fields, { annual_mileage: { stringValue: '연 30,000km' } });
    Object.assign(policies[2]!.fields, { annual_mileage: { stringValue: '월 2,500km' } });
    const capture = await captureErp5Source(fake({ policies }).rpc);
    const facts = readErp5PolicyFacts(capture);
    expect(facts.find(x => x.policyCode === 'numeric')?.annualMileageKm).toBe(0);
    expect(facts.find(x => x.policyCode === 'text')?.annualMileageKm).toBe(30000);
    expect(facts.find(x => x.policyCode === 'monthly')).not.toHaveProperty('annualMileageKm');
    expect(inspectErp5Capture(capture).policyFactCoverage).toMatchObject({
      sourceDocuments: 4, factsProduced: 4, skippedDocuments: 0,
      factsWithAnnualMileage: 2, factsWithAnnualMileageParsedFromText: 1,
      factsWithUninterpretedAnnualMileage: 1, uninterpretedAnnualMileageReasons: { MONTHLY_UNIT: 1 },
      factsMissingAnnualMileage: 1
    });
  });
  it('parses only unambiguous annual mileage text', () => {
    expect(['30000', '30,000km', '연 30,000km', '연간 3만km', '3만 ㎞', '25000 KM', '3만키로', '30000킬로미터']
      .map(parseAnnualMileageText))
      .toEqual([{ km: 30000 }, { km: 30000 }, { km: 30000 }, { km: 30000 }, { km: 30000 }, { km: 25000 }, { km: 30000 }, { km: 30000 }]);
    for (const text of ['3만', '연3만', '03만km', '030000', '30000원', '3만원', '연3회', '30000km/년']) {
      expect(parseAnnualMileageText(text), text).toEqual({ reason: 'UNRECOGNIZED' });
    }
    expect(Object.fromEntries(['월 2,500km', '무제한', '2만~3만km', '20000 / 30000', '0km', '2.5만km', '3만km 이상']
      .map(text => [text, parseAnnualMileageText(text)]))).toEqual({
      '월 2,500km': { reason: 'MONTHLY_UNIT' },
      무제한: { reason: 'UNLIMITED' },
      '2만~3만km': { reason: 'RANGE_OR_MULTIPLE' },
      '20000 / 30000': { reason: 'RANGE_OR_MULTIPLE' },
      '0km': { reason: 'NON_POSITIVE' },
      '2.5만km': { reason: 'UNRECOGNIZED' },
      '3만km 이상': { reason: 'UNRECOGNIZED' },
    });
  });
  it('exposes inactive facts already emitted by the reader rather than silently changing eligibility', async () => {
    const policy = doc('policy', 'inactive-synthetic');
    Object.assign(policy.fields, { _deleted: { booleanValue: true }, annual_mileage: { integerValue: '20000' } });
    const capture = await captureErp5Source(fake({ policies: [policy] }).rpc);
    expect(readErp5PolicyFacts(capture)).toEqual([{ policyCode: 'inactive-synthetic', annualMileageKm: 20000 }]);
    const report = inspectErp5Capture(capture);
    expect(report.policyFactCoverage.explicitInactiveFactsProduced).toBe(1);
    expect(report.status).toBe('HOLD');
    expect(report.canonicalWriteAuthorized).toBe(false);
  });
  it('reports duplicate codes, fallback codes and explicit empty values without changing fact order', async () => {
    const policies = ['first', 'second', 'fallback'].map(id => doc('policy', id));
    Object.assign(policies[0]!.fields, { policy_code: { stringValue: 'same' }, annual_mileage: { nullValue: null } });
    Object.assign(policies[1]!.fields, { policy_code: { stringValue: ' same ' }, annual_mileage: { stringValue: '' } });
    const capture = await captureErp5Source(fake({ policies }).rpc);
    // The immutable capture sorts documents by name before the reader sees them.
    expect(readErp5PolicyFacts(capture).map(x => x.policyCode)).toEqual(['fallback', 'same', 'same']);
    const coverage = inspectErp5Capture(capture).policyFactCoverage;
    expect(coverage).toMatchObject({ factsUsingDocumentIdAsPolicyCode: 1, duplicatePolicyCodes: 1,
      extraFactsWithDuplicatePolicyCode: 1, factsMissingAnnualMileage: 3,
      annualMileageAbsent: 1, annualMileageNull: 1, annualMileageEmptyString: 1 });
    expect(coverage.sourceDocuments).toBe(coverage.factsProduced + coverage.skippedDocuments);
    expect(coverage.factsProduced).toBe(coverage.factsWithAnnualMileage + coverage.factsWithUninterpretedAnnualMileage + coverage.factsMissingAnnualMileage);
  });
  it('exposes explicit age strings without treating them as missing or approving a default age', async () => {
    const policies = ['age-number', 'age-text', 'age-missing'].map(id => doc('policy', id));
    Object.assign(policies[0]!.fields, { basic_driver_age: { integerValue: '26' } });
    Object.assign(policies[1]!.fields, { basic_driver_age: { stringValue: '만 26세 이상' } });
    const capture = await captureErp5Source(fake({ policies }).rpc);
    const facts = readErp5PolicyFacts(capture);
    expect(facts.find(x => x.policyCode === 'age-number')?.basicDriverAge).toBe(26);
    expect(facts.find(x => x.policyCode === 'age-text')).not.toHaveProperty('basicDriverAge');
    expect(facts.find(x => x.policyCode === 'age-missing')).not.toHaveProperty('basicDriverAge');
    const report = inspectErp5Capture(capture);
    expect(report.policyFactCoverage).toMatchObject({
      factsWithBasicDriverAge: 1, factsWithUninterpretedBasicDriverAge: 1, factsMissingBasicDriverAge: 1
    });
    const c = report.policyFactCoverage;
    expect(c.factsProduced).toBe(c.factsWithBasicDriverAge + c.factsWithUninterpretedBasicDriverAge + c.factsMissingBasicDriverAge);
    expect(report.status).toBe('HOLD');
    expect(report.canonicalWriteAuthorized).toBe(false);
  });
  it('limits timestamp diagnostics to top-level co-occurrence rather than a failure cause', async () => {
    const nested = doc('policy', 'nested');
    Object.assign(nested.fields, { metadata: { mapValue: { fields: { at: { timestampValue: readTime } } } } });
    const otherCause = doc('policy', 'other');
    Object.assign(otherCause.fields, { unsupported: { bytesValue: 'AA==' }, at: { timestampValue: readTime } });
    const capture = await captureErp5Source(fake({ policies: [nested, otherCause] }).rpc);
    expect(readErp5PolicyFacts(capture)).toEqual([]);
    expect(inspectErp5Capture(capture).policyFactCoverage).toMatchObject({
      skippedDocuments: 2, skippedWithTopLevelTimestampFields: 1,
      decodeFailureCounts: { UNSUPPORTED_FIRESTORE_VALUE: 2 }
    });
  });
  it.each([
    { is_active: { booleanValue: false } },
    { status: { stringValue: 'deleted' } },
    { status: { stringValue: 'retired' } }
  ])('counts only the explicit inactive markers it supports: %j', async fields => {
    const policy = doc('policy', 'inactive');
    Object.assign(policy.fields, fields);
    const capture = await captureErp5Source(fake({ policies: [policy] }).rpc);
    expect(inspectErp5Capture(capture).policyFactCoverage.explicitInactiveFactsProduced).toBe(1);
    expect(readErp5PolicyFacts(capture)).toHaveLength(1);
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
  it('fails before any network call when the live read token is missing', async () => {
    const fetcher = vi.fn();
    expect(() => erp5ReadTransport('', fetcher as typeof fetch))
      .toThrow('MISSING_READ_ACCESS_TOKEN');
    expect(fetcher).not.toHaveBeenCalled();
  });
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

describe('decision inputs', () => {
  const product = (id: string, fields: Record<string, unknown>) => ({
    name: `${ERP5_DOCUMENTS}/products/${id}`,
    createTime: '2026-09-01T00:00:00.000000Z',
    updateTime: '2026-09-01T00:00:00.000000Z',
    fields
  });
  const s = (stringValue: string) => ({ stringValue });
  const map = (fields: Record<string, unknown>) => ({ mapValue: { fields } });

  function captureOf(products: unknown[], policyIds: string[] = []) {
    const unsigned = {
      version: 'erp5-source-capture/1' as const,
      projectId: 'freepasserp5' as const,
      databaseId: '(default)' as const,
      consistency: 'READ_ONLY_TRANSACTION' as const,
      readTime: '2026-09-27T00:00:00.000000Z',
      capturedAt: '2026-09-27T00:00:01.000Z',
      collections: {
        products: { count: products.length, documents: products },
        policy: {
          count: policyIds.length,
          documents: policyIds.map((id) => ({
            name: `${ERP5_DOCUMENTS}/policy/${id}`,
            createTime: '2026-09-01T00:00:00.000000Z',
            updateTime: '2026-09-01T00:00:00.000000Z',
            fields: {}
          }))
        },
        partner: { count: 0, documents: [] }
      }
    };
    return { ...unsigned, digest: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') } as never;
  }

  it('counts the codes that decisions depend on', () => {
    const result = summarizeErp5DecisionInputs(captureOf([
      product('a', { product_type: s('구독'), source_bucket: s('SON_NO_KONG'), provider_company_code: s('RP012') }),
      product('b', { product_type: s('구독'), source_bucket: s('TCAR_EXTERNAL'), provider_company_code: s('RP012') }),
      product('c', { product_type: s('렌트'), provider_company_code: s('RP023') })
    ]));
    expect(result.productType).toEqual({ 구독: 2, 렌트: 1 });
    expect(result.sourceBucket).toEqual({ SON_NO_KONG: 1, TCAR_EXTERNAL: 1, '(없음)': 1 });
    expect(result.providerCompanyCode).toEqual({ RP012: 2, RP023: 1 });
  });

  it('separates price keys that carry a mileage limit from those that do not', () => {
    const result = summarizeErp5DecisionInputs(captureOf([
      product('a', { price: map({ '36': map({ rent: { integerValue: '500000' } }) }) }),
      product('b', { price: map({ '36_2만': map({ rent: { integerValue: '520000' } }) }) }),
      product('c', { price: map({ '월정액': map({ rent: { integerValue: '400000' } }) }) }),
      product('d', {})
    ]));
    expect(result.priceKeyShape).toEqual({ 개월만: 1, 개월_주행거리: 1, '해석 불가': 1, '(가격 없음)': 1 });
    expect(result.priceKey['36_2만']).toBe(1);
    expect(result.priceTermField).toEqual({ rent: 3 });
  });

  it('says whether a policy code actually resolves to a policy document', () => {
    const result = summarizeErp5DecisionInputs(captureOf([
      product('a', { policy_code: s('P-1') }),
      product('b', { policy_code: s('P-1') }),
      product('c', { policy_code: s('P-없음') }),
      product('d', {})
    ], ['P-1', 'P-2']));
    expect(result.version).toBe('erp5-decision-inputs/2');
    expect(result.policyLink).toEqual({ matched: 2, unmatched: 1, absent: 1, policyDocuments: 2 });
  });

  it('counts free text without ever quoting it', () => {
    const secret = '고객 김철수 요청: 보증금 면제';
    const result = summarizeErp5DecisionInputs(captureOf([
      product('a', { deposit_note: s(secret) }),
      product('b', { deposit_note: s('다른 메모'), quotes: s('견적 메모') })
    ]));
    expect(result.freeTextFieldPresence).toEqual({ deposit_note: 2, quotes: 1 });
    expect(JSON.stringify(result)).not.toContain('김철수');
    expect(JSON.stringify(result)).not.toContain('보증금 면제');
  });
});

describe('policy skeleton', () => {
  const policyDoc = (id: string, fields: Record<string, unknown>) => ({
    name: `${ERP5_DOCUMENTS}/policy/${id}`,
    createTime: '2026-09-01T00:00:00.000000Z',
    updateTime: '2026-09-01T00:00:00.000000Z',
    fields
  });

  function captureWithPolicies(policies: unknown[]) {
    const unsigned = {
      version: 'erp5-source-capture/1' as const,
      projectId: 'freepasserp5' as const,
      databaseId: '(default)' as const,
      consistency: 'READ_ONLY_TRANSACTION' as const,
      readTime: '2026-09-27T00:00:00.000000Z',
      capturedAt: '2026-09-27T00:00:01.000Z',
      collections: {
        products: { count: 0, documents: [] },
        policy: { count: policies.length, documents: policies },
        partner: { count: 0, documents: [] }
      }
    };
    return { ...unsigned, digest: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') } as never;
  }

  it('reports which fields a policy carries, so mileage can be found', () => {
    const result = summarizeErp5DecisionInputs(captureWithPolicies([
      policyDoc('P-1', { mileage_limit: { integerValue: '20000' }, provider_company_code: { stringValue: 'RP012' } }),
      policyDoc('P-2', { mileage_limit: { integerValue: '30000' }, provider_company_code: { stringValue: 'RP023' } }),
      policyDoc('P-3', { provider_company_code: { stringValue: 'RP012' } })
    ]));
    expect(result.policyFieldPaths).toEqual({ mileage_limit: 2, provider_company_code: 3 });
    expect(result.policyCompanyCodes.provider_company_code).toEqual({ RP012: 2, RP023: 1 });
  });

  it('counts company codes but never long policy text', () => {
    const sentence = '이 정책은 고객 김철수에게 적용되며 보증금을 면제한다';
    const result = summarizeErp5DecisionInputs(captureWithPolicies([
      policyDoc('P-1', { company_note: { stringValue: sentence }, provider_company_code: { stringValue: 'RP012' } })
    ]));
    expect(result.policyFieldPaths.company_note).toBe(1);
    expect(JSON.stringify(result)).not.toContain('김철수');
  });
});
