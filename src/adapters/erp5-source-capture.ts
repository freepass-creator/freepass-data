import { mapErp5Product, ERP5_PRODUCT_MAPPER_VERSION, type Erp5PolicyFacts } from './erp5-product-mapping.js';
import { orderedJsonDigest } from '../shared/stable-digest.js';
import type { SourceIntakeBatch } from '../domain/source-intake.js';

export const ERP5_DOCUMENTS = 'projects/freepasserp5/databases/(default)/documents';
const collections = ['products', 'policy', 'partner'] as const;
type Collection = typeof collections[number];
type ObjectValue = Record<string, unknown>;
export type Erp5ReadRpc = (method: 'beginTransaction' | 'runQuery' | 'runAggregationQuery' | 'rollback', body: ObjectValue) => Promise<unknown>;
const object = (x: unknown): x is ObjectValue => !!x && typeof x === 'object' && !Array.isArray(x);
function fail(code: string): never { throw new Error(code); }
const hash = orderedJsonDigest;
const time = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(x) && Number.isFinite(Date.parse(x));

export type Erp5SourceCapture = {
  version: 'erp5-source-capture/1'; projectId: 'freepasserp5'; databaseId: '(default)';
  consistency: 'READ_ONLY_TRANSACTION'; readTime: string; capturedAt: string;
  collections: Record<Collection, { count: number; documents: ObjectValue[] }>;
  digest: string;
};

/** Only the four allowlisted RPCs exist. No fallback, custom host, document writes or runtime bootstrap. */
export function erp5ReadTransport(accessToken: string, fetcher: typeof fetch = fetch): Erp5ReadRpc {
  if (!accessToken.trim()) fail('MISSING_READ_ACCESS_TOKEN');
  return async (method, body) => {
    if (!['beginTransaction', 'runQuery', 'runAggregationQuery', 'rollback'].includes(method)) fail('FORBIDDEN_RPC');
    const response = await fetcher(`https://firestore.googleapis.com/v1/${ERP5_DOCUMENTS}:${method}`, {
      method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: 'error'
    });
    if (!response.ok) fail(`ERP5_READ_HTTP_${response.status}`);
    return response.json();
  };
}

/** Complete collections and independent COUNT(*) in the same read-only transaction. */
export async function captureErp5Source(rpc: Erp5ReadRpc): Promise<Erp5SourceCapture> {
  const started = await rpc('beginTransaction', { options: { readOnly: {} } });
  if (!object(started) || typeof started.transaction !== 'string' || !started.transaction) fail('MISSING_READ_TRANSACTION');
  const transaction = started.transaction;
  try {
    let readTime: string | undefined;
    const result = {} as Erp5SourceCapture['collections'];
    for (const collection of collections) {
      const structuredQuery = { from: [{ collectionId: collection }] };
      const counts = await rpc('runAggregationQuery', {
        transaction, structuredAggregationQuery: { structuredQuery, aggregations: [{ alias: 'total', count: {} }] }
      });
      if (!Array.isArray(counts) || counts.length !== 1 || !object(counts[0])) fail('INVALID_COUNT_RESPONSE');
      const countResponse = counts[0];
      const countResult = countResponse.result;
      const fields = object(countResult) ? countResult.aggregateFields : null;
      const countValue = object(fields) ? fields.total : null;
      const countText = object(countValue) ? countValue.integerValue : null;
      if (typeof countText !== 'string' || !/^(0|[1-9]\d*)$/.test(countText)
        || !Number.isSafeInteger(Number(countText)) || !time(countResponse.readTime)) fail('INVALID_COUNT_EVIDENCE');
      if (readTime && readTime !== countResponse.readTime) fail('READ_TIME_DRIFT');
      readTime = countResponse.readTime;
      const rows = await rpc('runQuery', { transaction, structuredQuery });
      if (!Array.isArray(rows) || !rows.length) fail('INCOMPLETE_QUERY_RESPONSE');
      const documents: ObjectValue[] = [];
      const names = new Set<string>();
      let sawReadTime = false;
      for (const row of rows) {
        if (!object(row) || 'error' in row || (row.skippedResults !== undefined && row.skippedResults !== 0)) fail('INVALID_QUERY_ROW');
        if (row.readTime !== undefined) {
          if (row.readTime !== readTime) fail('READ_TIME_DRIFT');
          sawReadTime = true;
        }
        if (row.document === undefined) continue;
        const doc = row.document;
        const prefix = `${ERP5_DOCUMENTS}/${collection}/`;
        if (!object(doc) || typeof doc.name !== 'string' || !doc.name.startsWith(prefix)
          || !doc.name.slice(prefix.length) || doc.name.slice(prefix.length).includes('/')
          || names.has(doc.name) || !time(doc.createTime) || !time(doc.updateTime)
          || (doc.fields !== undefined && !object(doc.fields))) fail('INVALID_OR_DUPLICATE_DOCUMENT');
        names.add(doc.name);
        documents.push(structuredClone(doc));
      }
      if (!sawReadTime || documents.length !== Number(countText)) fail('INCOMPLETE_COLLECTION');
      documents.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      result[collection] = { count: documents.length, documents };
    }
    const unsigned = {
      version: 'erp5-source-capture/1' as const, projectId: 'freepasserp5' as const, databaseId: '(default)' as const,
      consistency: 'READ_ONLY_TRANSACTION' as const, readTime: readTime!, capturedAt: new Date().toISOString(), collections: result
    };
    return { ...unsigned, digest: hash(unsigned) };
  } finally {
    await rpc('rollback', { transaction });
  }
}

