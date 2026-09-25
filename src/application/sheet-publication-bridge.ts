import { createHash } from 'node:crypto';
import { ERP5_DOCUMENTS, type Erp5ReadRpc } from '../adapters/erp5-source-capture.js';
import {
  hashSheetPublicationHandoff,
  hashSheetPublicationData,
  validateSheetPublicationHandoff,
  type SheetInventorySummary,
  type SheetPublicationHandoff,
  type SheetPublicationManifest,
  type SheetHandoffWorkbook
} from '../domain/sheet-publication-handoff.js';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const time = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
function fail(code: string): never { throw new Error(code); }

const collections = ['products', 'policy', 'partner'] as const;
type SheetSourceCollection = typeof collections[number];

export type Erp5SheetSourceCapture = {
  version: 'erp5-sheet-source-capture/1';
  projectId: 'freepasserp5';
  databaseId: '(default)';
  consistency: 'READ_ONLY_TRANSACTION';
  readTime: string;
  capturedAt: string;
  collections: Record<SheetSourceCollection, {
    count: number;
    documents: ObjectValue[];
  }>;
  digest: string;
};

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function documentId(doc: ObjectValue, collection: string) {
  const prefix = `${ERP5_DOCUMENTS}/${collection}/`;
  if (
    typeof doc.name !== 'string' ||
    !doc.name.startsWith(prefix) ||
    !doc.name.slice(prefix.length) ||
    doc.name.slice(prefix.length).includes('/')
  ) fail('INVALID_SHEET_SOURCE_DOCUMENT');
  return doc.name.slice(prefix.length);
}

async function captureCollection(
  rpc: Erp5ReadRpc,
  transaction: string,
  collection: SheetSourceCollection,
  expectedReadTime?: string
) {
  const structuredQuery = { from: [{ collectionId: collection }] };
  const counts = await rpc('runAggregationQuery', {
    transaction,
    structuredAggregationQuery: {
      structuredQuery,
      aggregations: [{ alias: 'total', count: {} }]
    }
  });
  if (!Array.isArray(counts) || counts.length !== 1 || !object(counts[0])) {
    fail('INVALID_SHEET_SOURCE_COUNT_RESPONSE');
  }
  const countRow = counts[0];
  const countFields = object(countRow.result) ? countRow.result.aggregateFields : null;
  const total = object(countFields) ? countFields.total : null;
  const countText = object(total) ? total.integerValue : null;
  if (
    typeof countText !== 'string' ||
    !/^(0|[1-9]\d*)$/.test(countText) ||
    !Number.isSafeInteger(Number(countText)) ||
    !time(countRow.readTime)
  ) fail('INVALID_SHEET_SOURCE_COUNT_EVIDENCE');
  if (expectedReadTime && countRow.readTime !== expectedReadTime) {
    fail('SHEET_SOURCE_READ_TIME_DRIFT');
  }

  const rows = await rpc('runQuery', { transaction, structuredQuery });
  if (!Array.isArray(rows) || !rows.length) fail('INCOMPLETE_SHEET_SOURCE_QUERY');

  const documents: ObjectValue[] = [];
  const names = new Set<string>();
  let sawReadTime = false;

  for (const row of rows) {
    if (!object(row) || 'error' in row ||
        (row.skippedResults !== undefined && row.skippedResults !== 0)) {
      fail('INVALID_SHEET_SOURCE_QUERY_ROW');
    }
    if (row.readTime !== undefined) {
      if (row.readTime !== countRow.readTime) fail('SHEET_SOURCE_READ_TIME_DRIFT');
      sawReadTime = true;
    }
    if (row.document === undefined) continue;
    const doc = row.document;
    if (
      !object(doc) ||
      names.has(String(doc.name)) ||
      !time(doc.createTime) ||
      !time(doc.updateTime) ||
      (doc.fields !== undefined && !object(doc.fields))
    ) fail('INVALID_SHEET_SOURCE_DOCUMENT');
    documentId(doc, collection);
    names.add(String(doc.name));
    documents.push(structuredClone(doc));
  }

  if (!sawReadTime || documents.length !== Number(countText)) {
    fail('INCOMPLETE_SHEET_SOURCE_COLLECTION');
  }
  documents.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return {
    readTime: countRow.readTime as string,
    group: { count: documents.length, documents }
  };
}

