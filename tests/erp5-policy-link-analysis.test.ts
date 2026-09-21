import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { analyzeErp5PolicyLinks } from '../src/adapters/erp5-policy-link-analysis.js';
import { ERP5_DOCUMENTS, type Erp5SourceCapture } from '../src/adapters/erp5-source-capture.js';

const value = (x: string | boolean) => typeof x === 'boolean' ? { booleanValue: x } : { stringValue: x };
const doc = (collection: 'products' | 'policy', id: string, fields: Record<string, unknown>) => ({
  name: `${ERP5_DOCUMENTS}/${collection}/${id}`, createTime: '2026-09-21T00:00:00Z',
  updateTime: '2026-09-21T00:00:00Z', fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, value(v as string | boolean)]))
});
function capture(products: RawDoc[], policies: RawDoc[]): Erp5SourceCapture {
  const unsigned = { version: 'erp5-source-capture/1' as const, projectId: 'freepasserp5' as const, databaseId: '(default)' as const,
    consistency: 'READ_ONLY_TRANSACTION' as const, readTime: '2026-09-21T00:00:00Z', capturedAt: '2026-09-21T00:00:01Z',
    collections: { products: { count: products.length, documents: products }, policy: { count: policies.length, documents: policies } } };
  return { ...unsigned, digest: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') };
}
type RawDoc = ReturnType<typeof doc>;

describe('ERP5 policy link evidence', () => {
  it('separates exact, inactive, alias, missing, unset and invalid references without exposing codes', () => {
    const policies = [
      doc('policy', 'RP004', { _key: 'RP004', policy_code: 'RP004' }),
      doc('policy', 'RP005', { _key: 'RP005', policy_code: 'RP005', _deleted: true }),
      doc('policy', 'RP006', { _key: 'RP006', policy_code: 'RP006' })
    ];
    const products = [
      doc('products', 'p1', { policy_code: 'RP004' }), doc('products', 'p2', { policy_code: 'RP005' }),
      doc('products', 'p3', { policy_code: 'rp0006' }), doc('products', 'p4', { policy_code: 'RP999' }),
      doc('products', 'p5', {}), doc('products', 'p6', { policy_code: true })
    ];
    const report = analyzeErp5PolicyLinks(capture(products, policies));
    expect(report.productReferences).toEqual({ total: 6, unset: 1, invalid: 1, exactLinkedForReview: 1,
      exactAmbiguous: 0, exactInactive: 1, aliasOrZeroPaddingCandidate: 1, missing: 1 });
    expect(report).not.toHaveProperty('codes');
    expect(JSON.stringify(report)).not.toContain('RP004');
    expect(report.canonicalWriteAuthorized).toBe(false);
  });

  it('holds duplicated identifiers and conflicting document/key/code identities', () => {
    const report = analyzeErp5PolicyLinks(capture(
      [doc('products', 'p1', { policy_code: 'SHARED' })],
      [doc('policy', 'a', { _key: 'SHARED', policy_code: 'A' }), doc('policy', 'b', { _key: 'SHARED', policy_code: 'B' })]
    ));
    expect(report.productReferences.exactAmbiguous).toBe(1);
    expect(report.duplicateExactIdentifiers).toBe(1);
    expect(report.conflictingPolicyIdentifiers).toBe(2);
    expect(report.status).toBe('HOLD');
  });

  it('does not treat an alias candidate as an exact link or authorize cutover', () => {
    const report = analyzeErp5PolicyLinks(capture(
      [doc('products', 'p1', { policy_code: 'rp0004' })], [doc('policy', 'RP004', { policy_code: 'RP004' })]
    ));
    expect(report.productReferences.exactLinkedForReview).toBe(0);
    expect(report.productReferences.aliasOrZeroPaddingCandidate).toBe(1);
    expect(report.cutoverAuthorized).toBe(false);
  });

  it('rejects a capture whose declared coverage differs from its documents', () => {
    const input = capture([], [doc('policy', 'RP004', { policy_code: 'RP004' })]);
    input.collections.policy.count = 2;
    expect(() => analyzeErp5PolicyLinks(input)).toThrow('CAPTURE_DIGEST_MISMATCH');
  });

  it('rejects changed evidence before classifying policy links', () => {
    const input = capture([doc('products', 'p1', { policy_code: 'RP004' })], [doc('policy', 'RP004', { policy_code: 'RP004' })]);
    (input.collections.products.documents[0]!.fields as Record<string, unknown>).policy_code = { stringValue: 'CHANGED' };
    expect(() => analyzeErp5PolicyLinks(input)).toThrow('CAPTURE_DIGEST_MISMATCH');
  });

  it('fails closed on malformed source types instead of aborting or linking them', () => {
    const policy = doc('policy', 'RP004', { policy_code: 'RP004' });
    policy.fields.is_active = { stringValue: 'yes' };
    const product = doc('products', 'p1', { policy_code: 'RP004' });
    const invalidProduct = doc('products', 'p2', {});
    (invalidProduct.fields as Record<string, unknown>).policy_code = { timestampValue: '2026-09-21T00:00:00Z' };
    const report = analyzeErp5PolicyLinks(capture([product, invalidProduct], [policy]));
    expect(report.unusablePolicyDocuments).toBe(1);
    expect(report.productReferences.exactInactive).toBe(1);
    expect(report.productReferences.invalid).toBe(1);
  });
});