/** Decode only lossless JSON scalar/container types. Unsupported Firestore types HOLD the record. */
export function decodeErp5Value(value: unknown): unknown {
  if (!object(value) || Object.keys(value).length !== 1) fail('INVALID_FIRESTORE_VALUE');
  if ('nullValue' in value && value.nullValue === null) return null;
  if ('stringValue' in value && typeof value.stringValue === 'string') return value.stringValue;
  if ('booleanValue' in value && typeof value.booleanValue === 'boolean') return value.booleanValue;
  if ('integerValue' in value && typeof value.integerValue === 'string' && /^-?(0|[1-9]\d*)$/.test(value.integerValue)) {
    const n = Number(value.integerValue);
    if (Number.isSafeInteger(n)) return n;
    fail('UNSAFE_FIRESTORE_INTEGER');
  }
  if ('doubleValue' in value && typeof value.doubleValue === 'number' && Number.isFinite(value.doubleValue)) return value.doubleValue;
  if ('arrayValue' in value && object(value.arrayValue)) {
    if (Object.keys(value.arrayValue).some(k => k !== 'values')) fail('INVALID_FIRESTORE_ARRAY');
    const values = value.arrayValue.values ?? [];
    if (!Array.isArray(values)) fail('INVALID_FIRESTORE_ARRAY');
    return values.map(decodeErp5Value);
  }
  if ('mapValue' in value && object(value.mapValue)) {
    if (Object.keys(value.mapValue).some(k => k !== 'fields')) fail('INVALID_FIRESTORE_MAP');
    return decodeFields(value.mapValue.fields ?? {});
  }
  fail('UNSUPPORTED_FIRESTORE_VALUE');
}
/** Keep nanoseconds/offset text exactly; do not attach business meaning to metadata. */
function metadataTimestamp(value: unknown): string {
  if (!object(value) || Object.keys(value).length !== 1 || typeof value.timestampValue !== 'string') fail('INVALID_METADATA_TIMESTAMP');
  const text = value.timestampValue;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(text);
  if (!match) fail('INVALID_METADATA_TIMESTAMP');
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const maxDay = new Date(Date.UTC(year < 100 ? year + 400 : year, month, 0)).getUTCDate();
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > maxDay
    || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59
    || (match[7] && (Number(match[8]) > 23 || Number(match[9]) > 59))) fail('INVALID_METADATA_TIMESTAMP');
  return text;
}
/** Top-level Firestore timestamps observed as metadata per collection; anything else stays unsupported. */
const PRODUCT_METADATA_TIMESTAMP_FIELDS = ['policy_reference_checked_at', 'updated_at'] as const;
const POLICY_METADATA_TIMESTAMP_FIELDS = ['updated_at'] as const;

function decodeFields(fields: unknown, metadataTimestampFields: readonly string[] = []): ObjectValue {
  if (!object(fields)) fail('INVALID_FIRESTORE_FIELDS');
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key,
    metadataTimestampFields.includes(key)
      && object(value) && 'timestampValue' in value ? metadataTimestamp(value) : decodeErp5Value(value)
  ]));
}

type CaptureGroup = { count: number; documents: ObjectValue[] };
type DeltaBaselineCapture = Omit<Erp5SourceCapture, 'collections'> & {
  collections: {
    products: CaptureGroup;
    policy: CaptureGroup;
    partner?: CaptureGroup;
  };
};

function assertCaptureEnvelope(capture: unknown): asserts capture is DeltaBaselineCapture {
  if (!object(capture) || capture.version !== 'erp5-source-capture/1' || capture.projectId !== 'freepasserp5'
    || capture.databaseId !== '(default)' || capture.consistency !== 'READ_ONLY_TRANSACTION'
    || !time(capture.readTime) || !time(capture.capturedAt) || !object(capture.collections)
    || typeof capture.digest !== 'string') fail('INVALID_CAPTURE');
  const { digest, ...unsigned } = capture;
  if (digest !== hash(unsigned)) fail('CAPTURE_DIGEST_MISMATCH');
}

function assertCaptureCollection(
  capture: DeltaBaselineCapture,
  collection: Collection
) {
  const group = capture.collections[collection];
  if (!object(group) || !Number.isSafeInteger(group.count) || group.count < 0
    || !Array.isArray(group.documents) || group.documents.length !== group.count) fail('INVALID_CAPTURE_COVERAGE');
  const prefix = `${ERP5_DOCUMENTS}/${collection}/`;
  const names = new Set<string>();
  for (const doc of group.documents) {
    if (!object(doc) || typeof doc.name !== 'string' || !doc.name.startsWith(prefix)
      || !doc.name.slice(prefix.length) || doc.name.slice(prefix.length).includes('/') || names.has(doc.name)
      || !time(doc.createTime) || !time(doc.updateTime) || (doc.fields !== undefined && !object(doc.fields))) fail('INVALID_CAPTURE_DOCUMENT');
    names.add(doc.name);
  }
}

/**
 * Delta comparison may read an immutable accepted capture created before partner
 * joined source-capture/1. Only the previous baseline gets this compatibility
 * path; current captures must still prove the full three-collection contract.
 */
