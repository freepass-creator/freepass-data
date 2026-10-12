import { createHash } from 'node:crypto';
import type { CommercialType } from './catalog.js';
import { orderedJsonDigest } from '../shared/stable-digest.js';

export const F86_OUTPUT_CONTRACT = {
  contractId: 'f86-hahuhho-v1',
  owner: 'freepass-data',
  consumer: 'F86_HAHUHHO',
  presentation: 'RETRO',
  groupBy: 'SUPPLIER',
  minimumLongTermMonths: 24,
  commonFeeColumns: ['장기보증', '24개월', '36개월', '48개월', '60개월'],
  supplierFeeColumns: {
    RP012: [
      '보증금 반납형',
      '24개월 반납형', '36개월 반납형', '48개월 반납형', '60개월 반납형',
      '보증금 인수형',
      '24개월 인수형', '36개월 인수형', '48개월 인수형', '60개월 인수형'
    ],
    RP023: [
      '보증금',
      '24개월 2만km', '24개월 3만km',
      '36개월 2만km', '36개월 3만km'
    ]
  }
} as const;

type SonokongClassification =
  | {
      status: 'CLASSIFIED';
      supplierId: 'RP012';
      supplierGroup: 'SONOKONG';
      outputGroup: 'SONOGONG_PRODUCTS' | 'PICKUP_SUBSCRIPTION';
      commercialType: CommercialType;
      evidence: 'TCAR_BUCKET' | 'SONOKONG_BUCKET_AND_PLATE';
    }
  | {
      status: 'HOLD';
      supplierId: 'RP012';
      supplierGroup: 'SONOKONG';
      outputGroup: 'SONOGONG_PRODUCTS' | 'PICKUP_SUBSCRIPTION' | 'HOLD';
      reason: 'UNKNOWN_SONOKONG_BUCKET' | 'MISSING_PLATE_FOR_RENT_DECISION';
    };

const rentPlateLetter = (plateNumber: unknown) =>
  String(plateNumber ?? '').trim().match(/([가-힣])\s*\d{4}$/)?.[1] ?? '';

export const isKoreanRentPlate = (plateNumber: unknown) =>
  new Set(['하', '허', '호']).has(rentPlateLetter(plateNumber));

/**
 * Supplier ownership and commercial type are separate axes.
 * Every accepted record remains in the Sonogong supplier group; the bucket and
 * rental plate evidence decide only which commercial type it carries.
 */
export function classifySonokongRecord(input: {
  bucket?: unknown;
  plateNumber?: unknown;
}): SonokongClassification {
  const bucket = String(input.bucket ?? '').trim();
  if (bucket === 'TCAR_EXTERNAL') {
    return {
      status: 'CLASSIFIED',
      supplierId: 'RP012',
      supplierGroup: 'SONOKONG',
      outputGroup: 'PICKUP_SUBSCRIPTION',
      commercialType: 'PICKUP_SUBSCRIPTION',
      evidence: 'TCAR_BUCKET'
    };
  }
  if (bucket !== 'SON_NO_KONG') {
    return {
      status: 'HOLD',
      supplierId: 'RP012',
      supplierGroup: 'SONOKONG',
      outputGroup: 'HOLD',
      reason: 'UNKNOWN_SONOKONG_BUCKET'
    };
  }
  if (!String(input.plateNumber ?? '').trim()) {
    return {
      status: 'HOLD',
      supplierId: 'RP012',
      supplierGroup: 'SONOKONG',
      outputGroup: 'HOLD',
      reason: 'MISSING_PLATE_FOR_RENT_DECISION'
    };
  }
  return {
    status: 'CLASSIFIED',
    supplierId: 'RP012',
    supplierGroup: 'SONOKONG',
    outputGroup: 'SONOGONG_PRODUCTS',
    commercialType: isKoreanRentPlate(input.plateNumber) ? 'USED_RENT' : 'OGONG_SUBSCRIPTION',
    evidence: 'SONOKONG_BUCKET_AND_PLATE'
  };
}

const feeMonths = (column: string) => {
  const match = String(column).trim().match(/^(\d+)개월/);
  return match?.[1] ? Number(match[1]) : null;
};

/** F86 receives long-term fee columns only. Deposit/rule columns have no month. */
export function validateF86FeeColumns(feeColumns: readonly string[]) {
  const violations = feeColumns.filter((column) => {
    const months = feeMonths(column);
    return months !== null && months < F86_OUTPUT_CONTRACT.minimumLongTermMonths;
  });
  return {
    status: violations.length ? 'HOLD' as const : 'PASS' as const,
    violations: violations.map((column) => ({
      column,
      reason: 'F86_LONG_TERM_ONLY' as const
    }))
  };
}


/**
 * RP012 구독/픽업 보증금은 금액을 원자에 계산해 고정하지 않고 규칙을 보존한다.
 * 중고렌트는 실제 숫자 보증금이 정본이므로 이 규칙의 검사 대상이 아니다.
 */
export const SONOKONG_DEPOSIT_RULE_TEXT =
  '월 대여료 × 약정연수 (최대 3개월)' as const;

