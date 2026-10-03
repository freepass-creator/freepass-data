import { createHash } from 'node:crypto';
import { parseErp5PriceKey } from '../adapters/erp5-product-mapping.js';
import { assessDepositEvidence, depositStatusLabel, hasConflictingPaidDeposit } from '../domain/deposit-evidence.js';

type Rec = Record<string, unknown>;

/** Supplier vehicle images only; never collect registration/customer document images. */
export function resolveReferenceVehiclePhotos(source: Rec) {
  let rejectedCount = 0;
  const readUrls = (value: unknown): string[] => {
    if (value == null || value === '') return [];
    if (Array.isArray(value)) return value.flatMap(readUrls);
    if (typeof value !== 'string') { rejectedCount += 1; return []; }
    const raw = value.trim();
    if (!raw) return [];
    if (raw.startsWith('[')) {
      try { return readUrls(JSON.parse(raw)); } catch { rejectedCount += 1; return []; }
    }
    if (raw.includes('\n')) return raw.split(/\r?\n/).flatMap(readUrls);
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username || url.password) { rejectedCount += 1; return []; }
      return [url.href];
    } catch { rejectedCount += 1; return []; }
  };
  const imageUrls = [...new Set([source.image_urls, source.images, source.photos, source.image_url, source.photo].flatMap(readUrls))];
  const sourceLinks = [...new Set(readUrls(source.photo_link))];
  return {
    state: imageUrls.length ? 'URLS_PRESENT' as const : sourceLinks.length ? 'LINK_ONLY' as const : rejectedCount ? 'UNUSABLE' as const : 'NOT_PROVIDED' as const,
    imageUrls,
    representativeUrl: imageUrls[0] ?? null,
    // Opaque folders may also contain registration/customer documents; do not expand access.
    sourceLinkCount: sourceLinks.length,
    rejectedCount,
    accessVerification: 'NOT_CHECKED' as const,
  };
}
type DepositState = 'KNOWN' | 'ZERO' | 'UNKNOWN';
type VatTreatment = 'EXCLUDED' | 'INCLUDED' | 'UNKNOWN';
type CommissionState = 'CALCULATED' | 'COORDINATION_REQUIRED' | 'UNKNOWN' | 'NOT_APPLICABLE';
type MarginState = 'CALCULATED' | 'UNKNOWN' | 'NOT_APPLICABLE';

export const KAKAO_CATALOG_REFERENCE_SCHEMA = 'freepass-data.kakao-catalog-reference/v1' as const;