function inspectErp5DeltaBaseline(capture: Erp5SourceCapture) {
  assertCaptureEnvelope(capture);
  const keys = Object.keys(capture.collections).sort();
  const legacy = ['policy', 'products'];
  const current = ['partner', 'policy', 'products'];
  if (
    JSON.stringify(keys) !== JSON.stringify(legacy) &&
    JSON.stringify(keys) !== JSON.stringify(current)
  ) fail('INVALID_CAPTURE_COVERAGE');
  assertCaptureCollection(capture, 'products');
  assertCaptureCollection(capture, 'policy');
  if ('partner' in capture.collections) assertCaptureCollection(capture, 'partner');
}

/** No raw values or IDs in returned report. Even zero mapping holds cannot authorize cutover. */
export function inspectErp5Capture(capture: Erp5SourceCapture) {
  assertCaptureEnvelope(capture);
  for (const collection of collections) assertCaptureCollection(capture, collection);
  const policyRead = collectErp5PolicyFacts(capture);
  const policies = policyRead.facts;
  const issueCounts: Record<string, number> = {};
  const decodeFailureCounts: Record<string, number> = {};
  let mapped = 0;
  let held = 0;
  let decodeFailed = 0;
  const seenPlates = new Set<string>();
  let duplicatePlateCount = 0;
  let plateChecked = 0;
  let plateUnchecked = 0;
  let metadataTimestampFields = 0;
  for (const doc of capture.collections.products.documents) {
    // Plate coverage is independent of unrelated unsupported metadata on the record.
    try {
      const plate = decodeErp5Value(object(doc.fields) ? doc.fields.car_number : undefined);
      if (typeof plate !== 'string' || !plate.trim()) throw new Error('UNKNOWN_PLATE');
      plateChecked++;
      const identity = plate.replace(/\s+/g, '');
      if (seenPlates.has(identity)) duplicatePlateCount++;
      seenPlates.add(identity);
    } catch { plateUnchecked++; }
    try {
      const data = decodeFields(doc.fields ?? {}, PRODUCT_METADATA_TIMESTAMP_FIELDS);
      if (object(doc.fields)) for (const key of ['policy_reference_checked_at', 'updated_at']) {
        const value = doc.fields[key];
        if (object(value) && 'timestampValue' in value) metadataTimestampFields++;
      }
      const result = mapErp5Product({
        projectId: capture.projectId, collection: 'products', documentId: String(doc.name).split('/').at(-1),
        sourceRevision: `capture:${capture.digest}`, observedAt: new Date(capture.readTime).toISOString(), data
      }, { policies });
      if (result.status === 'MAPPED_FOR_REVIEW') mapped++; else held++;
      for (const issue of result.candidate.issues) issueCounts[issue] = (issueCounts[issue] ?? 0) + 1;
    } catch (error) {
      decodeFailed++;
      const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'UNKNOWN_DECODE_ERROR';
      decodeFailureCounts[code] = (decodeFailureCounts[code] ?? 0) + 1;
      issueCounts.DECODE_OR_ENVELOPE_HOLD = (issueCounts.DECODE_OR_ENVELOPE_HOLD ?? 0) + 1;
    }
  }
  return {
    status: 'HOLD' as const, cutoverAuthorized: false as const, canonicalWriteAuthorized: false as const,
    scope: 'ERP5_CAPTURE_AND_LOCAL_MAPPING_ONLY', mapperVersion: ERP5_PRODUCT_MAPPER_VERSION,
    sourceDigest: capture.digest, readTime: capture.readTime,
    products: capture.collections.products.count, policies: capture.collections.policy.count, partners: capture.collections.partner.count,
    mappedForReview: mapped, mappingHold: held, decodeFailed, decodeFailureCounts,
    duplicatePlateCount, plateChecked, plateUnchecked, metadataTimestampFields, issueCounts,
    policyFactCoverage: policyRead.coverage,
    remaining: ['UPSTREAM_FRESHNESS_AND_PARITY_UNVERIFIED', 'POLICY_LINKS_UNREVIEWED', 'NO_CANONICAL_WRITE_OR_CONSUMER_CUTOVER']
  };
}

/** 캡처 안의 정책을 매퍼가 읽을 수 있는 사실로 바꾼다. 값은 정책 문서가 정본이다. */
export function readErp5PolicyFacts(capture: Erp5SourceCapture): Erp5PolicyFacts[] {
  return collectErp5PolicyFacts(capture).facts;
}

export type AnnualMileageTextResult =
  | { km: number }
  | { reason: 'MONTHLY_UNIT' | 'UNLIMITED' | 'RANGE_OR_MULTIPLE' | 'NON_POSITIVE' | 'UNRECOGNIZED' };

/**
 * Reads the policy `annual_mileage` text lossless-ly: `30000`, `30,000km`, `연 30,000km`, `연간 3만km`.
 * Monthly units, unlimited, ranges/multiple values and anything else stay uninterpreted with a reason.
 */
