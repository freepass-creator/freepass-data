import { createHash } from 'node:crypto';
import type { CommercialType } from './catalog.js';

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

/** Source adapters supply identity and bytes; authorization and validation stay in one pipeline. */
export type VehiclePhotoSource = {
  eligible(product: Rec | undefined): boolean;
  connection(product: Rec): string;
  read(product: Rec, index?: number): Promise<{ count: number; bytes: Buffer | null; contentType: string }>;
};

export function createVehiclePhotoReader(
  readProduct: (productId: string) => Promise<Rec | undefined>,
  iancarSource?: VehiclePhotoSource,
  approvedPhotoReader?: ApprovedPhotoReader,
  now: () => number = Date.now,
) {
  const cache = new Map<string, { bytes: Buffer; contentType: string; expiresAt: number }>();
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
  return async (consumerId: string, productId: string, index?: number) => {
    if (!(consumerId === 'erp-com' || /^whitelabel-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(consumerId))) throw new Error('VEHICLE_PHOTO_CONSUMER_FORBIDDEN');
    if (!productId || productId.length > 200 || /[\/\u0000-\u001f\u007f]/.test(productId)
      || (index !== undefined && (!Number.isSafeInteger(index) || index < 0 || index >= 200))) throw new Error('VEHICLE_PHOTO_REQUEST_INVALID');
    const product = await readProduct(productId);
    const source = sources.find(candidate => candidate.eligible(product));
    if (!source || !product || !hasVehiclePhotoVerification(product)) throw new Error('VEHICLE_PHOTO_NOT_FOUND');
    const connection = JSON.stringify([source.connection(product), product.photo_original_refs]);
    const revalidate = async (): Promise<boolean> => {
      const current = await readProduct(productId);
      return !!current && hasVehiclePhotoVerification(current) && sources.find(candidate => candidate.eligible(current)) === source
        && JSON.stringify([source.connection(current), current.photo_original_refs]) === connection;
    };
    const recheck = async () => {
      if (!await revalidate()) throw new Error('VEHICLE_PHOTO_NOT_FOUND');
    };
    const read = async () => {
      try { return await source.read(product, index); }
      catch (error) {
        // Adapter diagnostics stay private; the public response vocabulary is source independent.
        const code = error instanceof Error ? error.message : '';
        if (code.startsWith('VEHICLE_PHOTO_')) throw error;
        if (code === 'IANCAR_PHOTO_NOT_FOUND') throw new Error('VEHICLE_PHOTO_NOT_FOUND');
        if (code === 'IANCAR_PHOTO_BUSY') throw new Error('VEHICLE_PHOTO_BUSY');
        throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
      }
    };
    const validCount = (count: number) => {
      if (!Number.isSafeInteger(count) || count < 0 || count > 200) throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
    };
    if (active >= VEHICLE_PHOTO_MAX_CONCURRENT) throw new Error('VEHICLE_PHOTO_BUSY');
    active++;
    try {
      if (index === undefined) {
        const result = await read(); validCount(result.count);
        await recheck();
        return { count: result.count, bytes: null, contentType: 'application/json', revalidate };
      }
      const selectedRef = source === approvedSource ? (product.photo_original_refs as ApprovedVehiclePhotoRef[])[index] : undefined;
      const ref = selectedRef ? { ...selectedRef } : undefined;
      if (source === approvedSource && !ref) throw new Error('VEHICLE_PHOTO_NOT_FOUND');
      const cacheKey = ref ? JSON.stringify([productId, ref.driveFileId, ref.sha256, ref.approvedAt, ref.vehicleKey]) : undefined;
      for (const [key, entry] of cache) if (entry.expiresAt <= now()) remove(key);
      const cached = cacheKey ? cache.get(cacheKey) : undefined;
      const result = cached ? { ...cached, count: (product.photo_original_refs as ApprovedVehiclePhotoRef[]).length } : await read();
      validCount(result.count);
      const bytes = result.bytes;
      if (validateVehiclePhotoMedia(result.contentType, Buffer.isBuffer(bytes) ? bytes.length : 0, bytes) || !Buffer.isBuffer(bytes) || index >= result.count
        || (ref && (result.contentType !== ref.mediaType || createHash('sha256').update(bytes).digest('hex') !== ref.sha256)))
        throw new Error('VEHICLE_PHOTO_UNAVAILABLE');
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