export const KAKAO_COMMISSION_POLICY = {
  policyId: 'sales-commission-2026-10-03',
  decisionDate: '2026-10-03',
  evidenceHistory: [{ policyId: 'sales-commission-2026-09-28', observedAt: '2026-09-28T00:09:22.575Z', revision: 'f862d0097f6e83d79d0b699bc369a83716b1d982' }],
  currentAuthority: '2026-10-03 대표 결정 및 commission-research.md ①③④',
  sonokongAdditions: { 12: 100000, 24: 300000, 36: 500000, 48: 700000, 60: 700000 },
  pacificRates: { NEW_PREDELIVERY: { 5: [300, 250], 10: [400, 300] }, NEW_MATCHING: { 5: [300, 300], 10: [330, 330] } },
  sourceRole: 'REPOSITORY_SSOT_WITH_GOOGLE_SHEET_COPY',
  sourceObservedAt: '2026-09-28T00:09:22.575Z',
  canonicalSource: {
    repository: 'freepass-creator/freepasserp4',
    path: 'lib/domain/settlement-fee-table.ts',
    revision: 'f862d0097f6e83d79d0b699bc369a83716b1d982',
  },
  sourceFiles: [
    { code: 'F04', id: '1BjGBqAjRLEb9ZMKarpQsMF-q_UjdgmEqBAl1uVk8SR4', sheetId: 1982531660, range: '수수료표!A1:J180', modifiedTime: '2026-09-28T00:09:22.575Z' },
  ],
  standardSupplierIds: [
    'RP013', 'RP031', 'RP016', 'RP015', 'RP019', 'RP020', 'RP032', 'PT-0023',
    'RP017', 'RP011', 'RP021', 'PT-0026', 'RP010', 'RP030', 'PT-0012', 'RP008',
    'PT-0001', 'RP007', 'RP006',
  ],
  exceptionSupplierIds: {
    sonokong: ['RP012'],
    star: ['RP018', 'RP033'],
    autoplus: ['RP023'],
    switchplan: ['RP014'],
    iancar: ['RP004'],
    iron: ['RP006'],
    pacific: ['RP022'],
    excludedMindcar: ['RP034'],
  },
  rules: [
    { id: 'IRON_NEW_PREDELIVERY_BILLING', supplierGroup: 'IRON', product: 'NEW_PREDELIVERY', basis: 'VEHICLE_VALUE', rateBasisPoints: 400, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STAR_RERENT_ONE_MONTH_RENT_BILLING', supplierGroup: 'STAR', product: 'RERENT', basis: 'MONTHLY_RENT', rateBasisPoints: 10000, vatTreatment: 'INCLUDED', coordinationRequired: false },
    { id: 'SONOKONG_SUBSCRIPTION_BILLING_Q12_PLUS_ADDITION', supplierGroup: 'SONOKONG', product: 'SUBSCRIPTION', basis: 'Q12_PLUS_TERM_ADDITION', vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STANDARD_NEW_PREDELIVERY_BILLING_3_5_PERCENT', supplierGroup: 'STANDARD', product: 'NEW_PREDELIVERY', basis: 'VEHICLE_VALUE', rateBasisPoints: 350, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STANDARD_NEW_PREDELIVERY_3_PERCENT', supplierGroup: 'STANDARD', product: 'NEW_PREDELIVERY', basis: 'VEHICLE_VALUE', rateBasisPoints: 300, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STANDARD_NEW_MATCHING_UP_TO_9_PERCENT', supplierGroup: 'STANDARD', product: 'NEW_MATCHING', basis: 'COORDINATION', rateBasisPoints: null, vatTreatment: 'EXCLUDED', coordinationRequired: true },
    { id: 'STANDARD_RERENT_12_FIXED', supplierGroup: 'STANDARD', product: 'RERENT', termMonths: 12, basis: 'FIXED', fixedAmount: 500000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STANDARD_RERENT_24_RENT_X_TERM_X_4_PERCENT', supplierGroup: 'STANDARD', product: 'RERENT', termMonths: 24, basis: 'MONTHLY_RENT_X_TERM', rateBasisPoints: 400, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STANDARD_RERENT_36_RENT_X_TERM_X_3_PERCENT', supplierGroup: 'STANDARD', product: 'RERENT', termMonths: 36, basis: 'MONTHLY_RENT_X_TERM', rateBasisPoints: 300, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STANDARD_RERENT_48_RENT_X_TERM_X_2_5_PERCENT', supplierGroup: 'STANDARD', product: 'RERENT', termMonths: 48, basis: 'MONTHLY_RENT_X_TERM', rateBasisPoints: 250, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STANDARD_RERENT_60_RENT_X_TERM_X_1_75_PERCENT', supplierGroup: 'STANDARD', product: 'RERENT', termMonths: 60, basis: 'MONTHLY_RENT_X_TERM', rateBasisPoints: 175, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STANDARD_RERENT_BILLING_LADDER', supplierGroup: 'STANDARD', product: 'RERENT', basis: 'TERM_LADDER', termRules: [
      { termMonths: 12, basis: 'FIXED', fixedAmount: 600000 },
      { termMonths: 24, basis: 'MONTHLY_RENT_X_TERM', rateBasisPoints: 475 },
      { termMonths: 36, basis: 'MONTHLY_RENT_X_TERM', rateBasisPoints: 375 },
      { termMonths: 48, basis: 'MONTHLY_RENT_X_TERM', rateBasisPoints: 325 },
      { termMonths: 60, basis: 'MONTHLY_RENT_X_TERM', rateBasisPoints: 225 },
    ], vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'SONOKONG_SUBSCRIPTION_12_MONTH_RENT_100_PERCENT', supplierGroup: 'SONOKONG', product: 'SUBSCRIPTION', basis: 'Q12_WITH_EVIDENCE', rateBasisPoints: 10000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'STAR_RERENT_ONE_MONTH_RENT_X_80_PERCENT', supplierGroup: 'STAR', product: 'RERENT', basis: 'MONTHLY_RENT', rateBasisPoints: 8000, vatTreatment: 'INCLUDED', coordinationRequired: false },
    { id: 'AUTOPLUS_SUBSCRIPTION_FIXED', supplierGroup: 'AUTOPLUS', product: 'SUBSCRIPTION', basis: 'FIXED', fixedAmount: 800000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'AUTOPLUS_SUBSCRIPTION_BILLING_FIXED', supplierGroup: 'AUTOPLUS', product: 'SUBSCRIPTION', basis: 'FIXED', fixedAmount: 1000000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'SWITCH_SUBSCRIPTION_LADDER', supplierGroup: 'SWITCH', product: 'SUBSCRIPTION', basis: 'TERM_LADDER', vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'IANCAR_RERENT_1_MONTH', supplierGroup: 'IANCAR', product: 'RERENT', termMonths: 1, basis: 'COORDINATION', rateBasisPoints: null, vatTreatment: 'EXCLUDED', coordinationRequired: true },
    { id: 'IANCAR_RERENT_6_MONTH_BILLING_FIXED', supplierGroup: 'IANCAR', product: 'RERENT', termMonths: 6, basis: 'FIXED', fixedAmount: 400000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'IANCAR_RERENT_6_MONTH_FIXED', supplierGroup: 'IANCAR', product: 'RERENT', termMonths: 6, basis: 'FIXED', fixedAmount: 300000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'IANCAR_EV_BILLING_FIXED', supplierGroup: 'IANCAR', product: 'EV', basis: 'FIXED', fixedAmount: 1000000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'IANCAR_EV_FIXED', supplierGroup: 'IANCAR', product: 'EV', basis: 'FIXED', fixedAmount: 800000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'PACIFIC_NEW_PREDELIVERY_DEPOSIT_TIER', supplierGroup: 'PACIFIC', product: 'NEW_PREDELIVERY', basis: 'VEHICLE_VALUE_DEPOSIT_TIER', rateBasisPoints: null, vatTreatment: 'INCLUDED', coordinationRequired: false },
    { id: 'PACIFIC_NEW_MATCHING_DEPOSIT_TIER', supplierGroup: 'PACIFIC', product: 'NEW_MATCHING', basis: 'VEHICLE_VALUE_DEPOSIT_TIER', rateBasisPoints: null, vatTreatment: 'INCLUDED', coordinationRequired: false },
  ],
  timingRules: [
    { supplierGroup: 'STAR_IANCAR', case: 'INSTALLMENT', billingAndPayout: 'AFTER_ALL_INSTALLMENTS_RECEIVED', broken: 'NO_FEE' },
    { supplierGroup: 'OTHERS', case: 'INSTALLMENT', billingAndPayout: 'FULL_ON_DELIVERY', broken: 'PRORATE_BY_RECEIVED_INSTALLMENTS' },
    { supplierGroup: 'ALL', case: 'LUMP_SUM', billingAndPayout: 'FULL_ON_DELIVERY', broken: 'NOT_APPLICABLE' },
    { supplierGroup: 'ALL', case: 'DEPOSIT_INSTALLMENT', billingAndPayout: 'INSTALLMENT_DUE_DATES_FROM_DELIVERY', broken: 'COMPLETE_AFTER_FINAL_DUE_DATE_PLUS_ONE_MONTH' },
  ],
} as const;

type CommissionResolution = {
  state: CommissionState;
  ruleId: string | null;
  amount: number | null;
  vatTreatment: VatTreatment;
  vatAmount: number | null;
  totalAmount: number | null;
  reasonCode: string | null;
};

type MarginResolution = {
  state: MarginState;
  amount: number | null;
  currency: 'KRW';
  basis: 'SUPPLY_AMOUNT_EXCLUDING_VAT';
  reasonCode: string | null;
};

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const integer = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  const raw = text(value);
  if (!/^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(raw)) return null;
  const parsed = Number(raw.replaceAll(',', ''));
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

const knownProductType = (source: string) => ({
  '신차렌트': 'NEW_RENT', '중고렌트': 'USED_RENT', '재렌트': 'USED_RENT',
  '신차구독': 'NEW_SUBSCRIPTION', '중고구독': 'USED_SUBSCRIPTION', '재구독': 'USED_SUBSCRIPTION',
  '오공구독': 'OGONG_SUBSCRIPTION', '픽업구독': 'PICKUP_SUBSCRIPTION', '오플구독': 'OPLUS_SUBSCRIPTION',
} as const)[source] ?? 'UNKNOWN';

export function resolveReferenceDeposit(input: {
  note: unknown;
  termMonths: number;
  monthlyRent: number;
  sourceAmount: unknown;
  supplierId?: unknown;
  productType?: unknown;
  depositFree?: unknown;
  hasPositivePaidDeposit?: boolean;
}) {
  const note = text(input.note);
  const evidence = assessDepositEvidence(input);
  if (['CONFLICTING_ZERO_DEPOSIT_EVIDENCE', 'INVALID_OR_INCOMPLETE_ZERO_DEPOSIT_EVIDENCE', 'POSITIVE_AMOUNT_WITH_RULE_REQUIRES_REVIEW', 'INVALID_DEPOSIT_AMOUNT'].includes(evidence.reason)) {
    return { depositAmount: null, depositState: 'UNKNOWN' as DepositState, depositRule: null };
  }
  if (evidence.state === 'KNOWN') {
    return { depositAmount: evidence.amount, depositState: 'KNOWN' as DepositState,
      depositRule: { code: 'SOURCE_AMOUNT', multiplier: null, label: '공급사 입력 금액' } };
  }
  if (input.supplierId === 'RP012' && ['중고렌트', '재렌트'].includes(String(input.productType))) {
    return { depositAmount: null, depositState: 'UNKNOWN' as DepositState, depositRule: null };
  }
  const known = (code: string, multiplier: number, label: string) => {
    const depositAmount = input.monthlyRent * multiplier;
    if (!Number.isSafeInteger(depositAmount) || depositAmount <= 0) {
      return { depositAmount: null, depositState: 'UNKNOWN' as DepositState, depositRule: null };
    }
    return {
      depositAmount,
      depositState: 'KNOWN' as DepositState,
      depositRule: { code, multiplier, label },
    };
  };
  if (evidence.state === 'ZERO') {
    return {
      depositAmount: 0,
      depositState: 'ZERO' as DepositState,
      depositRule: { code: 'ZERO_DEPOSIT', multiplier: 0, label: '무보증' },
    };
  }
  if (input.monthlyRent > 0) {
    if (/^월 대여료 × 약정연수 \(최대 3개월\)$/.test(note)) {
      if (!Number.isSafeInteger(input.termMonths) || input.termMonths <= 0 || input.termMonths % 12 !== 0) {
        return { depositAmount: null, depositState: 'UNKNOWN' as DepositState, depositRule: null };
      }
      const multiplier = Math.min(Math.ceil(input.termMonths / 12), 3);
      return known('RENT_X_CONTRACT_YEARS_MAX3', multiplier, `대여료×${multiplier}`);
    }
    if (/^국산:\s*월 대여료×2$/.test(note)) {
      return known('RENT_X_2', 2, '대여료×2');
    }
    if (/^수입:\s*12개월 대여료×3 · 18개월↑ ×6$/.test(note)) {
      const multiplier = input.termMonths >= 18 ? 6 : 3;
      return known('IMPORT_12_X3_18_PLUS_X6', multiplier, `대여료×${multiplier}`);
    }
  }
  if (!note) {
    const sourceAmount = integer(input.sourceAmount);
    if (sourceAmount !== null && sourceAmount > 0) {
      return {
        depositAmount: sourceAmount,
        depositState: 'KNOWN' as DepositState,
        depositRule: { code: 'SOURCE_AMOUNT', multiplier: null, label: '공급사 입력 금액' },
      };
    }
  }
  return {
    depositAmount: null,
    depositState: 'UNKNOWN' as DepositState,
    depositRule: null,
  };
}

const calculatedCommission = (
  ruleId: string,
  amount: number,
  vatTreatment: VatTreatment,
): CommissionResolution => {
  amount = Math.round(amount);
  if (!Number.isSafeInteger(amount) || amount < 0) return unknownCommission('COMMISSION_AMOUNT_OUT_OF_RANGE');
  const supply = vatTreatment === 'INCLUDED' ? Math.round(amount / 1.1) : amount;
  const vatAmount = vatTreatment === 'INCLUDED' ? amount - supply : Math.round(supply / 10);
  const totalAmount = supply + vatAmount;
  if (!Number.isSafeInteger(totalAmount)) return unknownCommission('COMMISSION_AMOUNT_OUT_OF_RANGE');
  return { state: 'CALCULATED', ruleId, amount: supply, vatTreatment, vatAmount, totalAmount, reasonCode: null };
};

const unknownCommission = (reasonCode: string): CommissionResolution => ({
  state: 'UNKNOWN', ruleId: null, amount: null, vatTreatment: 'UNKNOWN', vatAmount: null, totalAmount: null, reasonCode,
});

const standardLadderSupplier = (supplierId: string) =>
  KAKAO_COMMISSION_POLICY.standardSupplierIds.includes(supplierId as never)
  || KAKAO_COMMISSION_POLICY.exceptionSupplierIds.sonokong.includes(supplierId as 'RP012')
  || KAKAO_COMMISSION_POLICY.exceptionSupplierIds.star.includes(supplierId as 'RP018')
  || KAKAO_COMMISSION_POLICY.exceptionSupplierIds.iancar.includes(supplierId as 'RP004')
  || KAKAO_COMMISSION_POLICY.exceptionSupplierIds.pacific.includes(supplierId as 'RP022');

const resolveTermLadder = (
  termMonths: number,
  monthlyRent: number,
  side: 'BILLING' | 'PAYOUT',
  prefix = 'STANDARD_RERENT',
): CommissionResolution => {
  const fixed = side === 'BILLING' ? 600000 : 500000;
  const ruleId = (term: number, suffix: 'FIXED' | 'RENT_X_TERM') => {
    if (prefix === 'STANDARD_RERENT' && side === 'PAYOUT') {
      return term === 12 ? 'STANDARD_RERENT_12_FIXED' : `STANDARD_RERENT_${term}_RENT_X_TERM`;
    }
    return `${prefix}_${term}_${side}_${suffix}`;
  };
  if (termMonths === 12) return calculatedCommission(ruleId(12, 'FIXED'), fixed, 'EXCLUDED');
  const rates = side === 'BILLING'
    ? new Map([[24, 475], [36, 375], [48, 325], [60, 225]])
    : new Map([[24, 400], [36, 300], [48, 250], [60, 175]]);
  const basisPoints = rates.get(termMonths);
  if (!basisPoints) return unknownCommission('TERM_NOT_IN_F04_COMMISSION_POLICY');
  return calculatedCommission(
    ruleId(termMonths, 'RENT_X_TERM'),
    monthlyRent * termMonths * basisPoints / 10000,
    'EXCLUDED',
  );
};

export type CommissionInput = {
  supplierId: string;
  productType: string;
  fuel?: string;
  termMonths: number;
  monthlyRent: number;
  vehicleValue?: number;
  newProductSubtype?: 'NEW_PREDELIVERY' | 'NEW_MATCHING';
  /** Explicit contractual tier, never inferred from a deposit amount. */
  depositTierPercent?: 5 | 10;
  subscriptionForm?: 'BUYOUT' | 'RETURN';
  q12Basis?: { amount: number; sourceRef: string };
  /** A suspected individual promotion must not silently use the general rule. */
  individualException?: boolean;
};

function resolveCommission(input: CommissionInput, side: 'BILLING' | 'PAYOUT'): CommissionResolution {
  const { supplierId, productType, termMonths, monthlyRent } = input;
  const billing = side === 'BILLING';
  const fixed = (id: string, amount: number, vat: VatTreatment = 'EXCLUDED') => calculatedCommission(id, amount, vat);
  if (supplierId === 'RP034') return { ...unknownCommission('SUPPLIER_EXCLUDED_BY_DECISION'), state: 'NOT_APPLICABLE' };
  if (!Number.isSafeInteger(termMonths) || termMonths < 1 || !Number.isSafeInteger(monthlyRent) || monthlyRent < 0) return unknownCommission('INVALID_PRICE_TERM_INPUT');
  if (input.individualException) return unknownCommission('INDIVIDUAL_EXCEPTION_EVIDENCE_REQUIRED');
  const rerent = /^(중고렌트|재렌트)$/.test(productType);
  const subscription = /구독/.test(productType);
  if (supplierId === 'RP012' && subscription) {
    const addition = KAKAO_COMMISSION_POLICY.sonokongAdditions[termMonths as 12];
    if (addition === undefined) return unknownCommission('TERM_NOT_IN_F04_COMMISSION_POLICY');
    if (input.subscriptionForm === 'RETURN' && termMonths !== 12) return unknownCommission('RETURN_SUBSCRIPTION_TERM_NOT_SUPPORTED');
    if (!input.q12Basis || !Number.isSafeInteger(input.q12Basis.amount) || input.q12Basis.amount <= 0 || !text(input.q12Basis.sourceRef)) return unknownCommission('Q12_BASIS_REQUIRED');
    if (input.subscriptionForm !== 'BUYOUT' && input.subscriptionForm !== 'RETURN') return unknownCommission('SUBSCRIPTION_FORM_REQUIRED');
    return fixed(`SONOKONG_SUBSCRIPTION_${termMonths}_${side}`, input.q12Basis.amount + (billing ? addition : 0));
  }
  if (KAKAO_COMMISSION_POLICY.exceptionSupplierIds.star.includes(supplierId as 'RP018') && rerent) {
    return fixed(billing ? 'STAR_RERENT_ONE_MONTH_RENT_BILLING' : 'STAR_RERENT_ONE_MONTH_RENT_X_80_PERCENT', monthlyRent * (billing ? 1 : 0.8), 'INCLUDED');
  }
  if (supplierId === 'RP023' && subscription) return fixed(billing ? 'AUTOPLUS_SUBSCRIPTION_BILLING_FIXED' : 'AUTOPLUS_SUBSCRIPTION_FIXED', billing ? 1000000 : 800000);
  if (supplierId === 'RP014' && subscription) return resolveTermLadder(termMonths, monthlyRent, side, 'SWITCH_SUBSCRIPTION');
  if (supplierId === 'RP004') {
    if (/전기/.test(input.fuel ?? '')) return fixed(billing ? 'IANCAR_EV_BILLING_FIXED' : 'IANCAR_EV_FIXED', billing ? 1000000 : 800000);
    if (rerent && termMonths === 6) return fixed(billing ? 'IANCAR_RERENT_6_MONTH_BILLING_FIXED' : 'IANCAR_RERENT_6_MONTH_FIXED', billing ? 400000 : 300000);
    if (rerent && termMonths === 1) return unknownCommission('IANCAR_SHORT_TERM_BASIS_REQUIRED');
  }
  if (!standardLadderSupplier(supplierId)) return unknownCommission('SUPPLIER_RULE_NOT_IN_F04_CANONICAL_TABLE');
  if (rerent) return resolveTermLadder(termMonths, monthlyRent, side);
  if (/^신차/.test(productType) && !subscription) {
    if (supplierId === 'RP022' && input.depositTierPercent !== 5 && input.depositTierPercent !== 10) return unknownCommission('DEPOSIT_TIER_REQUIRED');
    const subtype = input.newProductSubtype;
    if (subtype !== 'NEW_PREDELIVERY' && subtype !== 'NEW_MATCHING') return unknownCommission('NEW_PRODUCT_SUBTYPE_REQUIRED');
    if (!Number.isSafeInteger(input.vehicleValue) || input.vehicleValue! <= 0) return unknownCommission('VEHICLE_VALUE_REQUIRED');
    if (supplierId === 'RP022') {
      const rates = KAKAO_COMMISSION_POLICY.pacificRates[subtype][input.depositTierPercent!];
      return fixed(`PACIFIC_${subtype}_${input.depositTierPercent}_${side}`, input.vehicleValue! * rates[billing ? 0 : 1] / 10000, 'INCLUDED');
    }
    if (subtype === 'NEW_MATCHING') return unknownCommission('MATCHING_AGREED_RATE_REQUIRED');
    return fixed(`${supplierId === 'RP006' ? 'IRON' : 'STANDARD'}_NEW_PREDELIVERY_${side}`, input.vehicleValue! * (billing ? supplierId === 'RP006' ? 400 : 350 : 300) / 10000);
  }
  return unknownCommission(subscription ? 'SUBSCRIPTION_RULE_SCOPE_UNCONFIRMED' : 'NO_MATCHING_RULE');
}

export function resolveSalesCommission(input: CommissionInput): CommissionResolution {
  return resolveCommission(input, 'PAYOUT');
}

export function resolveSupplierBillingFee(input: CommissionInput): CommissionResolution {
  return resolveCommission(input, 'BILLING');
}

export function resolveExpectedGrossMargin(
  supplierBillingFee: CommissionResolution,
  channelPayoutFee: CommissionResolution,
): MarginResolution {
  if (supplierBillingFee.state === 'NOT_APPLICABLE' && channelPayoutFee.state === 'NOT_APPLICABLE') {
    return {
      state: 'NOT_APPLICABLE', amount: null, currency: 'KRW',
      basis: 'SUPPLY_AMOUNT_EXCLUDING_VAT', reasonCode: 'NO_COMMISSION_APPLICABLE',
    };
  }
  if (
    supplierBillingFee.state !== 'CALCULATED' || supplierBillingFee.amount === null ||
    channelPayoutFee.state !== 'CALCULATED' || channelPayoutFee.amount === null
  ) {
    return {
      state: 'UNKNOWN', amount: null, currency: 'KRW',
      basis: 'SUPPLY_AMOUNT_EXCLUDING_VAT', reasonCode: 'BILLING_OR_PAYOUT_UNRESOLVED',
    };
  }
  const amount = supplierBillingFee.amount - channelPayoutFee.amount;
  if (!Number.isSafeInteger(amount)) {
    return {
      state: 'UNKNOWN', amount: null, currency: 'KRW',
      basis: 'SUPPLY_AMOUNT_EXCLUDING_VAT', reasonCode: 'MARGIN_OUT_OF_RANGE',
    };
  }
  return {
    state: 'CALCULATED', amount, currency: 'KRW',
    basis: 'SUPPLY_AMOUNT_EXCLUDING_VAT', reasonCode: null,
  };
}

const assetStatus = (value: unknown) => ({
  '즉시출고': 'AVAILABLE', '출고가능': 'AVAILABLE', '가용': 'AVAILABLE',
  '계약중': 'RESERVED', '점검중': 'MAINTENANCE',
} as const)[text(value)] ?? null;

export function buildKakaoCatalogReferenceProduct(documentId: string, source: Rec) {
  if (source.listable !== true) return null;
  const supplierId = text(source.provider_company_code);
  if (!supplierId) return null;
  const price = source.price;
  if (!price || typeof price !== 'object' || Array.isArray(price)) return null;
  const priceTerms = Object.entries(price as Rec).flatMap(([sourceKey, raw]) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const parsed = parseErp5PriceKey(sourceKey);
    const monthlyRent = integer((raw as Rec).rent);
    if (!parsed || monthlyRent === null || monthlyRent <= 0) return [];
    const deposit = resolveReferenceDeposit({
      note: source.deposit_note,
      termMonths: parsed.months,
      monthlyRent,
      sourceAmount: (raw as Rec).deposit,
      supplierId,
      productType: source.product_type,
      depositFree: source.deposit_free,
      hasPositivePaidDeposit: hasConflictingPaidDeposit(price),
    });
    const channelPayoutFee = resolveSalesCommission({
      supplierId,
      productType: text(source.product_type),
      fuel: text(source.fuel_type),
      termMonths: parsed.months,
      monthlyRent,
    });
    const supplierBillingFee = resolveSupplierBillingFee({
      supplierId,
      productType: text(source.product_type),
      fuel: text(source.fuel_type),
      termMonths: parsed.months,
      monthlyRent,
    });
    const expectedGrossMargin = resolveExpectedGrossMargin(supplierBillingFee, channelPayoutFee);
    return [{
      termKey: `source:${sourceKey}`,
      termMonths: parsed.months,
      monthlyRent: { amount: monthlyRent, currency: 'KRW' as const },
      deposit: deposit.depositAmount === null ? null : { amount: deposit.depositAmount, currency: 'KRW' as const },
      ...deposit,
      depositStatusLabel: depositStatusLabel(deposit.depositState, (raw as Rec).deposit, source.deposit_note),
      mileageLimitKmPerYear: parsed.mileageKm ?? null,
      settlement: parsed.settlement,
      // Backward-compatible alias for the existing Kakao consumer.
      salesCommission: channelPayoutFee,
      supplierBillingFee,
      channelPayoutFee,
      expectedGrossMargin,
    }];
  }).sort((a, b) => a.termMonths - b.termMonths || a.termKey.localeCompare(b.termKey));
  if (!priceTerms.length) return null;
  const maker = text(source.maker);
  const model = text(source.model);
  const trim = text(source.trim_name);
  const vehicleModelId = `reference_vm_${hash(`${maker}|${model}|${trim}|${text(source.fuel_type)}`)}`;
  return {
    productId: `reference_${documentId}`,
    sourceProductId: documentId,
    displayName: [maker, model, trim].filter(Boolean).join(' ') || documentId,
    commercialType: knownProductType(text(source.product_type)),
    vehicleModelId,
    vehicleAssetId: `reference_va_${documentId}`,
    vehiclePhotos: resolveReferenceVehiclePhotos(source),
    vehicle: {
      maker,
      model,
      subModel: text(source.sub_model) || null,
      trim: trim || null,
      fuel: text(source.fuel_type) || null,
      drive: text(source.drive_type) || null,
      seats: integer(source.seats),
      assetStatus: assetStatus(source.vehicle_status) ?? assetStatus(source.status) ?? assetStatus(source.status_kind),
      plateNumber: text(source.car_number) || null,
      odometerKm: integer(source.mileage),
      exteriorColor: text(source.ext_color) || null,
    },
    shadowFacts: {
      modelYear: integer(source.year),
      options: text(source.options) || null,
      depositNote: text(source.deposit_note) || null,
      vehicleStatus: text(source.vehicle_status) || null,
    },
    offers: [{
      offerId: `reference_offer_${documentId}`,
      supplierId,
      supplierName: text(source.provider_name) || null,
      policyId: text(source.policy_code) || null,
      priceTerms,
    }],
  };
}