export function parseAnnualMileageText(value: string): AnnualMileageTextResult {
  const compact = value.replace(/\s+/g, '');
  if (/월/.test(compact)) return { reason: 'MONTHLY_UNIT' };
  if (/무제한/.test(compact)) return { reason: 'UNLIMITED' };
  if (/\d\.\d/.test(compact)) return { reason: 'UNRECOGNIZED' };
  if (/[~∼〜–]/.test(compact) || (compact.match(/\d+(?:,\d{3})*/g) ?? []).length > 1) return { reason: 'RANGE_OR_MULTIPLE' };
  // A bare number is read as km; the 만 form needs an explicit km unit. No leading zeros.
  const match = /^(?:연간?)?([1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*|0)(?:(만)(?=km|㎞|킬로|키로)|)(km|㎞|킬로(?:미터)?|키로(?:미터)?)?$/i.exec(compact);
  if (!match) return { reason: 'UNRECOGNIZED' };
  const km = Number(match[1]!.replaceAll(',', '')) * (match[2] ? 10000 : 1);
  return Number.isSafeInteger(km) && km > 0 ? { km } : { reason: 'NON_POSITIVE' };
}

/** Count-only diagnostics; collecting evidence does not broaden decoding or approve policy facts. */
function collectErp5PolicyFacts(capture: Erp5SourceCapture) {
  const facts: Erp5PolicyFacts[] = [];
  const coverage = {
    sourceDocuments: capture.collections.policy.documents.length,
    factsProduced: 0,
    skippedDocuments: 0,
    decodeFailureCounts: {} as Record<string, number>,
    skippedWithTopLevelTimestampFields: 0,
    factsUsingDocumentIdAsPolicyCode: 0,
    duplicatePolicyCodes: 0,
    extraFactsWithDuplicatePolicyCode: 0,
    explicitInactiveFactsProduced: 0,
    factsWithAnnualMileage: 0,
    factsWithAnnualMileageParsedFromText: 0,
    factsWithUninterpretedAnnualMileage: 0,
    uninterpretedAnnualMileageReasons: {} as Record<string, number>,
    factsMissingAnnualMileage: 0,
    factsWithBasicDriverAge: 0,
    factsWithUninterpretedBasicDriverAge: 0,
    factsMissingBasicDriverAge: 0,
    annualMileageAbsent: 0,
    annualMileageNull: 0,
    annualMileageEmptyString: 0
  };
  const codeCounts = new Map<string, number>();
  for (const doc of capture.collections.policy.documents) {
    let data: ObjectValue;
    try { data = decodeFields(doc.fields ?? {}, POLICY_METADATA_TIMESTAMP_FIELDS); } catch (error) {
      coverage.skippedDocuments++;
      const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'UNKNOWN_DECODE_ERROR';
      coverage.decodeFailureCounts[code] = (coverage.decodeFailureCounts[code] ?? 0) + 1;
      if (object(doc.fields) && Object.values(doc.fields).some(value => object(value) && 'timestampValue' in value)) {
        // Co-occurrence only, not the decoder's failure cause; nested fields are outside this count.
        coverage.skippedWithTopLevelTimestampFields++;
      }
      continue;
    }
    const code = typeof data.policy_code === 'string' && data.policy_code.trim()
      ? data.policy_code.trim()
      : String(doc.name).slice(`${ERP5_DOCUMENTS}/policy/`.length);
    if (!(typeof data.policy_code === 'string' && data.policy_code.trim())) coverage.factsUsingDocumentIdAsPolicyCode++;
    codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
    const company = typeof data.companyId === 'string' && data.companyId.trim() ? data.companyId.trim()
      : typeof data.provider_company_code === 'string' && data.provider_company_code.trim() ? data.provider_company_code.trim()
      : undefined;
    const mileageText = typeof data.annual_mileage === 'string' && data.annual_mileage.trim()
      ? parseAnnualMileageText(data.annual_mileage) : undefined;
    const mileage = typeof data.annual_mileage === 'number' && Number.isSafeInteger(data.annual_mileage)
      ? data.annual_mileage : mileageText && 'km' in mileageText ? mileageText.km : undefined;
    if (mileageText && 'km' in mileageText) coverage.factsWithAnnualMileageParsedFromText++;
    else if (mileageText) {
      coverage.uninterpretedAnnualMileageReasons[mileageText.reason] =
        (coverage.uninterpretedAnnualMileageReasons[mileageText.reason] ?? 0) + 1;
    }
    const age = typeof data.basic_driver_age === 'number' && Number.isSafeInteger(data.basic_driver_age)
      ? data.basic_driver_age : undefined;
    // Report existing behavior, including inactive facts, without changing the mapping result.
    if (data._deleted === true || data.is_active === false || data.status === 'deleted' || data.status === 'retired') {
      coverage.explicitInactiveFactsProduced++;
    }
    if (mileage !== undefined) coverage.factsWithAnnualMileage++;
    else if (data.annual_mileage === undefined || data.annual_mileage === null || data.annual_mileage === '') {
      coverage.factsMissingAnnualMileage++;
      if (data.annual_mileage === undefined) coverage.annualMileageAbsent++;
      else if (data.annual_mileage === null) coverage.annualMileageNull++;
      else coverage.annualMileageEmptyString++;
    } else coverage.factsWithUninterpretedAnnualMileage++;
    if (age !== undefined) coverage.factsWithBasicDriverAge++;
    else if (data.basic_driver_age === undefined || data.basic_driver_age === null || data.basic_driver_age === '') {
      coverage.factsMissingBasicDriverAge++;
    } else coverage.factsWithUninterpretedBasicDriverAge++;
    facts.push({
      policyCode: code,
      ...(company !== undefined ? { companyId: company } : {}),
      ...(mileage !== undefined ? { annualMileageKm: mileage } : {}),
      ...(age !== undefined ? { basicDriverAge: age } : {})
    });
  }
  coverage.factsProduced = facts.length;
  for (const count of codeCounts.values()) {
    if (count > 1) {
      coverage.duplicatePolicyCodes++;
      coverage.extraFactsWithDuplicatePolicyCode += count - 1;
    }
  }
  return { facts, coverage };
}

export type Erp5CaptureChangeKind = 'ADDED' | 'CHANGED' | 'UNCHANGED' | 'MISSING_FROM_SOURCE';

/** Compare two verified FULL collection captures. Missing records stay review-only and never imply deletion. */
export function compareErp5ProductCaptures(previous: Erp5SourceCapture, current: Erp5SourceCapture) {
  inspectErp5DeltaBaseline(previous);
  inspectErp5Capture(current);
  if (Date.parse(current.readTime) < Date.parse(previous.readTime)) fail('CAPTURE_ORDER_INVALID');
  const prefix = `${ERP5_DOCUMENTS}/products/`;
  const index = (capture: Erp5SourceCapture) => new Map(capture.collections.products.documents.map((doc) => [
    String(doc.name).slice(prefix.length), doc
  ]));
  const before = index(previous);
  const after = index(current);
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const readInventory = (doc: ObjectValue | undefined) => {
    if (!doc || !object(doc.fields)) return { vehicleStatus: null, listable: null };
    const decode = (key: string) => {
      if (!Object.hasOwn(doc.fields!, key)) return null;
      try { return decodeErp5Value((doc.fields as ObjectValue)[key]); } catch { return null; }
    };
    return { vehicleStatus: decode('vehicle_status'), listable: decode('listable') };
  };
  const records = ids.map((sourceRecordId) => {
    const left = before.get(sourceRecordId);
    const right = after.get(sourceRecordId);
    const previousFingerprint = left ? hash(left.fields ?? {}) : null;
    const currentFingerprint = right ? hash(right.fields ?? {}) : null;
    const kind: Erp5CaptureChangeKind = !left ? 'ADDED' : !right ? 'MISSING_FROM_SOURCE'
      : previousFingerprint === currentFingerprint ? 'UNCHANGED' : 'CHANGED';
    const previousInventory = readInventory(left);
    const currentInventory = readInventory(right);
    const inventoryChanged = !!left && !!right
      && JSON.stringify(previousInventory) !== JSON.stringify(currentInventory);
    return {
      sourceRecordId,
      kind,
      previousFingerprint,
      currentFingerprint,
      inventoryTransition: inventoryChanged ? { before: previousInventory, after: currentInventory } : null,
      destructiveActionAuthorized: false as const
    };
  });
  const counts = Object.fromEntries((['ADDED', 'CHANGED', 'UNCHANGED', 'MISSING_FROM_SOURCE'] as const)
    .map((kind) => [kind, records.filter((record) => record.kind === kind).length])) as Record<Erp5CaptureChangeKind, number>;
  const inventoryTransitionCount = records.filter((record) => record.inventoryTransition).length;
  const unsigned = {
    version: 'erp5-capture-delta/1' as const,
    status: counts.MISSING_FROM_SOURCE || counts.CHANGED || counts.ADDED ? 'HOLD' as const : 'NO_CHANGE' as const,
    canonicalWriteAuthorized: false as const,
    destructiveActionAuthorized: false as const,
    previous: { digest: previous.digest, readTime: previous.readTime, count: previous.collections.products.count },
    current: { digest: current.digest, readTime: current.readTime, count: current.collections.products.count },
    counts,
    inventoryTransitionCount,
    records
  };
  if (records.length !== new Set(ids).size || Object.values(counts).reduce((sum, count) => sum + count, 0) !== records.length) {
    fail('DELTA_COVERAGE_MISMATCH');
  }
  return { ...unsigned, digest: hash(unsigned) };
}

/** Private structural profile: paths and statistics only, never raw scalar values. */
export function profileErp5CaptureFields(capture: Erp5SourceCapture, collection: Collection) {
  inspectErp5Capture(capture);
  type Mutable = {
    documents: Set<string>; occurrences: number; kinds: Record<string, number>;
    nullCount: number; emptyStringCount: number; distinct: Set<string>;
    minStringLength: number | null; maxStringLength: number | null;
  };
  const stats = new Map<string, Mutable>();
  const touch = (path: string, documentId: string, kind: string, scalar?: unknown) => {
    const item = stats.get(path) ?? {
      documents: new Set<string>(), occurrences: 0, kinds: {}, nullCount: 0, emptyStringCount: 0,
      distinct: new Set<string>(), minStringLength: null, maxStringLength: null
    };
    item.documents.add(documentId);
    item.occurrences++;
    item.kinds[kind] = (item.kinds[kind] ?? 0) + 1;
    if (scalar === null) item.nullCount++;
    if (typeof scalar === 'string') {
      if (scalar.length === 0) item.emptyStringCount++;
      item.minStringLength = item.minStringLength === null ? scalar.length : Math.min(item.minStringLength, scalar.length);
      item.maxStringLength = item.maxStringLength === null ? scalar.length : Math.max(item.maxStringLength, scalar.length);
    }
    if (scalar !== undefined) item.distinct.add(hash(scalar));
    stats.set(path, item);
  };
  const walk = (path: string, value: unknown, documentId: string) => {
    if (!object(value) || Object.keys(value).length !== 1) { touch(path, documentId, 'malformed'); return; }
    const kind = Object.keys(value)[0]!;
    let decoded: unknown;
    try { decoded = decodeErp5Value(value); } catch { decoded = undefined; }
    touch(path, documentId, kind, decoded !== undefined && !object(decoded) && !Array.isArray(decoded) ? decoded : undefined);
    if (kind === 'mapValue' && object(value.mapValue) && object(value.mapValue.fields)) {
      for (const [key, child] of Object.entries(value.mapValue.fields)) walk(`${path}.${key}`, child, documentId);
    } else if (kind === 'arrayValue' && object(value.arrayValue) && Array.isArray(value.arrayValue.values)) {
      for (const child of value.arrayValue.values) walk(`${path}[]`, child, documentId);
    }
  };
  const documents = capture.collections[collection].documents;
  for (const doc of documents) {
    const documentId = String(doc.name).split('/').at(-1)!;
    if (!object(doc.fields)) continue;
    for (const [path, value] of Object.entries(doc.fields)) walk(path, value, documentId);
  }
  const fields = [...stats.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, item]) => ({
    path,
    presentDocuments: item.documents.size,
    missingDocuments: documents.length - item.documents.size,
    occurrences: item.occurrences,
    firestoreKinds: Object.fromEntries(Object.entries(item.kinds).sort(([a], [b]) => a.localeCompare(b))),
    nullCount: item.nullCount,
    emptyStringCount: item.emptyStringCount,
    distinctValueCount: item.distinct.size,
    minStringLength: item.minStringLength,
    maxStringLength: item.maxStringLength
  }));
  return { collection, documentCount: documents.length, fieldPathCount: fields.length, fields };
}

