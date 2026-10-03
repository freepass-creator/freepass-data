import type {
  FreePassSourceLaneId,
  SourceCoverage,
  SourceKind,
} from './source.js';

export type { FreePassSourceLaneId } from './source.js';

export type FreePassSourceLane = {
  laneId: FreePassSourceLaneId;
  displayName: string;
  purpose: string;
  rawFirst: true;
  canonicalTarget: string;
  normalizerOwner: string;
};

export const FREEPASS_SOURCE_LANES: readonly FreePassSourceLane[] = [
  {
    laneId: 'SUPPLIER',
    displayName: '공급사 원천',
    purpose: '공급사/제휴사 식별, 코드, 표시명, 운영 상태와 출처를 원문 그대로 수집',
    rawFirst: true,
    canonicalTarget: 'Supplier/Partner facts',
    normalizerOwner: 'freepass-data/catalog',
  },
  {
    laneId: 'PRODUCT_VEHICLE',
    displayName: '차량·상품 원천',
    purpose: '공급사 상품, 재고 차량, 가격, 보증금, 기간, 정책 참조와 판매 상태를 수집',
    rawFirst: true,
    canonicalTarget: 'VehicleAsset/Product/Offer/Policy',
    normalizerOwner: 'freepass-data/catalog',
  },
  {
    laneId: 'VEHICLE_MASTER',
    displayName: '차종마스터 원천',
    purpose: '제조사·모델·세대·연식·파워트레인·트림·옵션·색상·당시 가격의 근거를 수집',
    rawFirst: true,
    canonicalTarget: 'Vehicle Master identity graph',
    normalizerOwner: 'freepass-data/vehicle-master',
  },
  {
    laneId: 'SETTLEMENT',
    displayName: '정산 원천',
    purpose: '청구·수금·지급·수수료·환수·조정과 원 거래/계약 연결 근거를 수집',
    rawFirst: true,
    canonicalTarget: 'Settlement facts/evidence',
    normalizerOwner: 'freepass-admin/settlement',
  },
] as const;

export type SourceIntakeEnvelope = {
  laneId: FreePassSourceLaneId;
  sourceId: string;
  sourceRecordId: string;
  observedAt: string;
  sourceRevision?: string | null;
  checksum?: string | null;
  payload: Record<string, unknown>;
};

export type SourceIntakeBatch = {
  laneId: FreePassSourceLaneId;
  source: {
    sourceId: string;
    kind: SourceKind;
    displayName: string;
    authorityScope?: string[];
    expectedFreshnessSeconds?: number | null;
  };
  observedAt: string;
  /** Separate upstream observation times for non-atomic multi-bucket reads. */
  observationTimes?: string[];
  sourceRevision?: string | null;
  checksum?: string | null;
  coverage: SourceCoverage;
  records: Array<{
    sourceRecordId: string;
    sourceFingerprint?: string | null;
    payload: Record<string, unknown>;
  }>;
};

/** Transport stays provider-owned; every adapter returns the existing RAW contract. */
export const SUPPLIER_SOURCE_ADAPTERS = {
  'sonogong-api': { supplierCode: 'RP012', kind: 'API', scopes: ['inventory', 'terms', 'photos'] },
  'iancar-one-api': { supplierCode: 'RP031', kind: 'API', scopes: ['inventory', 'terms', 'policy', 'photos'] },
  'iancar-original-erp': { supplierCode: 'RP031', kind: 'API', scopes: ['inventory'] },
  // Welrix's existing provided sheet only (pre-switch comparison). RP013 now enters through the
  // shared supplier input sheet (contracts/supplier-input-sheet-spec.v1.json supplierChannels);
  // do not wire this adapter as the new source.
  'welrix-sheet': { supplierCode: 'RP013', kind: 'GOOGLE_SHEET', scopes: ['inventory', 'terms', 'policy'] },
  'aica-sheet': { supplierCode: 'RP004', kind: 'GOOGLE_SHEET', scopes: ['inventory', 'terms', 'photos'] },
  'iron-html': { supplierCode: 'RP006', kind: 'API', scopes: ['inventory', 'terms', 'photos'] },
} as const;

export type SupplierSourceAdapterId = keyof typeof SUPPLIER_SOURCE_ADAPTERS;
export type SupplierCaptureScope = 'inventory' | 'terms' | 'policy' | 'photos';