export function hasSonokongDepositRuleViolation(input: {
  depositNote?: unknown;
  productType?: unknown;
  classificationProductType?: unknown;
  price?: unknown;
}) {
  if (String(input.depositNote ?? '').trim() !== SONOKONG_DEPOSIT_RULE_TEXT) {
    return false;
  }
  if (
    String(
      input.classificationProductType ??
      input.productType ??
      ''
    ).trim() === '중고렌트'
  ) {
    return false;
  }
  if (!input.price || typeof input.price !== 'object' || Array.isArray(input.price)) {
    return false;
  }
  return Object.values(input.price as Record<string, unknown>).some((term) => {
    if (!term || typeof term !== 'object' || Array.isArray(term)) return false;
    return Number((term as Record<string, unknown>).deposit) > 0;
  });
}


type Rec = Record<string, unknown>;
export type ApprovedVehiclePhotoRef = {
  driveFileId: string; sha256: string; mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  vehiclePhotoVerifiedBy: string; vehiclePhotoVerificationMethod: string; vehiclePhotoVerifiedAt: string;
  role: 'VEHICLE_PHOTO'; zone: '차량사진'; approvedAt: string; vehicleKey: string;
};
export type ApprovedPhotoReader = (ref: ApprovedVehiclePhotoRef) => Promise<{ bytes: Buffer; contentType: string }>;
export const VEHICLE_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const VEHICLE_PHOTO_CACHE_BYTES = 64 * 1024 * 1024;
export const VEHICLE_PHOTO_CACHE_TTL_MS = 30_000;
export const VEHICLE_PHOTO_MAX_CONCURRENT = 8;

/** One media policy for transport preflight, streamed size checks and complete bytes. */
export function validateVehiclePhotoMedia(contentType: unknown, size: number, bytes?: unknown): 'INVALID' | 'OVERSIZED' | 'SIGNATURE_INVALID' | undefined {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(String(contentType)) || !Number.isSafeInteger(size) || size < 0) return 'INVALID';
  if (size > VEHICLE_PHOTO_MAX_BYTES) return 'OVERSIZED';
  if (arguments.length === 2) return;
  if (!Buffer.isBuffer(bytes) || bytes.length !== size || !size) return 'SIGNATURE_INVALID';
  const valid = contentType === 'image/jpeg' ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    : contentType === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return valid ? undefined : 'SIGNATURE_INVALID';
}

/** Content review is independent of supplier trust, vehicle ownership and raster format. */
export function hasVehiclePhotoVerification(product: Rec | undefined): boolean {
  const refs = product?.photo_original_refs;
  return Array.isArray(refs) && refs.length > 0 && refs.length <= 200 && Array.from(refs).every(ref => {
    if (!ref || typeof ref !== 'object') return false;
    const at = ref.vehiclePhotoVerifiedAt;
    return ['vehiclePhotoVerifiedBy', 'vehiclePhotoVerificationMethod'].every(key => typeof ref[key] === 'string' && !!ref[key].trim())
      && typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(at)
      && Number.isFinite(Date.parse(at)) && new Date(at).toISOString() === at.replace(/Z$/, at.includes('.') ? 'Z' : '.000Z');
  });
}

/** Derived only from product authority, never from an approved reference. */
export function vehiclePhotoKey(product: Rec): string | undefined {
  const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  const supplier = text(product.provider_company_code) || text(product.partner_code);
  const vehicleId = text(product.supplier_vehicle_id);
  if (!supplier) return undefined;
  if (vehicleId) return createHash('sha256').update(JSON.stringify(['vehicle', supplier, vehicleId])).digest('hex');
  const plate = text(product.car_number);
  return plate ? createHash('sha256').update(JSON.stringify(['plate', supplier, plate])).digest('hex') : undefined;
}

export function isApprovedVehiclePhotoProduct(product: Rec | undefined): product is Rec & { photo_original_refs: ApprovedVehiclePhotoRef[] } {
  if (!hasVehiclePhotoVerification(product) || !product || product.listable !== true || product._deleted || product.deletedAt || product.publication_withdrawal
    || !['가용', '선점'].includes(String(product.status_kind))) return false;
  const vehicleKey = vehiclePhotoKey(product);
  if (!vehicleKey) return false;
  const refs = product.photo_original_refs;
  return Array.isArray(refs) && refs.length >= 1 && refs.length <= 200 && Array.from(refs).every(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const ref = value as Rec;
    return typeof ref.driveFileId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(ref.driveFileId)
      && typeof ref.sha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.sha256)
      && !validateVehiclePhotoMedia(ref.mediaType, 0)
      && ref.role === 'VEHICLE_PHOTO' && ref.zone === '차량사진'
      && typeof ref.vehicleKey === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(ref.vehicleKey)
      && ref.vehicleKey === vehicleKey
      && typeof ref.approvedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(ref.approvedAt)
      && Number.isFinite(Date.parse(ref.approvedAt))
      && new Date(ref.approvedAt).toISOString() === ref.approvedAt.replace(/Z$/, ref.approvedAt.includes('.') ? 'Z' : '.000Z');
  });
}

export function isPublicIancarPhotoProduct(product: Record<string, unknown> | undefined): boolean {
  return !!product && product.provider_company_code === 'RP031' && product.listable === true
    && !product._deleted && !product.deletedAt && !product.publication_withdrawal
    && ['가용', '선점'].includes(String(product.status_kind))
    && typeof product.iancar_one_vehicle_id === 'string' && !!product.iancar_one_vehicle_id.trim()
    && typeof product.car_number === 'string' && !!product.car_number.trim();
}