/**
 * Turns the mapping holds into answerable questions.
 *
 * Every product is on hold, but not for 1,659 different reasons — a handful of
 * undecided meanings are applied across the whole set. Deciding them needs to know
 * what the source actually contains, and the non-sensitive summary does not carry it.
 *
 * Only enumerable codes and keys leave here: price-term keys, bucket and type codes,
 * and counts. Free text (deposit notes, names, plates) is counted, never quoted —
 * a note field can hold anything, including a customer's words.
 */
export function summarizeErp5DecisionInputs(capture: Erp5SourceCapture) {
  inspectErp5Capture(capture);
  const tally = new Map<string, Map<string, number>>();
  const add = (group: string, key: string) => {
    const bucket = tally.get(group) ?? new Map<string, number>();
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
    tally.set(group, bucket);
  };
  const out = (group: string) => Object.fromEntries(
    [...(tally.get(group) ?? new Map())].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  );

  const policyIds = new Set(capture.collections.policy.documents.map(
    (doc) => String(doc.name).slice(`${ERP5_DOCUMENTS}/policy/`.length)
  ));
  const freeTextFields = ['deposit_note', 'offer_terms', 'adapter_pricing', 'rent_variants',
    'rentVariants', 'deposit', 'pricing_rules', 'quotes'];
  const freeText: Record<string, number> = {};
  let policyMatched = 0, policyUnmatched = 0, policyAbsent = 0;

  for (const doc of capture.collections.products.documents) {
    let data: ObjectValue;
    try { data = decodeFields(doc.fields ?? {}, PRODUCT_METADATA_TIMESTAMP_FIELDS); } catch { add('undecodable', 'DECODE_FAILED'); continue; }

    add('productType', typeof data.product_type === 'string' ? data.product_type : '(없음)');
    add('sourceBucket', typeof data.source_bucket === 'string' ? data.source_bucket : '(없음)');
    add('providerCompanyCode', typeof data.provider_company_code === 'string' ? data.provider_company_code : '(없음)');

    // A policy link is only a decision if the code actually resolves to a policy document.
    const code = typeof data.policy_code === 'string' ? data.policy_code.trim() : '';
    if (!code) policyAbsent++;
    else if (policyIds.has(code)) policyMatched++;
    else policyUnmatched++;

    for (const field of freeTextFields) {
      if (Object.hasOwn(data, field) && data[field] !== null && data[field] !== '') {
        freeText[field] = (freeText[field] ?? 0) + 1;
      }
    }

    const price = object(data.price) ? data.price : {};
    if (!Object.keys(price).length) add('priceKeyShape', '(가격 없음)');
    for (const key of Object.keys(price)) {
      const parsed = /^([1-9]\d*)(?:_([1-9]\d*)만)?$/.exec(key);
      add('priceKeyShape', !parsed ? '해석 불가' : parsed[2] ? '개월_주행거리' : '개월만');
      add('priceKey', key);
      const terms = object(price[key]) ? (price[key] as ObjectValue) : {};
      for (const termField of Object.keys(terms)) add('priceTermField', termField);
    }
  }

  // 정책이 기본 주행거리를 들고 있고 회사와도 맞아야 하므로, 정책 쪽 뼈대도 같이 낸다.
  // 필드 «이름»은 스키마다 — 값이 아니다. 값은 여기서도 나가지 않는다.
  const policyFieldPaths: Record<string, number> = {};
  const policyCompanyValues = new Map<string, Map<string, number>>();
  const policyValueShapes = new Map<string, Map<string, number>>();
  const policyShortValues = new Map<string, Map<string, number>>();
  for (const doc of capture.collections.policy.documents) {
    let data: ObjectValue;
    try { data = decodeFields(doc.fields ?? {}, POLICY_METADATA_TIMESTAMP_FIELDS); } catch { continue; }
    for (const [key, value] of Object.entries(data)) {
      policyFieldPaths[key] = (policyFieldPaths[key] ?? 0) + 1;
      // 숫자로 쓰는 줄 알았던 필드가 실제로 어떤 꼴인지 — 이걸 몰라서 정책 조회가 통째로 헛돌았다.
      if (['annual_mileage', 'basic_driver_age', 'mileage_upcharge_per_10000km'].includes(key)) {
        const shape = typeof value === 'number' ? 'number'
          : typeof value === 'string' ? (/^\d+$/.test(value) ? 'string:digits' : 'string:other')
          : value === null ? 'null' : typeof value;
        const bucket = policyValueShapes.get(key) ?? new Map<string, number>();
        bucket.set(shape, (bucket.get(shape) ?? 0) + 1);
        policyValueShapes.set(key, bucket);
        if (typeof value === 'string' && value.length <= 12) {
          const seen = policyShortValues.get(key) ?? new Map<string, number>();
          seen.set(value, (seen.get(value) ?? 0) + 1);
          policyShortValues.set(key, seen);
        }
      }
      // 회사를 가리킬 법한 짧은 코드성 필드만 값을 센다(긴 문장은 세지 않는다).
      if (/company|provider|partner|supplier|회사|공급/i.test(key) && typeof value === 'string' && value.length <= 24) {
        const bucket = policyCompanyValues.get(key) ?? new Map<string, number>();
        bucket.set(value, (bucket.get(value) ?? 0) + 1);
        policyCompanyValues.set(key, bucket);
      }
    }
  }

  return {
    version: 'erp5-decision-inputs/2' as const,
    documentCount: capture.collections.products.count,
    policyFieldPaths,
    policyValueShapes: Object.fromEntries([...policyValueShapes].map(([f, v]) => [f, Object.fromEntries([...v])])),
    policyShortValues: Object.fromEntries([...policyShortValues].map(([f, v]) => [f, Object.fromEntries([...v].sort((a, b) => b[1] - a[1]).slice(0, 12))])),
    policyCompanyCodes: Object.fromEntries(
      [...policyCompanyValues].map(([field, values]) => [field, Object.fromEntries([...values].sort((a, b) => b[1] - a[1]))])
    ),
    productType: out('productType'),
    sourceBucket: out('sourceBucket'),
    providerCompanyCode: out('providerCompanyCode'),
    priceKeyShape: out('priceKeyShape'),
    priceKey: out('priceKey'),
    priceTermField: out('priceTermField'),
    freeTextFieldPresence: freeText,
    policyLink: { matched: policyMatched, unmatched: policyUnmatched, absent: policyAbsent, policyDocuments: policyIds.size },
    undecodable: out('undecodable')
  };
}