export function buildKakaoCatalogReference(input: {
  consumerId: string;
  products: Record<string, Rec>;
  observedAt: string;
}) {
  if (input.consumerId !== 'kakao-ops') throw new Error('KAKAO_REFERENCE_CONSUMER_NOT_ALLOWED');
  return buildReferenceFacts(input);
}

export function buildInternalAiReference(input: KakaoCatalogReferenceSource) {
  if (!/^internal-ai-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.consumerId)) throw new Error('INTERNAL_AI_CONSUMER_NOT_ALLOWED');
  const result = buildReferenceFacts(input);
  return { ...result, schema: 'freepass-data.internal-ai-reference/v1' as const,
    meta: { ...result.meta, consumerId: input.consumerId, projectionId: 'internal-ai-reference' as const } };
}

function buildReferenceFacts(input: { consumerId: string; products: Record<string, Rec>; observedAt: string }) {
  const data = Object.entries(input.products)
    .map(([id, source]) => buildKakaoCatalogReferenceProduct(id, source))
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => a.productId.localeCompare(b.productId));
  if (!data.length) throw new Error('KAKAO_REFERENCE_EMPTY');
  const dataDigest = hash(JSON.stringify(data));
  const policyDigest = hash(JSON.stringify(KAKAO_COMMISSION_POLICY));
  return {
    schema: KAKAO_CATALOG_REFERENCE_SCHEMA,
    data,
    commissionPolicy: { ...KAKAO_COMMISSION_POLICY, digest: policyDigest },
    meta: {
      consumerId: 'kakao-ops' as const,
      projectionId: 'kakao-catalog-reference' as const,
      authority: 'REFERENCE_ONLY' as const,
      publicationDecision: 'HOLD' as const,
      observedAt: input.observedAt,
      sourceProject: 'freepasserp5' as const,
      sourceCollection: 'products' as const,
      sourceCount: Object.keys(input.products).length,
      projectedCount: data.length,
      dataDigest,
      warning: 'REFERENCE_ONLY: 재고·가격·수수료 확정 전 공급사 확인 필요',
    },
  };
}

export type KakaoCatalogReference = ReturnType<typeof buildKakaoCatalogReference>;
export type KakaoCatalogReferenceSource = Parameters<typeof buildKakaoCatalogReference>[0];
