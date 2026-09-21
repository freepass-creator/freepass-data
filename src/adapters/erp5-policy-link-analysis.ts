import type { Erp5SourceCapture } from './erp5-source-capture.js';
import { decodeErp5Value, ERP5_DOCUMENTS } from './erp5-source-capture.js';
import { createHash } from 'node:crypto';

export const ERP5_POLICY_LINK_ANALYZER_VERSION = 'erp5-policy-link-analysis/1';
type Raw = Record<string, unknown>;
const object = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value === value.trim();
const INVALID = Symbol('INVALID_FIRESTORE_FIELD');
function field(fields: unknown, key: string): unknown {
  if (!object(fields) || !Object.hasOwn(fields, key)) return undefined;
  try { return decodeErp5Value(fields[key]); } catch { return INVALID; }
}
function documentId(document: Raw, collection: 'products' | 'policy'): string {
  const prefix = `${ERP5_DOCUMENTS}/${collection}/`;
  if (!object(document) || typeof document.name !== 'string' || !document.name.startsWith(prefix)
    || (document.fields !== undefined && !object(document.fields))) throw new Error('INVALID_CAPTURE_DOCUMENT');
  const id = document.name.slice(prefix.length);
  if (!text(id) || id.includes('/')) throw new Error('INVALID_CAPTURE_DOCUMENT');
  return id;
}
function relaxed(value: string): string {
  return value.toUpperCase().replace(/(^|[^0-9])0+([0-9])/g, '$1$2');
}

/**
 * Produces counts only. It never returns policy codes, document IDs or source values.
 * Exact matches are review candidates; relaxed matches are evidence of a possible alias only.
 */
export function analyzeErp5PolicyLinks(capture: Erp5SourceCapture) {
  const { digest, ...unsigned } = capture;
  const expectedDigest = createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  if (capture.version !== 'erp5-source-capture/1' || digest !== expectedDigest) throw new Error('CAPTURE_DIGEST_MISMATCH');
  if (capture.projectId !== 'freepasserp5' || capture.databaseId !== '(default)'
    || capture.consistency !== 'READ_ONLY_TRANSACTION') throw new Error('INVALID_CAPTURE');
  if (!object(capture.collections) || !object(capture.collections.products) || !object(capture.collections.policy)
    || !Array.isArray(capture.collections.products.documents) || !Array.isArray(capture.collections.policy.documents)
    || capture.collections.products.count !== capture.collections.products.documents.length
    || capture.collections.policy.count !== capture.collections.policy.documents.length) throw new Error('INVALID_CAPTURE_COVERAGE');
  const exact = new Map<string, Set<number>>();
  const aliases = new Map<string, Set<number>>();
  const inactive = new Set<number>();
  const unusable = new Set<number>();
  const conflicting = new Set<number>();
  let invalidPolicyIdentity = 0;
  const policies = capture.collections.policy.documents;
  policies.forEach((document, index) => {
    const id = documentId(document, 'policy');
    const key = field(document.fields, '_key');
    const code = field(document.fields, 'policy_code');
    if ((key !== undefined && !text(key)) || (code !== undefined && !text(code))) {
      invalidPolicyIdentity++; unusable.add(index);
    }
    const identifiers = [id, ...(text(key) ? [key] : []), ...(text(code) ? [code] : [])];
    if ((text(key) && key !== id) || (text(code) && code !== id && code !== key)) conflicting.add(index);
    for (const identifier of new Set(identifiers)) {
      const set = exact.get(identifier) ?? new Set<number>(); set.add(index); exact.set(identifier, set);
      const normalized = relaxed(identifier);
      const aliasSet = aliases.get(normalized) ?? new Set<number>(); aliasSet.add(index); aliases.set(normalized, aliasSet);
    }
    const deleted = field(document.fields, '_deleted');
    const active = field(document.fields, 'is_active');
    if (deleted === INVALID || active === INVALID
      || (deleted !== undefined && typeof deleted !== 'boolean')
      || (active !== undefined && typeof active !== 'boolean')) unusable.add(index);
    if (deleted === true || active === false) inactive.add(index);
  });

  const referenced = new Set<number>();
  const productReferences = {
    total: capture.collections.products.count, unset: 0, invalid: 0, exactLinkedForReview: 0,
    exactAmbiguous: 0, exactInactive: 0, aliasOrZeroPaddingCandidate: 0, missing: 0
  };
  for (const document of capture.collections.products.documents) {
    documentId(document, 'products');
    const code = field(document.fields, 'policy_code');
    if (code === undefined || code === null || code === '') { productReferences.unset++; continue; }
    if (!text(code)) { productReferences.invalid++; continue; }
    const matches = exact.get(code);
    if (matches?.size === 1) {
      const [index] = matches;
      referenced.add(index!);
      if (inactive.has(index!) || unusable.has(index!)) productReferences.exactInactive++;
      else productReferences.exactLinkedForReview++;
      continue;
    }
    if (matches && matches.size > 1) { matches.forEach(index => referenced.add(index)); productReferences.exactAmbiguous++; continue; }
    const candidates = aliases.get(relaxed(code));
    if (candidates?.size) { candidates.forEach(index => referenced.add(index)); productReferences.aliasOrZeroPaddingCandidate++; }
    else productReferences.missing++;
  }

  let duplicateExactIdentifiers = 0;
  for (const matches of exact.values()) if (matches.size > 1) duplicateExactIdentifiers++;
  const categorized = Object.entries(productReferences)
    .filter(([key]) => key !== 'total').reduce((sum, [, count]) => sum + count, 0);
  if (categorized !== productReferences.total) throw new Error('INCOMPLETE_POLICY_REFERENCE_CLASSIFICATION');
  return {
    status: 'HOLD' as const, canonicalWriteAuthorized: false as const, cutoverAuthorized: false as const,
    analyzerVersion: ERP5_POLICY_LINK_ANALYZER_VERSION, sourceDigest: capture.digest, readTime: capture.readTime,
    policyDocuments: policies.length, invalidPolicyIdentity, conflictingPolicyIdentifiers: conflicting.size,
    inactivePolicyDocuments: inactive.size, unusablePolicyDocuments: unusable.size, duplicateExactIdentifiers,
    referencedPolicyDocuments: referenced.size, unreferencedPolicyDocuments: policies.length - referenced.size,
    productReferences,
    remaining: ['POLICY_FACT_SEMANTICS_UNREVIEWED', 'ALIASES_AND_ZERO_PADDING_REQUIRE_EXPLICIT_AUTHORITY',
      'EXACT_LINKS_REQUIRE_CANONICAL_POLICY_REVIEW', 'NO_CANONICAL_WRITE_OR_CONSUMER_CUTOVER']
  };
}