export async function captureErp5SheetSource(
  rpc: Erp5ReadRpc,
  capturedAt = new Date().toISOString()
): Promise<Erp5SheetSourceCapture> {
  const started = await rpc('beginTransaction', { options: { readOnly: {} } });
  if (!object(started) || typeof started.transaction !== 'string' || !started.transaction) {
    fail('MISSING_SHEET_SOURCE_TRANSACTION');
  }
  const transaction = started.transaction;

  try {
    const result = {} as Erp5SheetSourceCapture['collections'];
    let readTime: string | undefined;
    for (const collection of collections) {
      const captured = await captureCollection(rpc, transaction, collection, readTime);
      readTime ??= captured.readTime;
      result[collection] = captured.group;
    }
    if (!time(capturedAt)) fail('INVALID_SHEET_SOURCE_CAPTURED_AT');

    const unsigned = {
      version: 'erp5-sheet-source-capture/1' as const,
      projectId: 'freepasserp5' as const,
      databaseId: '(default)' as const,
      consistency: 'READ_ONLY_TRANSACTION' as const,
      readTime: readTime!,
      capturedAt,
      collections: result
    };
    return { ...unsigned, digest: digest(unsigned) };
  } finally {
    await rpc('rollback', { transaction });
  }
}

function legacyTimestampValue(value: string) {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) fail('INVALID_SHEET_FIRESTORE_TIMESTAMP');
  const millis = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(millis) || millis % 1000 !== 0) {
    fail('INVALID_SHEET_FIRESTORE_TIMESTAMP');
  }
  return {
    _seconds: millis / 1000,
    _nanoseconds: Number((match[2] ?? '').padEnd(9, '0'))
  };
}

function decodeSheetValue(value: unknown): unknown {
  if (!object(value) || Object.keys(value).length !== 1) {
    fail('INVALID_SHEET_FIRESTORE_VALUE');
  }
  if ('nullValue' in value && value.nullValue === null) return null;
  if ('stringValue' in value && typeof value.stringValue === 'string') return value.stringValue;
  if ('booleanValue' in value && typeof value.booleanValue === 'boolean') return value.booleanValue;
  if ('integerValue' in value && typeof value.integerValue === 'string' &&
      /^-?(0|[1-9]\d*)$/.test(value.integerValue)) {
    const parsed = Number(value.integerValue);
    if (Number.isSafeInteger(parsed)) return parsed;
    fail('UNSAFE_SHEET_FIRESTORE_INTEGER');
  }
  if ('doubleValue' in value && typeof value.doubleValue === 'number' &&
      Number.isFinite(value.doubleValue)) return value.doubleValue;
  if ('timestampValue' in value && typeof value.timestampValue === 'string' && time(value.timestampValue)) {
    return legacyTimestampValue(value.timestampValue);
  }
  if ('arrayValue' in value && object(value.arrayValue)) {
    if (Object.keys(value.arrayValue).some((key) => key !== 'values')) {
      fail('INVALID_SHEET_FIRESTORE_ARRAY');
    }
    const values = value.arrayValue.values ?? [];
    if (!Array.isArray(values)) fail('INVALID_SHEET_FIRESTORE_ARRAY');
    return values.map(decodeSheetValue);
  }
  if ('mapValue' in value && object(value.mapValue)) {
    if (Object.keys(value.mapValue).some((key) => key !== 'fields')) {
      fail('INVALID_SHEET_FIRESTORE_MAP');
    }
    return decodeSheetFields(value.mapValue.fields ?? {});
  }
  fail('UNSUPPORTED_SHEET_FIRESTORE_VALUE');
}

function decodeSheetFields(fields: unknown): Record<string, unknown> {
  if (!object(fields)) fail('INVALID_SHEET_FIRESTORE_FIELDS');
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, decodeSheetValue(value)])
  );
}

function decodedRecords(
  capture: Erp5SheetSourceCapture,
  collection: SheetSourceCollection
) {
  return capture.collections[collection].documents.map((doc) => {
    const id = documentId(doc, collection);
    const data = decodeSheetFields(doc.fields ?? {});
    if (Object.hasOwn(data, '_key') && data._key !== id) {
      fail('SHEET_SOURCE_DOCUMENT_ID_MISMATCH');
    }
    return { ...data, _key: id };
  });
}

const normalizeStatus = (value: unknown) =>
  String(value ?? '').replace(/\s+/g, '');