/** ID 기반 서빙 게이트용: 상품 문서에 등록된 ONE 사진 ID 목록(중복·빈 값 없음, 1~200개). 없으면 게이트 대상 아님. */
export function idGatePhotoIds(product: Rec | undefined): string[] | undefined {
  const ids = product?.iancar_one_photo_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 200) return undefined;
  if (!ids.every(id => typeof id === 'string' && !!id.trim()) || new Set(ids).size !== ids.length) return undefined;
  return [...ids] as string[];
}

export type IancarPhotoReviewBinding = { productId: string; vehicleId: string; plate: string; count: number; observedAt: string };

/** Human-supplied review of one fixed ONE album; never synthesized by collection. */
export type IancarOnePhotoReview = {
  basis?: 'CONTENT_ORDINAL/1';
  sourceRepresentatives?: boolean[];
  upstreamPhotoIds?: string[];
  servingPhotoIds?: string[];
  refs: Array<{
    sourceKind: 'IANCAR_ONE'; sourceApiVersion: 'iancar-one-api/1';
    sourceBindingDigest: string; photoSetDigest: string; sourcePhotoIdDigest: string;
    sourceOrdinal: number; servingIndex: number;
    reviewBasis?: 'CONTENT_ORDINAL/1'; representative?: boolean;
    mediaType: 'image/jpeg' | 'image/png' | 'image/webp'; photoSha256: string;
    sourceObservedAt: string;
    vehiclePhotoVerifiedBy: string; vehiclePhotoVerificationMethod: string; vehiclePhotoVerifiedAt: string;
  }>;
};

/** Content authority excludes rotating upstream access handles. */
export function iancarReviewedContentSetDigest(binding: string, refs: readonly Record<string, unknown>[]): string {
  return orderedJsonDigest(['ONE_REVIEWED_CONTENT_SET/1', binding, refs.map(ref =>
    [ref.sourceOrdinal, ref.servingIndex, ref.representative, ref.mediaType, ref.photoSha256])]);
}

/** Pure opt-in plan. Existing photo publication does not infer or populate approval. */
export function planIancarPhotoReviewPatch(original: Record<string, unknown>, row: IancarPhotoReviewBinding,
  review: IancarOnePhotoReview, now = Date.now()): Record<string, unknown> {
  const fail = () => { throw new Error('IANCAR_PHOTO_REVIEW_INVALID'); };
  const instant = (value: unknown) => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z');
  if (!isPublicIancarPhotoProduct(original) || original.iancar_one_vehicle_id !== row.vehicleId
    || String(original.car_number).replace(/\s/g, '') !== row.plate.replace(/\s/g, '')
    || !Number.isSafeInteger(row.count) || row.count < 1 || row.count > 200
    || !instant(row.observedAt) || now - Date.parse(row.observedAt) > 900_000
    || Date.parse(row.observedAt) > now + 60_000) fail();
  const validIds = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.length === row.count
    && ids.every(id => typeof id === 'string' && id.trim() === id && !!id && id.length <= 2048)
    && new Set(ids).size === ids.length;
  if (!review || !hasVehiclePhotoVerification({ photo_original_refs: review.refs }) || review.refs.length !== row.count) fail();
  const contentBasis = review.basis === 'CONTENT_ORDINAL/1';
  if (review.basis !== undefined && !contentBasis) fail();
  // A lost capture handle cannot be reconstructed from its digest or replaced by a current handle.
  const captureIdsPresent = review.upstreamPhotoIds !== undefined || review.servingPhotoIds !== undefined;
  if ((!contentBasis || captureIdsPresent) && (!validIds(review.upstreamPhotoIds) || !validIds(review.servingPhotoIds)
    || review.servingPhotoIds!.some(id => !review.upstreamPhotoIds!.includes(id)))) fail();
  if (contentBasis && (!Array.isArray(review.sourceRepresentatives) || review.sourceRepresentatives.length !== row.count
    || review.sourceRepresentatives.some(value => typeof value !== 'boolean')
    || review.sourceRepresentatives.filter(Boolean).length > 1)) fail();
  if (new Set(review.refs.map(ref => ref.sourceOrdinal)).size !== row.count
    || new Set(review.refs.map(ref => ref.sourcePhotoIdDigest)).size !== row.count) fail();
  const binding = orderedJsonDigest(['RP031', row.productId, row.vehicleId, row.plate.replace(/\s/g, '')]);
  const set = contentBasis ? iancarReviewedContentSetDigest(binding, review.refs)
    : orderedJsonDigest(['ONE_PHOTO_SET/1', binding, review.upstreamPhotoIds, review.servingPhotoIds]);
  const allowed = new Set(['sourceKind', 'sourceApiVersion', 'sourceBindingDigest', 'photoSetDigest',
    'sourcePhotoIdDigest', 'sourceOrdinal', 'servingIndex', 'mediaType', 'photoSha256', 'sourceObservedAt',
    'vehiclePhotoVerifiedBy', 'vehiclePhotoVerificationMethod', 'vehiclePhotoVerifiedAt', 'reviewBasis', 'representative']);
  review.refs.forEach((ref, index) => {
    if (Object.keys(ref).some(key => !allowed.has(key)) || ref.sourceKind !== 'IANCAR_ONE'
      || ref.sourceApiVersion !== 'iancar-one-api/1' || ref.sourceBindingDigest !== binding
      || ref.photoSetDigest !== set || !/^[a-f0-9]{64}$/.test(ref.sourcePhotoIdDigest)
      || (captureIdsPresent && (ref.sourcePhotoIdDigest !== orderedJsonDigest(review.servingPhotoIds![index])
        || ref.sourceOrdinal !== review.upstreamPhotoIds!.indexOf(review.servingPhotoIds![index]!)))
      || ref.servingIndex !== index || !Number.isSafeInteger(ref.sourceOrdinal) || ref.sourceOrdinal < 0 || ref.sourceOrdinal >= row.count
      || (contentBasis ? (ref.reviewBasis !== 'CONTENT_ORDINAL/1'
        || ref.representative !== review.sourceRepresentatives![ref.sourceOrdinal])
        : (ref.reviewBasis !== undefined || ref.representative !== undefined))
      || !['image/jpeg', 'image/png', 'image/webp'].includes(ref.mediaType) || !/^[a-f0-9]{64}$/.test(ref.photoSha256)
      || !instant(ref.sourceObservedAt) || ref.sourceObservedAt !== review.refs[0]!.sourceObservedAt
      || Date.parse(ref.sourceObservedAt) > Date.parse(row.observedAt) || !instant(ref.vehiclePhotoVerifiedAt)
      || Date.parse(ref.vehiclePhotoVerifiedAt) < Date.parse(ref.sourceObservedAt) || Date.parse(ref.vehiclePhotoVerifiedAt) > now
      || !/^ONE 차량사진 전용 확인; 범위=\S[\s\S]*; 방법=\S[\s\S]*; 근거=\S[\s\S]*$/.test(ref.vehiclePhotoVerificationMethod)) fail();
  });
  if (contentBasis) {
    const expected = review.sourceRepresentatives!.map((representative, ordinal) => ({ ordinal, representative }))
      .sort((a, b) => Number(b.representative) - Number(a.representative)).map(photo => photo.ordinal);
    if (orderedJsonDigest(expected) !== orderedJsonDigest(review.refs.map(ref => ref.sourceOrdinal))) fail();
  }
  return { provider_company_code: 'RP031', photo_original_refs: review.refs.map(ref => ({ ...ref })),
    ...(!contentBasis ? { iancar_one_photo_ids: [...review.servingPhotoIds!] } : {}) };
}