/** Original Google CellData subset; no photo or monetary normalization. */
export type SupplierGridCell = {
  userEnteredValue?: Record<string, unknown>; effectiveValue?: Record<string, unknown>;
  formattedValue?: string; hyperlink?: string;
  userEnteredFormat?: { textFormat?: { link?: { uri?: string } } };
  textFormatRuns?: Array<{ startIndex?: number; format?: { link?: { uri?: string } } }>;
};
export type AicaGridBinding = { sheetId: string; tabId: number; range: string; plateColumn: number };
export type AicaGridObservation = AicaGridBinding & {
  observedAt: string; revision: string; complete: boolean; expectedRows: number | null;
  /** Zero-based absolute Sheet row of the first data row (headers excluded). */
  firstDataRow: number; headers: SupplierGridCell[]; rows: SupplierGridCell[][];
};

export type SupplierSourceAdapter = {
  adapterId: SupplierSourceAdapterId;
  sourceId: string;
  scope: SupplierCaptureScope;
  // Provider-specific auth, buckets, pagination and Sheet ranges belong here.
  read: () => Promise<SourceIntakeBatch>;
};

/** RAW admission only. Never establishes Canonical approval or absence/deletion. */
export function inspectSupplierSourceBatch(
  adapter: Pick<SupplierSourceAdapter, 'adapterId' | 'sourceId' | 'scope'>,
  batch: SourceIntakeBatch,
  capturedAt: string,
) {
  const profile = SUPPLIER_SOURCE_ADAPTERS[adapter.adapterId];
  if (!profile || !(profile.scopes as readonly string[]).includes(adapter.scope))
    throw new Error('UNSUPPORTED_SUPPLIER_ADAPTER_SCOPE');
  validateSourceIntakeBatch(batch);
  if (batch.laneId !== 'PRODUCT_VEHICLE' || batch.source.sourceId !== adapter.sourceId
    || batch.source.kind !== profile.kind) throw new Error('SUPPLIER_SOURCE_BINDING_MISMATCH');
  const issues: string[] = [];
  const current = Date.parse(capturedAt);
  const observed = Date.parse(batch.observedAt);
  const threshold = batch.source.expectedFreshnessSeconds;
  if (!Number.isFinite(current)) throw new Error('INVALID_SUPPLIER_CAPTURE_TIME');
  const times = batch.observationTimes?.map(time => Date.parse(time)) ?? [observed];
  if (!times.length || times.some(time => !Number.isFinite(time)) || Math.min(...times) !== observed)
    throw new Error('INVALID_SUPPLIER_OBSERVATION_TIMES');
  if (times.some(time => time > current)) issues.push('SOURCE_TIME_IN_FUTURE');
  if (threshold == null || threshold <= 0) issues.push('SOURCE_FRESHNESS_UNKNOWN');
  else if (current - observed > threshold * 1000) issues.push('SOURCE_STALE');
  if (!batch.sourceRevision || !batch.checksum || batch.records.some(r => !r.sourceFingerprint))
    issues.push('SOURCE_EVIDENCE_INCOMPLETE');
  if (batch.coverage.mode !== 'FULL' || batch.coverage.completeness !== 'COMPLETE')
    issues.push('SOURCE_COVERAGE_NOT_COMPLETE');
  if (!batch.coverage.scope?.trim()) issues.push('SOURCE_SCOPE_UNKNOWN');
  if (batch.records.length === 0) issues.push('EMPTY_SOURCE_REQUIRES_REVIEW');
  // Provider diagnostics stay with immutable RAW evidence, not a second store.
  // Only these versioned native payloads own this diagnostics field.
  if (adapter.adapterId === 'aica-sheet' || adapter.adapterId === 'iron-html') {
    for (const record of batch.records) {
      const diagnostics = record.payload.captureIssues;
      if (!Array.isArray(diagnostics) || diagnostics.some(issue => typeof issue !== 'string')) {
        issues.push('SOURCE_DIAGNOSTICS_MISSING');
      } else {
        for (const issue of diagnostics as string[]) if (!issues.includes(issue)) issues.push(issue);
      }
    }
  }
  return {
    adapterId: adapter.adapterId, supplierCode: profile.supplierCode, scope: adapter.scope,
    capturedAt, observedAt: batch.observedAt, recordCount: batch.records.length,
    status: issues.length ? 'HOLD' : 'RAW_READY', issues,
    // Even full captures must pass the existing source-head/authority/review path.
    canonicalWriteAuthorized: false, publicationAuthorized: false, retirementAuthorized: false,
  } as const;
}