const plateKey = (value: unknown) =>
  String(value ?? '').trim().replace(/[\s.$#[\]/-]/g, '');
const isPlate = (value: unknown) => {
  const plate = plateKey(value);
  return plate.length >= 5 &&
    plate.length <= 12 &&
    !/^(미정|미배정|미상|없음|-|tbd|n\/a)$/i.test(String(value ?? '').trim()) &&
    /[가-힣]/.test(plate) &&
    /\d$/.test(plate);
};
const unavailable = (product: Record<string, unknown>) =>
  normalizeStatus(product.vehicle_status) === '출고불가';
const expectedListable = (product: Record<string, unknown>) => !unavailable(product);
const expectedStatusKind = (product: Record<string, unknown>) => {
  const status = String(product.vehicle_status ?? '').trim();
  if (status === '즉시출고' || status === '출고가능') return '가용';
  if (status === '출고협의') return '협의';
  if (status === '상품화중' || status === '차량검수' || !status) return '준비';
  if (status === '계약중') return '선점';
  return '불가';
};
const deletedMarker = (product: Record<string, unknown>) =>
  product._deleted === true ||
  product._deleted === 1 ||
  String(product._deleted ?? '').trim().toLowerCase() === 'true' ||
  Boolean(String(product.deletedAt ?? '').trim()) ||
  String(product.status ?? '').trim().toLowerCase() === 'deleted';

const LEGACY_SONOKONG_DEPOSIT_RULE = '월 대여료 × 약정연수 (최대 3개월)';
const legacyDepositRuleViolation = (product: Record<string, unknown>) => {
  if (String(product.deposit_note ?? '').trim() !== LEGACY_SONOKONG_DEPOSIT_RULE) return false;
  const classification = object(product.sonokong_classification)
    ? product.sonokong_classification
    : null;
  if (String(classification?.product_type ?? product.product_type ?? '').trim() === '중고렌트') {
    return false;
  }
  if (!object(product.price)) return false;
  return Object.values(product.price).some((term) =>
    object(term) && Number(term.deposit) > 0
  );
};

export function buildSheetInventorySummary(
  products: readonly Record<string, unknown>[]
): SheetInventorySummary {
  const byStatus: Record<string, number> = {};
  let unavailableCount = 0;
  let listableDrift = 0;
  let statusKindDrift = 0;
  let sourceIdentityViolations = 0;
  let deletedMarkerViolations = 0;
  let blankPlateViolations = 0;
  let invalidPlateViolations = 0;
  let duplicatePlateViolations = 0;
  let depositRuleViolations = 0;
  const plates = new Set<string>();

  for (const product of products) {
    const status = normalizeStatus(product.vehicle_status) || '(빈상태)';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (unavailable(product)) unavailableCount++;
    if (product.listable !== expectedListable(product)) listableDrift++;
    if (String(product.status_kind ?? '').trim() !== expectedStatusKind(product)) statusKindDrift++;

    const provider =
      String(product.provider_company_code ?? '').trim() ||
      String(product.partner_code ?? '').trim();
    const source =
      String(product.source ?? '').trim() ||
      String(product.source_schema ?? '').trim();
    if (!provider || !source) sourceIdentityViolations++;
    if (deletedMarker(product)) deletedMarkerViolations++;
    if (legacyDepositRuleViolation(product)) depositRuleViolations++;

    const rawPlate = String(product.car_number ?? '').trim();
    const plate = plateKey(rawPlate);
    if (!plate) blankPlateViolations++;
    else {
      if (!isPlate(rawPlate)) invalidPlateViolations++;
      if (plates.has(plate)) duplicatePlateViolations++;
      else plates.add(plate);
    }
  }

  return {
    registered: products.length,
    unavailable: unavailableCount,
    open: products.length - unavailableCount,
    listableDrift,
    statusKindDrift,
    sourceIdentityViolations,
    deletedMarkerViolations,
    blankPlateViolations,
    invalidPlateViolations,
    duplicatePlateViolations,
    depositRuleViolations,
    byStatus
  };
}

export type SheetBridgeRelease = {
  releaseAuthority: 'LEGACY_VERIFIED_BRIDGE';
  release: {
    projectionId: 'sheet-publication-bridge';
    releaseId: string;
    manifestId: string;
    inputDigest: string;
    dataDigest: string;
    observedAt: string;
  };
  manifest: SheetPublicationManifest;
  products: Record<string, unknown>[];
  policies: Record<string, unknown>[];
  partners: Record<string, unknown>[];
  inventory: SheetInventorySummary;
};

export function buildSheetBridgeRelease(
  capture: Erp5SheetSourceCapture
): SheetBridgeRelease {
  const { digest: storedDigest, ...unsignedCapture } = capture;
  if (
    capture.version !== 'erp5-sheet-source-capture/1' ||
    capture.projectId !== 'freepasserp5' ||
    capture.databaseId !== '(default)' ||
    capture.consistency !== 'READ_ONLY_TRANSACTION' ||
    !time(capture.readTime) ||
    digest(unsignedCapture) !== storedDigest
  ) fail('INVALID_SHEET_SOURCE_CAPTURE');

  for (const collection of collections) {
    const group = capture.collections[collection];
    if (
      !group ||
      group.documents.length !== group.count ||
      !Number.isInteger(group.count) ||
      group.count < 0
    ) fail('INVALID_SHEET_SOURCE_COVERAGE');
  }

  const products = decodedRecords(capture, 'products');
  const policies = decodedRecords(capture, 'policy');
  const partners = decodedRecords(capture, 'partner');
  const inventory = buildSheetInventorySummary(products);
  if (
    inventory.listableDrift ||
    inventory.statusKindDrift ||
    inventory.sourceIdentityViolations ||
    inventory.deletedMarkerViolations ||
    inventory.blankPlateViolations ||
    inventory.invalidPlateViolations ||
    inventory.duplicatePlateViolations ||
    inventory.depositRuleViolations
  ) {
    fail('SHEET_BRIDGE_INVENTORY_VIOLATION');
  }
  const dataDigest = hashSheetPublicationData({ products, policies, partners, inventory });
  const suffix = storedDigest.slice(0, 32);

  const release = {
    projectionId: 'sheet-publication-bridge' as const,
    releaseId: `sheetbridge_${suffix}`,
    manifestId: `sheetmanifest_${suffix}`,
    inputDigest: storedDigest,
    dataDigest,
    observedAt: capture.readTime
  };
  const manifest: SheetPublicationManifest = {
    contractVersion: 'freepass-sheet-manifest-v1',
    manifestId: release.manifestId,
    releaseId: release.releaseId,
    projectionId: release.projectionId,
    releaseAuthority: 'LEGACY_VERIFIED_BRIDGE',
    sourceCaptureDigest: storedDigest,
    sourceReadTime: capture.readTime,
    productCount: products.length,
    policyCount: policies.length,
    partnerCount: partners.length,
    dataDigest,
    generatedAt: capture.capturedAt
  };

  return {
    releaseAuthority: 'LEGACY_VERIFIED_BRIDGE',
    release,
    manifest,
    products,
    policies,
    partners,
    inventory
  };
}

export function buildSheetBridgeHandoff(
  bridge: SheetBridgeRelease,
  workbook: SheetHandoffWorkbook,
  generatedAt = new Date().toISOString()
): SheetPublicationHandoff {
  if (!time(generatedAt)) fail('INVALID_SHEET_HANDOFF_GENERATED_AT');
  const consumerId = workbook === 'F01'
    ? 'google-sheets-f01'
    : 'google-sheets-f86';

  const unsigned: Omit<SheetPublicationHandoff, 'handoffHash'> = {
    contractVersion: 'freepass-sheet-handoff-v1',
    consumerId,
    workbook,
    generatedAt,
    releaseAuthority: bridge.releaseAuthority,
    approvedRelease: { ...bridge.release },
    manifest: structuredClone(bridge.manifest),
    snapshot: {
      version: 1,
      snapshotId: bridge.release.releaseId,
      capturedAt: bridge.release.observedAt,
      products: structuredClone(bridge.products),
      policies: structuredClone(bridge.policies),
      partners: structuredClone(bridge.partners),
      inventory: structuredClone(bridge.inventory)
    }
  };

  return {
    ...unsigned,
    handoffHash: hashSheetPublicationHandoff(unsigned)
  };
}


/** Prepare requested outputs from exactly one read-only capture and one release.
 * This is shadow preparation only: no publication or canonical approval is issued.
 */
export async function prepareSheetBridgeHandoffs(
  rpc: Erp5ReadRpc,
  workbooks: readonly SheetHandoffWorkbook[] = ['F01', 'F86']
) {
  if (workbooks.length === 0 || new Set(workbooks).size !== workbooks.length ||
      workbooks.some((workbook) => workbook !== 'F01' && workbook !== 'F86')) {
    fail('INVALID_SHEET_HANDOFF_TARGETS');
  }
  const capture = await captureErp5SheetSource(rpc);
  const bridge = buildSheetBridgeRelease(capture);
  const generatedAt = new Date().toISOString();
  const handoffs = workbooks.map((workbook) => {
    const handoff = buildSheetBridgeHandoff(bridge, workbook, generatedAt);
    if (validateSheetPublicationHandoff(handoff).status !== 'PASS') {
      fail('SHEET_HANDOFF_SELF_VALIDATION_FAILED');
    }
    return handoff;
  });
  return { capture, bridge, handoffs };
}
