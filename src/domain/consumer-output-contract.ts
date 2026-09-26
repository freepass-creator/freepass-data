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