/** Source adapters supply identity and bytes; authorization and validation stay in one pipeline. */
export type VehiclePhotoRead = {
  count: number; bytes: Buffer | null; contentType: string;
  photoIds?: string[]; upstreamPhotoIds?: string[];
  upstreamRepresentatives?: boolean[]; servingSourceOrdinals?: number[];
};
export type VehiclePhotoSource = {
  eligible(product: Rec | undefined): boolean;
  connection(product: Rec): string;
  read(product: Rec, index?: number, fresh?: boolean): Promise<VehiclePhotoRead>;
};

export const PHOTO_READ_FAILURE_PHASES = ['INITIAL_DB', 'INITIAL_GATE', 'SOURCE_AWAIT', 'RESULT_LAYOUT', 'RESULT_MEDIA', 'RESULT_HASH', 'FINAL_DB', 'FINAL_GATE', 'FINAL_SOURCE', 'FINAL_MEMBERSHIP', 'REUSE_TTL'] as const;
export const PHOTO_READ_FAILURE_REASONS = ['DB_FAILURE', 'CONSUMER_DENIED', 'REQUEST_INVALID', 'PUBLIC_INELIGIBLE', 'APPROVAL_INVALID', 'BASIS_INVALID', 'SOURCE_UNAVAILABLE', 'SOURCE_NOT_FOUND', 'SOURCE_BUSY', 'LAYOUT_MISMATCH', 'SELECTED_MISSING', 'MEDIA_INVALID', 'HASH_MISMATCH', 'PROOF_CHANGED', 'MEMBERSHIP_MISMATCH', 'REUSE_EXPIRED', 'UNKNOWN'] as const;
export type VehiclePhotoReadFailure = Readonly<{ operation: 'INDEXED' | 'MANIFEST'; phase: typeof PHOTO_READ_FAILURE_PHASES[number]; reason: typeof PHOTO_READ_FAILURE_REASONS[number]; elapsedMs: number; phaseElapsedMs: number }>;
export type VehiclePhotoReadFailureObserver = (failure: VehiclePhotoReadFailure) => void | Promise<void>;