export function buildErp5CanonicalDryRun(capture: Erp5SourceCapture) {
  const inspection = inspectErp5Capture(capture);
  const reviewAxes = [
    ['IDENTITY', /^(MISSING_REQUIRED|INVALID_PLATE|DOCUMENT_ID_CONFLICT|SUPPLIER_ALIAS)/],
    ['CLASSIFICATION', /^(UNKNOWN_PRODUCT_TYPE|SONOGONG_|SUBSCRIPTION_|CATALOG_COMMERCIAL)/],
    ['PRICE_STRUCTURE', /^(MISSING_PRICE|NO_MAPPED_PRICE|UNSUPPORTED_PRICE|INVALID_RENT|INVALID_PRICE|UNMAPPED_PRICE|PRIVATE_PRICE|UNSUPPORTED_CURRENCY)/],
    ['DEPOSIT', /^(UNKNOWN_DEPOSIT|PRICING_SEMANTICS)/],
    ['MILEAGE', /^(UNKNOWN_MILEAGE|INVALID_INTEGER:mileage)/],
    ['POLICY', /^(POLICY_LINK|INVALID_TEXT:policy_code)/],
    ['OTHER_DATA_QUALITY', /^(INVALID_TEXT|INVALID_INTEGER|UNKNOWN_LISTABLE|UNREVIEWED_VEHICLE_STATUS|INVENTORY_|DELETION_)/]
  ] as const;
  const classify = (reasons: readonly string[]) => reviewAxes
    .filter(([, pattern]) => reasons.some((reason) => pattern.test(reason)))
    .map(([axis]) => axis);
  const policies = readErp5PolicyFacts(capture);
  const records = capture.collections.products.documents.map((doc) => {
    const documentId = String(doc.name).split('/').at(-1);
    if (!documentId) fail('INVALID_CAPTURE_DOCUMENT');
    try {
      const mapped = mapErp5Product({
        projectId: capture.projectId,
        collection: 'products',
        documentId,
        sourceRevision: `capture:${capture.digest}`,
        observedAt: new Date(capture.readTime).toISOString(),
        data: decodeFields(doc.fields ?? {}, PRODUCT_METADATA_TIMESTAMP_FIELDS)
      }, { policies });
      const holdReasons = [...mapped.candidate.issues].sort();
      return {
        sourceRecordId: documentId,
        sourceFingerprint: mapped.candidate.sourceFingerprint,
        status: mapped.status,
        canonicalWriteAuthorized: false as const,
        holdReasons,
        reviewAxes: classify(holdReasons),
        candidate: mapped.candidate,
        inventory: mapped.inventory,
        fieldSources: mapped.fieldSources
      };
    } catch (error) {
      const code = error instanceof Error && /^[A-Z0-9_:.-]+$/.test(error.message)
        ? error.message
        : 'DECODE_OR_ENVELOPE_HOLD';
      return {
        sourceRecordId: documentId,
        sourceFingerprint: null,
        status: 'HOLD' as const,
        canonicalWriteAuthorized: false as const,
        holdReasons: [code],
        reviewAxes: ['OTHER_DATA_QUALITY'] as const,
        candidate: null,
        inventory: null,
        fieldSources: {}
      };
    }
  }).sort((a, b) => a.sourceRecordId.localeCompare(b.sourceRecordId));
  const issueCounts: Record<string, number> = {};
  for (const record of records) for (const reason of record.holdReasons) {
    issueCounts[reason] = (issueCounts[reason] ?? 0) + 1;
  }
  const reviewAxisCounts = Object.fromEntries(reviewAxes.map(([axis]) => [
    axis,
    records.filter((record) => record.reviewAxes.includes(axis as never)).length
  ]));
  const reviewComplexityCounts: Record<string, number> = {};
  for (const record of records) {
    const key = String(record.reviewAxes.length);
    reviewComplexityCounts[key] = (reviewComplexityCounts[key] ?? 0) + 1;
  }
  const mappedForReview = records.filter((record) => record.status === 'MAPPED_FOR_REVIEW').length;
  const mappingHold = records.filter((record) => record.status === 'HOLD').length;
  const publicationGateReasons = [
    ...(records.length === 0 ? ['SOURCE_CATALOG_EMPTY'] : []),
    ...(mappingHold > 0 ? ['MAPPING_HOLD_PRESENT'] : []),
    ...(mappedForReview === 0 ? ['NO_CANDIDATES_READY_FOR_REVIEW'] : []),
    'REVIEW_APPROVALS_NOT_INCLUDED',
    'CANONICAL_RELEASE_NOT_BUILT'
  ];
  const unsigned = {
    version: 'erp5-canonical-dry-run/1' as const,
    status: 'HOLD' as const,
    canonicalWriteAuthorized: false as const,
    cutoverAuthorized: false as const,
    sourceDigest: capture.digest,
    sourceReadTime: capture.readTime,
    mapperVersion: ERP5_PRODUCT_MAPPER_VERSION,
    counts: {
      sourceProducts: capture.collections.products.count,
      candidates: records.length,
      mappedForReview,
      hold: mappingHold
    },
    publicationGate: {
      version: 'erp5-publication-gate/1' as const,
      decision: 'HOLD' as const,
      sourceCoverage: {
        mode: 'FULL' as const,
        completeness: 'COMPLETE' as const,
        observedProducts: capture.collections.products.count,
        candidateProducts: records.length
      },
      reviewCoverage: {
        mappedForReview,
        mappingHold,
        approvedCanonicalProducts: 0
      },
      activeReleaseAuthorized: false as const,
      reasons: publicationGateReasons
    },
    issueCounts,
    reviewAxisCounts,
    reviewComplexityCounts,
    fieldProfile: profileErp5CaptureFields(capture, 'products'),
    decisionInputs: summarizeErp5DecisionInputs(capture),
    records
  };
  if (unsigned.counts.candidates !== inspection.products) fail('DRY_RUN_COVERAGE_MISMATCH');
  return { ...unsigned, digest: hash(unsigned) };
}


