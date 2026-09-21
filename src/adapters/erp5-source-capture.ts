import { createHash } from 'node:crypto';
import { mapErp5Product, ERP5_PRODUCT_MAPPER_VERSION } from './erp5-product-mapping.js';

export const ERP5_DOCUMENTS = 'projects/freepasserp5/databases/(default)/documents';
const collections = ['products', 'policy'] as const;
type Collection = typeof collections[number];
type ObjectValue = Record<string, unknown>;
type Rpc = (method: 'beginTransaction' | 'runQuery' | 'runAggregationQuery' | 'rollback', body: ObjectValue) => Promise<unknown>;
const object = (x: unknown): x is ObjectValue => !!x && typeof x === 'object' && !Array.isArray(x);
function fail(code: string): never { throw new Error(code); }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const time = (x: unknown): x is string => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(x) && Number.isFinite(Date.parse(x));

export type Erp5SourceCapture = {
  version: 'erp5-source-capture/1'; projectId: 'freepasserp5'; databaseId: '(default)';
  consistency: 'READ_ONLY_TRANSACTION'; readTime: string; capturedAt: string;
  collections: Record<Collection, { count: number; documents: ObjectValue[] }>;
  digest: string;
};

/** Only the four allowlisted RPCs exist. No fallback, custom host, document writes or runtime bootstrap. */
export function erp5ReadTransport(accessToken: string, fetcher: typeof fetch = fetch): Rpc {
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
export async function captureErp5Source(rpc: Rpc): Promise<Erp5SourceCapture> {
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
function decodeFields(fields: unknown, productMetadata = false): ObjectValue {
  if (!object(fields)) fail('INVALID_FIRESTORE_FIELDS');
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key,
    productMetadata && ['policy_reference_checked_at', 'updated_at'].includes(key)
      && object(value) && 'timestampValue' in value ? metadataTimestamp(value) : decodeErp5Value(value)
  ]));
}

/** No raw values or IDs in returned report. Even zero mapping holds cannot authorize cutover. */
export function inspectErp5Capture(capture: Erp5SourceCapture) {
  if (!object(capture) || capture.version !== 'erp5-source-capture/1' || capture.projectId !== 'freepasserp5'
    || capture.databaseId !== '(default)' || capture.consistency !== 'READ_ONLY_TRANSACTION'
    || !time(capture.readTime) || !time(capture.capturedAt) || !object(capture.collections)) fail('INVALID_CAPTURE');
  const { digest, ...unsigned } = capture;
  if (digest !== hash(unsigned)) fail('CAPTURE_DIGEST_MISMATCH');
  for (const collection of collections) {
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
      const data = decodeFields(doc.fields ?? {}, true);
      if (object(doc.fields)) for (const key of ['policy_reference_checked_at', 'updated_at']) {
        const value = doc.fields[key];
        if (object(value) && 'timestampValue' in value) metadataTimestampFields++;
      }
      const result = mapErp5Product({
        projectId: capture.projectId, collection: 'products', documentId: String(doc.name).split('/').at(-1),
        sourceRevision: `capture:${capture.digest}`, observedAt: new Date(capture.readTime).toISOString(), data
      });
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
    products: capture.collections.products.count, policies: capture.collections.policy.count,
    mappedForReview: mapped, mappingHold: held, decodeFailed, decodeFailureCounts,
    duplicatePlateCount, plateChecked, plateUnchecked, metadataTimestampFields, issueCounts,
    remaining: ['UPSTREAM_FRESHNESS_AND_PARITY_UNVERIFIED', 'POLICY_LINKS_UNREVIEWED', 'NO_CANONICAL_WRITE_OR_CONSUMER_CUTOVER']
  };
}

export type Erp5CaptureChangeKind = 'ADDED' | 'CHANGED' | 'UNCHANGED' | 'MISSING_FROM_SOURCE';

/** Compare two verified FULL collection captures. Missing records stay review-only and never imply deletion. */
export function compareErp5ProductCaptures(previous: Erp5SourceCapture, current: Erp5SourceCapture) {
  inspectErp5Capture(previous);
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
        data: decodeFields(doc.fields ?? {}, true)
      });
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
      mappedForReview: records.filter((record) => record.status === 'MAPPED_FOR_REVIEW').length,
      hold: records.filter((record) => record.status === 'HOLD').length
    },
    issueCounts,
    reviewAxisCounts,
    reviewComplexityCounts,
    fieldProfile: profileErp5CaptureFields(capture, 'products'),
    records
  };
  if (unsigned.counts.candidates !== inspection.products) fail('DRY_RUN_COVERAGE_MISMATCH');
  return { ...unsigned, digest: hash(unsigned) };
}