export function createVehiclePhotoReader(
  readProduct: (productId: string) => Promise<Rec | undefined>,
  iancarSource?: VehiclePhotoSource,
  approvedPhotoReader?: ApprovedPhotoReader,
  now: () => number = Date.now,
  observer?: VehiclePhotoReadFailureObserver,
  /** 공급사 코드 허용 목록. 비어 있으면(기본) ID 기반 게이트는 꺼져 있다. 켜진 공급사는 검수 refs 없이도 상품 문서에 등록된 ONE 사진 ID 로만 서빙한다. */
  idGateSuppliers: ReadonlySet<string> = new Set(),
) {
  const cache = new Map<string, { bytes: Buffer; contentType: string; expiresAt: number }>();
  type ReviewedImage = { result: VehiclePhotoRead; expiresAt: number; productId: string; connection: string };
  const pendingReviewed = new Map<string, Promise<ReviewedImage>>();
  const reviewedCache = new Map<string, ReviewedImage>();
  let reviewedBytes = 0;
  const removeReviewed = (key: string) => {
    const entry = reviewedCache.get(key);
    if (entry) reviewedBytes -= entry.result.bytes?.length ?? 0;
    reviewedCache.delete(key);
  };
  const invalidateReviewed = (productId: string) => {
    for (const [key, entry] of reviewedCache) if (entry.productId === productId) removeReviewed(key);
  };
  let totalBytes = 0;
  let active = 0;
  const remove = (key: string) => { const entry = cache.get(key); if (entry) totalBytes -= entry.bytes.length; cache.delete(key); };
  const approvedSource: VehiclePhotoSource = {
    eligible: isApprovedVehiclePhotoProduct,
    connection: product => JSON.stringify(product.photo_original_refs),
    read: async (product, index) => {
      if (!approvedPhotoReader) throw new Error('VEHICLE_PHOTO_READER_UNAVAILABLE');
      const refs = product.photo_original_refs as ApprovedVehiclePhotoRef[];
      if (index === undefined) return { count: refs.length, bytes: null, contentType: 'application/json' };
      const ref = refs[index];
      if (!ref) throw new Error('VEHICLE_PHOTO_NOT_FOUND');
      return { count: refs.length, ...await approvedPhotoReader({ ...ref }) };
    },
  };
  const sources = [...(iancarSource ? [iancarSource] : []), approvedSource];
  const recheckIds = async (check: () => Promise<boolean>) => { if (!await check()) throw new Error('VEHICLE_PHOTO_NOT_FOUND'); };
  return async (consumerId: string, productId: string, index?: number) => {
    // Diagnostic time is independent of the injected cache clock.
    const tick = () => { try { return performance.now(); } catch { return NaN; } };
    const started = observer ? tick() : 0;
    let phaseStarted = started, emitted = false;
    let phase: VehiclePhotoReadFailure['phase'] = 'INITIAL_GATE';
    const enter = (value: VehiclePhotoReadFailure['phase']) => { phase = value; if (observer) phaseStarted = tick(); };
    const emit = (reason: VehiclePhotoReadFailure['reason'], at = phase) => {
      if (!observer || emitted) return;
      emitted = true;
      const end = tick();
      const duration = (start: number) => Number.isFinite(end - start) && end >= start ? Math.min(300_000, Math.floor(end - start)) : 0;
      try { void Promise.resolve(observer(Object.freeze({ operation: index === undefined ? 'MANIFEST' : 'INDEXED', phase: at, reason, elapsedMs: duration(started), phaseElapsedMs: duration(phaseStarted) }))).catch(() => {}); } catch { /* Observation cannot change a read. */ }
    };
    if (!(consumerId === 'erp-com' || consumerId === 'erp5-public-media' || /^whitelabel-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(consumerId))) { emit('CONSUMER_DENIED'); throw new Error('VEHICLE_PHOTO_CONSUMER_FORBIDDEN'); }
    if (!productId || productId.length > 200 || /[\/\u0000-\u001f\u007f]/.test(productId)
      || (index !== undefined && (!Number.isSafeInteger(index) || index < 0 || index >= 200))) { emit('REQUEST_INVALID'); throw new Error('VEHICLE_PHOTO_REQUEST_INVALID'); }
    enter('INITIAL_DB');
    let product: Rec | undefined;
    try { product = await readProduct(productId); } catch (error) { emit('DB_FAILURE'); invalidateReviewed(productId); throw error; }
    enter('INITIAL_GATE');
    const gateIds = idGatePhotoIds(product);
    if (iancarSource && product && gateIds && idGateSuppliers.has(String(product.provider_company_code))
      && isPublicIancarPhotoProduct(product) && !hasVehiclePhotoVerification(product)) {
      // ID 기반 게이트: 요청 키는 순번뿐이다(임의 ID 불가). 상품 문서에 사진 ID 가 등록돼 있고 원천 앨범의 «개수»가 등록 개수와 같을 때만
      // 서빙한다. ONE 은 사진 ID 를 재발급하므로(등록 ID 와 현재 ID 의 겹침 0 실측) ID 값 일치는 조건으로 쓸 수 없다. 차량 신원(ID·번호)과
      // 신선도(stale=false)는 원천 읽기 쪽 검사가 이미 한다. 내부 필드는 응답에 싣지 않는다.
      if (active >= VEHICLE_PHOTO_MAX_CONCURRENT) { emit('SOURCE_BUSY', 'SOURCE_AWAIT'); throw new Error('VEHICLE_PHOTO_BUSY'); }
      active++;
      try {
        enter('SOURCE_AWAIT');
        let result: VehiclePhotoRead;
        try { result = await iancarSource.read(product, index, false); }
        catch (error) {
          const code = error instanceof Error ? error.message : '';
          emit(code === 'VEHICLE_PHOTO_BUSY' || code === 'IANCAR_PHOTO_BUSY' ? 'SOURCE_BUSY' : code === 'VEHICLE_PHOTO_NOT_FOUND' || code === 'IANCAR_PHOTO_NOT_FOUND' ? 'SOURCE_NOT_FOUND' : 'SOURCE_UNAVAILABLE');
          if (code.startsWith('VEHICLE_PHOTO_')) throw error;
          if (code === 'IANCAR_PHOTO_NOT_FOUND') throw new Error('VEHICLE_PHOTO_NOT_FOUND');
          if (code === 'IANCAR_PHOTO_BUSY') throw new Error('VEHICLE_PHOTO_BUSY');
          throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
        }
        enter('RESULT_LAYOUT');
        const served = result.photoIds;
        if (!Array.isArray(served) || served.length !== gateIds.length || result.count !== gateIds.length
          || new Set(served).size !== served.length) {
          emit('MEMBERSHIP_MISMATCH', 'RESULT_LAYOUT'); throw new Error('VEHICLE_PHOTO_NOT_FOUND');
        }
        if (!Number.isSafeInteger(result.count) || result.count < 1 || result.count > 200) { emit('LAYOUT_MISMATCH', 'RESULT_LAYOUT'); throw new Error('VEHICLE_PHOTO_UNAVAILABLE'); }
        const revalidateIds = async (): Promise<boolean> => {
          enter('FINAL_DB');
          let current: Rec | undefined;
          try { current = await readProduct(productId); } catch { emit('DB_FAILURE'); return false; }
          enter('FINAL_GATE');
          const currentIds = idGatePhotoIds(current);
          const unchanged = !!current && isPublicIancarPhotoProduct(current) && !hasVehiclePhotoVerification(current)
            && !!currentIds && currentIds.length === gateIds.length;
          if (!unchanged) emit('PROOF_CHANGED');
          return unchanged;
        };
        if (index === undefined) {
          await recheckIds(revalidateIds);
          return { count: result.count, bytes: null, contentType: 'application/json', revalidate: revalidateIds };
        }
        const bytes = result.bytes;
        enter('RESULT_MEDIA');
        if (index >= result.count) { emit('SELECTED_MISSING', 'RESULT_LAYOUT'); throw new Error('VEHICLE_PHOTO_NOT_FOUND'); }
        if (validateVehiclePhotoMedia(result.contentType, Buffer.isBuffer(bytes) ? bytes.length : 0, bytes) || !Buffer.isBuffer(bytes))
          { emit('MEDIA_INVALID', 'RESULT_MEDIA'); throw new Error('VEHICLE_PHOTO_UNAVAILABLE'); }
        await recheckIds(revalidateIds);
        return { count: result.count, bytes: Buffer.from(bytes), contentType: result.contentType, revalidate: revalidateIds };
      } finally { active--; }
    }
    const mediaOnly = consumerId === 'erp5-public-media';
    // The machine media consumer never falls through to approved Drive or other suppliers.
    if (mediaOnly && !isPublicIancarPhotoProduct(product)) { emit('PUBLIC_INELIGIBLE'); invalidateReviewed(productId); throw new Error('VEHICLE_PHOTO_NOT_FOUND'); }
    const consumerSources = mediaOnly ? sources.filter(candidate => candidate === iancarSource) : sources;
    const source = consumerSources.find(candidate => candidate.eligible(product));
    if (!source || !product || !hasVehiclePhotoVerification(product)) { emit('APPROVAL_INVALID'); invalidateReviewed(productId); throw new Error('VEHICLE_PHOTO_NOT_FOUND'); }
    const refs = product.photo_original_refs as Rec[];
    if (source === iancarSource && refs.some(ref => ref.reviewBasis !== undefined && ref.reviewBasis !== 'CONTENT_ORDINAL/1'))
      { emit('BASIS_INVALID'); invalidateReviewed(productId); throw new Error('VEHICLE_PHOTO_NOT_FOUND'); }
    if (source === iancarSource && refs.some(ref => ref.reviewBasis === 'CONTENT_ORDINAL/1')
      && refs.some(ref => ref.sourceKind !== 'IANCAR_ONE')) { emit('BASIS_INVALID'); invalidateReviewed(productId); throw new Error('VEHICLE_PHOTO_NOT_FOUND'); }
    const boundOneReview = source === iancarSource && refs.some(ref => ref.sourceKind === 'IANCAR_ONE');
    const contentBasis = boundOneReview && refs.some(ref => ref.reviewBasis === 'CONTENT_ORDINAL/1');
    let mismatch: VehiclePhotoReadFailure['reason'] = 'LAYOUT_MISMATCH';
    const reviewedSetMatches = (result: VehiclePhotoRead, checkBytes = index !== undefined): boolean => {
      mismatch = 'LAYOUT_MISMATCH';
      enter('RESULT_LAYOUT');
      if (!boundOneReview) return true;
      const ids = result.photoIds, upstream = result.upstreamPhotoIds;
      if (!ids || !upstream || ids.length !== refs.length || result.count !== refs.length
        || upstream.length !== ids.length || new Set(ids).size !== ids.length || new Set(upstream).size !== upstream.length) return false;
      const binding = orderedJsonDigest(['RP031', productId, product.iancar_one_vehicle_id, String(product.car_number).replace(/\s/g, '')]);
      const set = contentBasis ? iancarReviewedContentSetDigest(binding, refs)
        : orderedJsonDigest(['ONE_PHOTO_SET/1', binding, upstream, ids]);
      const representatives = result.upstreamRepresentatives, ordinals = result.servingSourceOrdinals;
      if (contentBasis && (!representatives || !ordinals || representatives.length !== refs.length || ordinals.length !== refs.length
        || representatives.some(value => typeof value !== 'boolean') || representatives.filter(Boolean).length > 1
        || new Set(ordinals).size !== refs.length)) return false;
      const unchanged = refs.every((ref, i) => ref.sourceKind === 'IANCAR_ONE' && ref.sourceApiVersion === 'iancar-one-api/1'
        && ref.sourceBindingDigest === binding && ref.photoSetDigest === set
        && (contentBasis ? (ref.reviewBasis === 'CONTENT_ORDINAL/1' && typeof ref.representative === 'boolean'
          && ref.sourceOrdinal === ordinals![i] && ref.representative === representatives![ordinals![i]!]
          && ordinals![i] === upstream.indexOf(ids[i]!)) : ref.sourcePhotoIdDigest === orderedJsonDigest(ids[i]))
        && ref.servingIndex === i && ref.sourceOrdinal === upstream.indexOf(ids[i]!) && upstream.includes(ids[i]!)
        && typeof ref.photoSha256 === 'string' && /^[a-f0-9]{64}$/.test(ref.photoSha256));
      if (!unchanged || !checkBytes || index === undefined) return unchanged;
      const ref = refs[index];
      if (!ref) { mismatch = 'SELECTED_MISSING'; return false; }
      enter('RESULT_MEDIA');
      if (!Buffer.isBuffer(result.bytes) || result.contentType !== ref.mediaType) { mismatch = 'MEDIA_INVALID'; return false; }
      mismatch = 'HASH_MISMATCH';
      enter('RESULT_HASH');
      return createHash('sha256').update(result.bytes).digest('hex') === ref.photoSha256;
    };
    const connection = JSON.stringify([source.connection(product), product.photo_original_refs]);
    for (const [key, entry] of reviewedCache) if (entry.productId === productId && entry.connection !== connection) removeReviewed(key);
    const reviewedKey = contentBasis && index !== undefined ? JSON.stringify([consumerId, productId, connection, index]) : undefined;
    let verifiedImage: ReviewedImage | undefined;
    let reusedVerifiedImage = false;
    const revalidate = async (checkSource = true): Promise<boolean> => {
      enter('FINAL_DB');
      let current: Rec | undefined;
      try { current = await readProduct(productId); } catch { emit('DB_FAILURE'); invalidateReviewed(productId); return false; }
      enter('FINAL_GATE');
      const unchanged = !!current && (!mediaOnly || isPublicIancarPhotoProduct(current)) && hasVehiclePhotoVerification(current) && consumerSources.find(candidate => candidate.eligible(current)) === source
        && JSON.stringify([source.connection(current), current.photo_original_refs]) === connection;
      if (!unchanged) { emit('PROOF_CHANGED'); invalidateReviewed(productId); return false; }
      if (reusedVerifiedImage && verifiedImage && verifiedImage.expiresAt <= now()) { emit('REUSE_EXPIRED', 'REUSE_TTL'); invalidateReviewed(productId); return false; }
      if (!boundOneReview || !checkSource) return true;
      // The response is a frozen copy whose bytes already matched the reviewed hash.
      // Recheck current membership, not a second image that will never be transmitted.
      let finalSourceCompleted = false;
      try {
        enter('FINAL_SOURCE');
        const currentMetadata = await source.read(current!, undefined, true);
        finalSourceCompleted = true;
        if (!reviewedSetMatches(currentMetadata, false)) {
          emit('MEMBERSHIP_MISMATCH', 'FINAL_MEMBERSHIP');
          invalidateReviewed(productId);
          return false;
        }
        if (reusedVerifiedImage && verifiedImage && verifiedImage.expiresAt <= now()) { emit('REUSE_EXPIRED', 'REUSE_TTL'); invalidateReviewed(productId); return false; }
        // Publish only after this caller's success audit and final fresh membership
        // check. Expiry stays tied to the original byte validation, never the hit.
        if (reviewedKey && verifiedImage && verifiedImage.expiresAt > now()) {
          const size = verifiedImage.result.bytes?.length ?? 0;
          removeReviewed(reviewedKey);
          if (size <= 32 * 1024 * 1024) {
            while (reviewedCache.size >= 64 || reviewedBytes + size > 32 * 1024 * 1024)
              removeReviewed(reviewedCache.keys().next().value!);
            reviewedCache.set(reviewedKey, verifiedImage); reviewedBytes += size;
          }
        }
        return true;
      } catch {
        emit(finalSourceCompleted ? 'UNKNOWN' : 'SOURCE_UNAVAILABLE', finalSourceCompleted ? 'FINAL_MEMBERSHIP' : 'FINAL_SOURCE');
        invalidateReviewed(productId);
        return false;
      }
    };
    const recheck = async () => {
      // Preserve the DB approval/withdrawal check here. The public callback also refreshes
      // source membership after the success audit, without duplicating this source request.
      if (!await revalidate(false)) throw new Error('VEHICLE_PHOTO_NOT_FOUND');
    };
    const read = async () => {
      let sourceCompleted = false;
      try {
        enter('SOURCE_AWAIT');
        const result = await source.read(product, index, boundOneReview);
        sourceCompleted = true;
        if (!reviewedSetMatches(result)) { emit(mismatch, mismatch === 'HASH_MISMATCH' ? 'RESULT_HASH' : mismatch === 'MEDIA_INVALID' ? 'RESULT_MEDIA' : 'RESULT_LAYOUT'); throw new Error('VEHICLE_PHOTO_NOT_FOUND'); }
        return result;
      }
      catch (error) {
        // Adapter diagnostics stay private; the public response vocabulary is source independent.
        const code = error instanceof Error ? error.message : '';
        emit(sourceCompleted ? 'UNKNOWN' : code === 'VEHICLE_PHOTO_BUSY' || code === 'IANCAR_PHOTO_BUSY' ? 'SOURCE_BUSY' : code === 'VEHICLE_PHOTO_NOT_FOUND' || code === 'IANCAR_PHOTO_NOT_FOUND' ? 'SOURCE_NOT_FOUND' : 'SOURCE_UNAVAILABLE', sourceCompleted ? phase : 'SOURCE_AWAIT');
        if (code.startsWith('VEHICLE_PHOTO_')) throw error;
        if (code === 'IANCAR_PHOTO_NOT_FOUND') throw new Error('VEHICLE_PHOTO_NOT_FOUND');
        if (code === 'IANCAR_PHOTO_BUSY') throw new Error('VEHICLE_PHOTO_BUSY');
        throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
      }
    };
    // Only exact content approval proof shares bytes; identity-only adapter caches
    // remain bypassed. Every caller retains independent DB/audit/final-source gates.
    const readReviewed = async () => {
      if (!reviewedKey) return read();
      for (const [key, entry] of reviewedCache) if (entry.expiresAt <= now()) removeReviewed(key);
      let entry = reviewedCache.get(reviewedKey);
      reusedVerifiedImage = !!entry;
      if (!entry) {
        let request = pendingReviewed.get(reviewedKey);
        reusedVerifiedImage = !!request;
        if (!request) {
          if (pendingReviewed.size >= VEHICLE_PHOTO_MAX_CONCURRENT) { emit('SOURCE_BUSY', 'SOURCE_AWAIT'); throw new Error('VEHICLE_PHOTO_BUSY'); }
          request = Promise.resolve().then(read).then(result => ({ result: { ...result,
            bytes: Buffer.isBuffer(result.bytes) ? Buffer.from(result.bytes) : result.bytes,
          }, productId, connection, expiresAt: now() + VEHICLE_PHOTO_CACHE_TTL_MS }))
            .finally(() => { pendingReviewed.delete(reviewedKey); });
          pendingReviewed.set(reviewedKey, request);
        }
        enter('SOURCE_AWAIT');
        try { entry = await request; }
        // A shared rejection may originate in the initiating caller's result
        // validation, not the source transport. Do not infer its origin here.
        catch (error) { emit('UNKNOWN'); throw error; }
      }
      if (!reviewedSetMatches(entry.result)) { emit(mismatch, mismatch === 'HASH_MISMATCH' ? 'RESULT_HASH' : mismatch === 'MEDIA_INVALID' ? 'RESULT_MEDIA' : 'RESULT_LAYOUT'); removeReviewed(reviewedKey); throw new Error('VEHICLE_PHOTO_NOT_FOUND'); }
      verifiedImage = entry;
      return { ...entry.result, bytes: Buffer.isBuffer(entry.result.bytes) ? Buffer.from(entry.result.bytes) : entry.result.bytes };
    };
    const validCount = (count: number) => {
      if (!Number.isSafeInteger(count) || count < 0 || count > 200) { emit('LAYOUT_MISMATCH', 'RESULT_LAYOUT'); throw new Error('VEHICLE_PHOTO_UNAVAILABLE'); }
    };
    if (active >= VEHICLE_PHOTO_MAX_CONCURRENT) { emit('SOURCE_BUSY', 'SOURCE_AWAIT'); throw new Error('VEHICLE_PHOTO_BUSY'); }
    active++;
    try {
      if (index === undefined) {
        const result = await read(); validCount(result.count);
        await recheck();
        return { count: result.count, bytes: null, contentType: 'application/json', revalidate };
      }
      const selectedRef = source === approvedSource ? (product.photo_original_refs as ApprovedVehiclePhotoRef[])[index] : undefined;
      const ref = selectedRef ? { ...selectedRef } : undefined;
      if (source === approvedSource && !ref) { emit('SELECTED_MISSING', 'RESULT_LAYOUT'); throw new Error('VEHICLE_PHOTO_NOT_FOUND'); }
      const cacheKey = ref ? JSON.stringify([productId, ref.driveFileId, ref.sha256, ref.approvedAt, ref.vehicleKey]) : undefined;
      for (const [key, entry] of cache) if (entry.expiresAt <= now()) remove(key);
      const cached = cacheKey ? cache.get(cacheKey) : undefined;
      const result = cached ? { ...cached, count: (product.photo_original_refs as ApprovedVehiclePhotoRef[]).length } : await readReviewed();
      validCount(result.count);
      const bytes = result.bytes;
      enter('RESULT_MEDIA');
      let selectedMissing = false;
      if (validateVehiclePhotoMedia(result.contentType, Buffer.isBuffer(bytes) ? bytes.length : 0, bytes) || !Buffer.isBuffer(bytes) || (selectedMissing = index >= result.count)
        || (ref && (result.contentType !== ref.mediaType || createHash('sha256').update(bytes).digest('hex') !== ref.sha256)))
        { emit(selectedMissing ? 'SELECTED_MISSING' : 'MEDIA_INVALID', selectedMissing ? 'RESULT_LAYOUT' : 'RESULT_MEDIA'); throw new Error('VEHICLE_PHOTO_UNAVAILABLE'); }
      const output = Buffer.from(bytes);
      await recheck();
      if (cacheKey) {
        const entry = { bytes: output, contentType: result.contentType, expiresAt: cached?.expiresAt ?? now() + VEHICLE_PHOTO_CACHE_TTL_MS };
        remove(cacheKey);
        while (totalBytes + entry.bytes.length > VEHICLE_PHOTO_CACHE_BYTES) remove(cache.keys().next().value!);
        cache.set(cacheKey, entry); totalBytes += entry.bytes.length;
      }
      return { count: result.count, bytes: Buffer.from(output), contentType: result.contentType, revalidate };
    } finally { active--; }
  };
}