export function buildErp5RawSourceIntakeBatches(
  capture: Erp5SourceCapture
): SourceIntakeBatch[] {
  inspectErp5Capture(capture);

  const config = {
    products: {
      laneId: 'PRODUCT_VEHICLE' as const,
      displayName: 'ERP5 products',
      authorityScope: ['catalog:product-vehicle-source'],
    },
    policy: {
      laneId: 'PRODUCT_VEHICLE' as const,
      displayName: 'ERP5 policy',
      authorityScope: ['catalog:policy-source'],
    },
    partner: {
      laneId: 'SUPPLIER' as const,
      displayName: 'ERP5 partner',
      authorityScope: ['catalog:supplier-source'],
    },
  };

  return collections.map((collection) => {
    const group = capture.collections[collection];
    const prefix = `${ERP5_DOCUMENTS}/${collection}/`;
    return {
      laneId: config[collection].laneId,
      source: {
        sourceId: `freepasserp5/firestore/${collection}`,
        kind: 'FIRESTORE' as const,
        displayName: config[collection].displayName,
        authorityScope: config[collection].authorityScope,
      },
      observedAt: capture.readTime,
      sourceRevision: `capture:${capture.digest}`,
      checksum: capture.digest,
      coverage: {
        mode: 'FULL' as const,
        completeness: 'COMPLETE' as const,
        scope: `firestore:${collection}`,
      },
      records: group.documents.map((document) => {
        const name = String(document.name);
        if (!name.startsWith(prefix) || !name.slice(prefix.length)) {
          fail('INVALID_CAPTURE_DOCUMENT');
        }
        return {
          sourceRecordId: name.slice(prefix.length),
          sourceFingerprint: hash(document),
          payload: structuredClone(document),
        };
      }),
    };
  });
}