export async function collectSupplierSource(adapter: SupplierSourceAdapter, capturedAt?: string) {
  // Validate registration before invoking transport (including credentials).
  const profile = SUPPLIER_SOURCE_ADAPTERS[adapter.adapterId];
  if (!profile || !(profile.scopes as readonly string[]).includes(adapter.scope) || !adapter.sourceId.trim())
    throw new Error('UNSUPPORTED_SUPPLIER_ADAPTER_SCOPE');
  const batch = await adapter.read();
  return { batch, evidence: inspectSupplierSourceBatch(adapter, batch, capturedAt ?? new Date().toISOString()) };
}

const nonBlank = (value: string) => Boolean(value.trim());
const sha256 = (value: string) => /^[a-f0-9]{64}$/i.test(value);
const sourceKinds = new Set<SourceKind>([
  'FIRESTORE',
  'GOOGLE_SHEET',
  'API',
  'FILE',
  'MANUAL',
]);
const coverageModes = new Set(['FULL', 'DELTA', 'PARTIAL', 'UNKNOWN']);
const completeness = new Set(['COMPLETE', 'INCOMPLETE', 'UNKNOWN']);

export function sourceLane(laneId: FreePassSourceLaneId) {
  const lane = FREEPASS_SOURCE_LANES.find((item) => item.laneId === laneId);
  if (!lane) throw new Error('UNKNOWN_FREEPASS_SOURCE_LANE');
  return lane;
}

export function validateSourceIntakeEnvelope(input: SourceIntakeEnvelope) {
  sourceLane(input.laneId);

  if (
    !nonBlank(input.sourceId) ||
    !nonBlank(input.sourceRecordId) ||
    !Number.isFinite(Date.parse(input.observedAt)) ||
    !input.payload ||
    typeof input.payload !== 'object' ||
    Array.isArray(input.payload)
  ) {
    throw new Error('INVALID_SOURCE_INTAKE_ENVELOPE');
  }

  if (input.sourceRevision != null && !nonBlank(input.sourceRevision)) {
    throw new Error('INVALID_SOURCE_INTAKE_REVISION');
  }
  if (input.checksum != null && !sha256(input.checksum)) {
    throw new Error('INVALID_SOURCE_INTAKE_CHECKSUM');
  }

  return true;
}

export function validateSourceIntakeBatch(input: SourceIntakeBatch) {
  sourceLane(input.laneId);
  if (
    !nonBlank(input.source.sourceId) ||
    !nonBlank(input.source.displayName) ||
    !sourceKinds.has(input.source.kind) ||
    !Number.isFinite(Date.parse(input.observedAt)) ||
    !coverageModes.has(input.coverage.mode) ||
    !completeness.has(input.coverage.completeness) ||
    !Array.isArray(input.records)
  ) {
    throw new Error('INVALID_SOURCE_INTAKE_BATCH');
  }
  if (
    input.source.expectedFreshnessSeconds != null &&
    (!Number.isSafeInteger(input.source.expectedFreshnessSeconds) ||
      input.source.expectedFreshnessSeconds < 0)
  ) {
    throw new Error('INVALID_SOURCE_INTAKE_FRESHNESS');
  }
  if (
    input.source.authorityScope?.some(
      (value) => typeof value !== 'string' || !nonBlank(value)
    )
  ) {
    throw new Error('INVALID_SOURCE_INTAKE_AUTHORITY_SCOPE');
  }
  if (input.sourceRevision != null && !nonBlank(input.sourceRevision)) {
    throw new Error('INVALID_SOURCE_INTAKE_REVISION');
  }
  if (input.checksum != null && !sha256(input.checksum)) {
    throw new Error('INVALID_SOURCE_INTAKE_CHECKSUM');
  }

  const ids = new Set<string>();
  for (const record of input.records) {
    if (
      !nonBlank(record.sourceRecordId) ||
      ids.has(record.sourceRecordId) ||
      !record.payload ||
      typeof record.payload !== 'object' ||
      Array.isArray(record.payload)
    ) {
      throw new Error('INVALID_SOURCE_INTAKE_RECORD');
    }
    if (
      record.sourceFingerprint != null &&
      !sha256(record.sourceFingerprint)
    ) {
      throw new Error('INVALID_SOURCE_INTAKE_FINGERPRINT');
    }
    ids.add(record.sourceRecordId);
  }

  return true;
}
