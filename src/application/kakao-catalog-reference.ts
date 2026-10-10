import { plateIdentityKey, isStrictKoreanPlate } from '../domain/vehicle-plate.js';
import { createHash } from 'node:crypto';
import { CONDITION_DIMENSION_SPECS } from './product-condition-dimensions.js';
import { policyScalar } from './product-pricing-policy.js';
import { assessDepositEvidence, depositEvidenceInputFromProduct, depositStatusLabel, hasConflictingPaidDeposit, parseErp5CompatibilityPriceKey, readIancarPublishedDeposit, resolveDepositWithRuleNote } from '../domain/deposit-evidence.js';
import { verifiedMasterRecords, verifiedVehicleMasterReference, type VehicleMasterSnapshot } from '../adapters/vehicle-identity-inputs.js';
import { chooseVehicleIdentity, indexVehicleMaster, type VehicleMasterReference } from '../domain/vehicle-identity-resolution.js';

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
  const candidates = [...new Set([source.image_urls, source.images, source.photos, source.image_url, source.photo].flatMap(readUrls))];
  const rejectedBeforeDocuments = rejectedCount;
  const documentUrls = new Set(readUrls(source.doc_images));
  rejectedCount = rejectedBeforeDocuments;
  const imageUrls = candidates.filter(url => !documentUrls.has(url));
  rejectedCount += candidates.length - imageUrls.length;
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

export const KAKAO_COMMISSION_POLICY_2026_10_03 = {
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
    { code: 'F04', get id() { const id = process.env.FREEPASS_SHEET_F04_ID?.trim(); if (!id) throw new Error('MISSING_SHEET_ID_ENV: FREEPASS_SHEET_F04_ID'); return id; }, sheetId: 1982531660, range: '수수료표!A1:J180', modifiedTime: '2026-09-28T00:09:22.575Z' },
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

/** Previous published rules remain available for historical evidence, never rewritten. */
export const KAKAO_COMMISSION_POLICY_2026_10_04 = {
  ...KAKAO_COMMISSION_POLICY_2026_10_03,
  policyId: 'sales-commission-2026-10-04',
  decisionDate: '2026-10-04',
  currentAuthority: 'F04 수수료표 A1:M191, 2026-10-04 제공 사본 및 사용자 명시 HOLD',
  sourceRole: 'F04_GOOGLE_SHEET_SSOT',
  canonicalSource: { code: 'F04', range: '수수료표!A1:M191', observedDate: '2026-10-04' },
  sourceObservedAt: '2026-10-04',
  sourceFiles: [{ code: 'F04', get id() { const id = process.env.FREEPASS_SHEET_F04_ID?.trim(); if (!id) throw new Error('MISSING_SHEET_ID_ENV: FREEPASS_SHEET_F04_ID'); return id; }, sheetId: 1982531660, range: '수수료표!A1:M191' }],
  evidenceHistory: [...KAKAO_COMMISSION_POLICY_2026_10_03.evidenceHistory,
    { policyId: KAKAO_COMMISSION_POLICY_2026_10_03.policyId, observedAt: '2026-10-03', revision: 'fd252b2508d4ccda5ecf8de03b587c1f9910cda4' }],
  sonokongAdditions: { 12: 100000, 24: 300000, 36: 500000, 48: 700000 },
  rules: [...KAKAO_COMMISSION_POLICY_2026_10_03.rules,
    { id: 'AUTOPLUS_EV_SUBSCRIPTION', sourceRows: [161], billing: 1500000, payout: 1300000 },
    { id: 'SONOKONG_PICKUP', sourceRows: [190], billingBasisPoints: 400, payoutBasisPoints: 300 },
    { id: 'BILLIN_SUBSCRIPTION_60', sourceRows: [162], billingBasisPoints: 225, payoutBasisPoints: 175 },
    // 개별 합의(F04 수수료표 160·163행): 금액·대상 계약은 공개 저장소에 두지 않고 비공개 목록에서 입력(individualAgreement)으로 받는다.
    { id: 'INDIVIDUAL_AGREEMENT', sourceRows: [160, 163], amounts: 'PRIVATE_INPUT' },
  ],
} as const;

/**
 * 2026-10-05 AI 상황실 결정(대표 10-05 «정산 확실하게 맞춰놔»):
 * - 손오공 오공 구독 60개월 청구 가산 = +600,000 (F04 수수료표 14행). 지급은 다른 기간과 같이 Q12.
 * - 원 단위: 원 미만 반올림 — calculatedCommission 의 Math.round 그대로.
 * 근거(실제 청구 줄 대조)는 비공개 ai-ops 인수인계(정산-수수료규칙-20261005)에 둔다 — 공개 저장소에는 원장 행·개별 금액을 적지 않는다.
 */
export const KAKAO_COMMISSION_POLICY = {
  ...KAKAO_COMMISSION_POLICY_2026_10_04,
  policyId: 'sales-commission-2026-10-09',
  decisionDate: '2026-10-09',
  supplierPolicyAssignments: {
    decisionDate: '2026-10-09',
    authority: 'USER_DIRECT_DECISION',
    basicSupplierIds: ['RP020', 'RP030', 'PT-0001', 'RP016', 'PT-0023', 'RP015', 'RP013', 'RP010'],
    policyKind: 'BASIC',
    policyRef: 'FREEPASS_BASIC',
    subscriptionUsesBasicTermLadder: true,
    unspecifiedNewDeliveryForm: 'REQUIRES_EVIDENCE',
    unspecifiedShortTerms: 'REQUIRES_EVIDENCE',
    billinProposal: { supplierIds: ['RP021', 'PT-0026'], state: 'CONFIRMED', termMonths: 36,
      billingBasis: 'MONTHLY_RENT_AT_36_MONTHS', billingPercent: 100, payoutPercentOfBilling: 80,
      authority: 'USER_DIRECT_DECISION_2026_10_09', appliesTo: 'SUBSCRIPTION',
      historicalSettlementRewrite: false },
  },
  currentAuthority: 'F04 수수료표 A1:M191(2026-10-04 사본) + AI 상황실 2026-10-05 결정(손오공 60개월 +60만, 원 미만 반올림) + 2026-10-09 대표 기본회사 지정 및 빌린카 LC 36개월 월대여료100/80 확정',
  evidenceHistory: [...KAKAO_COMMISSION_POLICY_2026_10_04.evidenceHistory,
    { policyId: KAKAO_COMMISSION_POLICY_2026_10_04.policyId, observedAt: '2026-10-04', revision: '35de6d9fa96ad07fba2fb2d68a4cb1c9113b61a5' }],
  sonokongAdditions: { ...KAKAO_COMMISSION_POLICY_2026_10_04.sonokongAdditions, 60: 600000 },
  sonokong60Evidence: { sourceRows: [14], evidence: 'private:ai-ops/정산-수수료규칙-20261005', decidedBy: 'AI 상황실 2026-10-05' },
  roundingRule: { rule: 'ROUND_HALF_UP_TO_WON', sourceRows: [171], evidence: 'private:ai-ops/정산-수수료규칙-20261005', decidedBy: 'AI 상황실 2026-10-05' },
  /** 뮤카(RP035, 2026-10-05 발급) 구독 — freepass-admin DEC-2026-10-04-01 8번 = F04 수수료표 169·170행. 일반·픽업 공통.
   * 청구(프리패스 몫) = 차량 기준가 × 1%(전 기간). 지급(영업 GA) = 선납/분납 × 기간 정액 + min(추가보증금 × 10%, 40만)(전 기간).
   * 별도 지급 재원 — 청구 − 지급 마진으로 계산하지 않는다. «분납 완납 전 미지급»은 계약 단계의 지급 가능 상태로 따로 다룬다. */
  mewcar: {
    supplierId: 'RP035', sourceRows: [169, 170], billingBasisPoints: 100,
    payout: { PREPAID: { 12: 1000000, 24: 1200000, 36: 1200000, 48: 1200000 }, INSTALLMENT: { 12: 800000, 24: 1000000, 36: 1000000, 48: 1000000 } },
    extraDepositPercent: 10, extraDepositCap: 400000, separateFunding: true,
    /** 2026-10-05 뮤카 조건 변경: 보증금 분납 폐지 + 영업 분납 정액 줄 삭제. 효력일(포함) 이후 계약일의 신규 분납 계약은 계산하지 않고 «확인 필요»로 멈춘다.
     * 그 전 계약(계약일 < 효력일)은 위 INSTALLMENT 옛 정액으로 계산한다. 선납 정액·추가보증금 10%(40만 한도)·프리패스 1% 는 그대로. */
    installmentAbolishedFrom: '2026-10-05',
  },
} as const;

const f04Ref = (row: number) => `F04:수수료표!A${row}:M${row}`;
// Supplier IDs from local supplierChannels and ERP4 origin/main partner-code/cleanup-partners.
const supplierFirstRow: Readonly<Record<string, number>> = {
  RP012: 3, RP013: 15, RP031: 22, RP016: 29, RP015: 36, RP019: 43,
  RP020: 50, RP032: 57, 'PT-0023': 64, RP017: 71, RP011: 78,
  RP021: 85, 'PT-0026': 85, RP010: 92, RP030: 99, 'PT-0012': 99,
  RP008: 106, 'PT-0001': 113, RP007: 113, RP018: 120, RP004: 129,
  RP006: 139, RP022: 146, RP033: 165,
};

type CommissionResolution = {
  sourceRefs?: string[];
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
  termMonths?: unknown;
  monthlyRent?: unknown;
  sourceAmount: unknown;
  supplierId?: unknown;
  productType?: unknown;
  depositFree?: unknown;
  depositFreeConfirmation?: unknown;
  depositSourceWaiverBasis?: unknown;
  hasPositivePaidDeposit?: boolean;
}) {
  const resolved = resolveDepositWithRuleNote(input);
  if (resolved.state === 'UNKNOWN') {
    return { depositAmount: null, depositState: 'UNKNOWN' as DepositState, depositRule: null };
  }
  if (resolved.state === 'ZERO') {
    return {
      depositAmount: 0,
      depositState: 'ZERO' as DepositState,
      depositRule: resolved.rule,
    };
  }
  return {
    depositAmount: resolved.amount,
    depositState: 'KNOWN' as DepositState,
    depositRule: resolved.rule,
    ...(resolved.depositRuleDifference ? { depositRuleDifference: resolved.depositRuleDifference } : {}),
  };
}

const calculatedCommission = (
  ruleId: string,
  amount: number,
  vatTreatment: VatTreatment,
): CommissionResolution => {
  if (Number.isFinite(amount)) amount = Math.round(amount); // 원 단위 반올림(F04 접수 관행, 아래 VAT 근거와 같음)
  if (!Number.isSafeInteger(amount) || amount < 0) return unknownCommission('COMMISSION_AMOUNT_OUT_OF_RANGE');
  // F04 접수 관행(2026-10-04 확정): VAT 포함 금액 ÷ 1.1 → 원 단위 반올림. 근거(원장 줄)는 비공개 기록.
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
  /** Same product and pricing variant: 36-month monthly rental amount, not total rent. */
  billin36MonthlyRent?: number | undefined;
  newProductSubtype?: 'NEW_PREDELIVERY' | 'NEW_MATCHING';
  /** Explicit contractual tier, never inferred from a deposit amount. */
  depositTierPercent?: 5 | 10;
  subscriptionForm?: 'BUYOUT' | 'RETURN';
  q12Basis?: { amount: number; sourceRef: string };
  /** 뮤카: 보증금 선납/분납(접수 납입 방식). 추정하지 않는다. */
  depositPayment?: 'PREPAID' | 'INSTALLMENT';
  /** 계약일(YYYY-MM-DD). 뮤카 분납은 계약일이 정책 효력일(2026-10-05) 전이냐 후냐로 갈린다 — 모르면 분납을 계산하지 않는다. */
  contractDate?: string;
  /** 뮤카: 추가보증금(원, 없으면 0 을 명시). 모르면 넣지 않는다 — 계산하지 않는다. */
  extraDeposit?: number;
  /** A suspected individual promotion must not silently use the general rule. */
  individualException?: boolean;
  /** Legacy private input name. Its shape is intentionally unsupported; callers must migrate to individualAgreement. */
  individualExceptionEvidence?: unknown;
  /**
   * 개별 합의(F04 수수료표 160·163행 유형). 신뢰된 비공개 호출자가 비공개 목록(ai-ops 인수인계)의 합의를 이 계약에 묶어 넘긴다 —
   * 금액·대상 계약은 공개 저장소에 두지 않는다. HTTP 등 신뢰할 수 없는 입력으로 받지 않는다.
   * status: APPROVED = 청구·지급 모두 합의 금액, PAYOUT_CONFIRMED = 지급만(청구는 미확정), UNCONFIRMED = 둘 다 미확정.
   * 금액은 공급가(VAT 별도) 원 단위 정수, 미확정이면 null.
   */
  individualAgreement?: {
    agreementId: string;
    sourceRow: 160 | 163;
    status: 'APPROVED' | 'PAYOUT_CONFIRMED' | 'UNCONFIRMED';
    contractRef: string;
    matchedContractRef: string;
    billing: number | null;
    payout: number | null;
  };
};

/** YYYY-MM-DD 가 «달력에 실제로 있는 날»인지(Date.parse 는 2026-02-30 을 03-02 로 보정하므로 연·월·일을 되확인한다). */
function isCalendarDate(value: unknown): boolean {
  const m = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** 뮤카 구독(RP035). 사유 코드는 모두 MEWCAR_ 로 시작한다 — 마진 계산이 이 표시로 별도 재원임을 안다. */
function resolveMewcar(input: CommissionInput, productType: string, side: 'BILLING' | 'PAYOUT'): CommissionResolution {
  const rule = KAKAO_COMMISSION_POLICY.mewcar;
  if (!/구독/.test(productType)) return unknownCommission('MEWCAR_SUBSCRIPTION_ONLY');
  const term = input.termMonths as 12 | 24 | 36 | 48;
  if (![12, 24, 36, 48].includes(term)) return unknownCommission('MEWCAR_TERM_NOT_IN_POLICY');
  if (side === 'BILLING') {
    if (!Number.isSafeInteger(input.vehicleValue) || input.vehicleValue! <= 0) return unknownCommission('MEWCAR_BASE_PRICE_REQUIRED');
    return calculatedCommission('MEWCAR_FREEPASS_SHARE_BILLING', input.vehicleValue! * rule.billingBasisPoints / 10000, 'EXCLUDED');
  }
  if (input.depositPayment !== 'PREPAID' && input.depositPayment !== 'INSTALLMENT') return unknownCommission('MEWCAR_DEPOSIT_PAYMENT_REQUIRED');
  if (input.depositPayment === 'INSTALLMENT') {
    // 분납은 10-05 이후 폐지 — 계약일을 모르면 어느 규칙인지 모르므로 멈추고, 효력일 이후면 «확인 필요»로 멈춘다(옛 정액을 내지 않는다).
    if (!isCalendarDate(input.contractDate)) return unknownCommission('MEWCAR_CONTRACT_DATE_REQUIRED');
    if (input.contractDate! >= rule.installmentAbolishedFrom) return unknownCommission('MEWCAR_INSTALLMENT_ABOLISHED_CONFIRM_REQUIRED');
  }
  if (!Number.isSafeInteger(input.extraDeposit) || input.extraDeposit! < 0) return unknownCommission('MEWCAR_EXTRA_DEPOSIT_REQUIRED');
  const addition = Math.min(Math.round(input.extraDeposit! * rule.extraDepositPercent / 100), rule.extraDepositCap);
  return calculatedCommission(`MEWCAR_GA_${input.depositPayment}_${term}_PAYOUT`, rule.payout[input.depositPayment][term] + addition, 'EXCLUDED');
}

function resolveCommissionAmount(input: CommissionInput, side: 'BILLING' | 'PAYOUT'): CommissionResolution {
  const { supplierId, termMonths, monthlyRent } = input;
  const rawProduct = input.productType.trim();
  const inferredSubtype = rawProduct === '견적출고' ? 'NEW_MATCHING' : rawProduct === '선출고' ? 'NEW_PREDELIVERY' : undefined;
  if (inferredSubtype && input.newProductSubtype && inferredSubtype !== input.newProductSubtype) return unknownCommission('CONFLICTING_NEW_PRODUCT_SUBTYPE');
  if (inferredSubtype && !input.newProductSubtype) input = { ...input, newProductSubtype: inferredSubtype };
  const productType = inferredSubtype ? '신차렌트' : rawProduct === '장기렌트' ? '재렌트' : rawProduct;
  const billing = side === 'BILLING';
  const fixed = (id: string, amount: number, vat: VatTreatment = 'EXCLUDED') => calculatedCommission(id, amount, vat);
  const agreement = input.individualAgreement;
  const hasAgreement = agreement !== undefined;
  if (!hasAgreement && input.individualExceptionEvidence !== undefined) {
    return unknownCommission('LEGACY_INDIVIDUAL_EXCEPTION_INPUT');
  }
  if (supplierId === 'RP034') return { ...unknownCommission('SUPPLIER_EXCLUDED_BY_DECISION'), state: 'NOT_APPLICABLE' };
  if (!Number.isSafeInteger(termMonths) || termMonths < 1 || !Number.isSafeInteger(monthlyRent) || monthlyRent < 0) return unknownCommission('INVALID_PRICE_TERM_INPUT');
  if (hasAgreement && (!agreement || typeof agreement !== 'object' || Array.isArray(agreement))) return unknownCommission('INDIVIDUAL_AGREEMENT_INVALID');
  if (input.individualException || hasAgreement) {
    if (!agreement || !/^opaque:[a-zA-Z0-9_-]{16,}$/.test(agreement.contractRef) || agreement.contractRef !== agreement.matchedContractRef
      || !/^private:[a-zA-Z0-9_-]{4,}$/.test(agreement.agreementId) || ![160, 163].includes(agreement.sourceRow)) return unknownCommission('INDIVIDUAL_EXCEPTION_EVIDENCE_REQUIRED');
    const allowed = agreement.status === 'APPROVED' || (agreement.status === 'PAYOUT_CONFIRMED' && !billing);
    const amount = billing ? agreement.billing : agreement.payout;
    if (!allowed || amount === null) return unknownCommission(billing ? 'INDIVIDUAL_BILLING_BASIS_UNCONFIRMED' : 'INDIVIDUAL_PAYOUT_BASIS_UNCONFIRMED');
    if (!Number.isSafeInteger(amount) || amount < 0) return unknownCommission('INDIVIDUAL_AGREEMENT_AMOUNT_INVALID');
    return fixed(`INDIVIDUAL_AGREEMENT_${side}`, amount);
  }
  // 뮤카는 개별 예외 검사 뒤에 — 개별 표시가 있는 계약에 일반 정액을 내지 않는다.
  if (supplierId === KAKAO_COMMISSION_POLICY.mewcar.supplierId) return resolveMewcar(input, productType, side);
  const rerent = /^(중고렌트|재렌트)$/.test(productType);
  const subscription = /구독/.test(productType);
  if (supplierId === 'RP013' && /발주/.test(productType)) return unknownCommission('WELRIX_ORDER_RULE_UNCONFIRMED');
  if (supplierId === 'RP012' && /^픽업\s*구독(?:\(롯데T카\))?$/.test(productType)) {
    if (!Number.isSafeInteger(input.vehicleValue) || input.vehicleValue! <= 0) return unknownCommission('VEHICLE_VALUE_REQUIRED');
    return fixed(`SONOKONG_PICKUP_${side}`, input.vehicleValue! * (billing ? 400 : 300) / 10000);
  }
  if (['RP021', 'PT-0026'].includes(supplierId) && subscription) {
    const basis = input.billin36MonthlyRent ?? (termMonths === 36 ? monthlyRent : undefined);
    if (!Number.isSafeInteger(basis) || basis! <= 0) return unknownCommission('BILLIN_36_MONTH_RENT_REQUIRED');
    if (termMonths === 36 && basis !== monthlyRent) return unknownCommission('BILLIN_36_MONTH_RENT_CONFLICT');
    return fixed(`BILLIN_SUBSCRIPTION_36_RENT_${side}`, basis! * (billing ? 1 : 0.8));
  }
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
  // F04 161행 계약기간 「기간 무관」(123행 일반 구독과 같음): 기간 검증 없이 정액.
  if (supplierId === 'RP023' && subscription && /전기/.test(input.fuel ?? '')) return fixed(`AUTOPLUS_EV_SUBSCRIPTION_${side}`, billing ? 1500000 : 1300000);
  if (supplierId === 'RP023' && subscription && !text(input.fuel)) return unknownCommission('FUEL_REQUIRED_FOR_SUPPLIER_RULE');
  if (supplierId === 'RP023' && subscription) return fixed(billing ? 'AUTOPLUS_SUBSCRIPTION_BILLING_FIXED' : 'AUTOPLUS_SUBSCRIPTION_FIXED', billing ? 1000000 : 800000);
  if (supplierId === 'RP014' && subscription) return resolveTermLadder(termMonths, monthlyRent, side, 'SWITCH_SUBSCRIPTION');
  if (supplierId === 'RP004') {
    if (!subscription && (rerent || input.newProductSubtype === 'NEW_PREDELIVERY') && !text(input.fuel)) return unknownCommission('FUEL_REQUIRED_FOR_SUPPLIER_RULE');
    if (!subscription && (rerent || (productType === '신차렌트' && input.newProductSubtype === 'NEW_PREDELIVERY')) && /전기/.test(input.fuel ?? '')) return fixed(billing ? 'IANCAR_EV_BILLING_FIXED' : 'IANCAR_EV_FIXED', billing ? 1000000 : 800000);
    if (rerent && termMonths === 6) return fixed(billing ? 'IANCAR_RERENT_6_MONTH_BILLING_FIXED' : 'IANCAR_RERENT_6_MONTH_FIXED', billing ? 400000 : 300000);
    if (rerent && termMonths === 1) return unknownCommission('IANCAR_SHORT_TERM_BASIS_REQUIRED');
  }
  if (!standardLadderSupplier(supplierId)) return unknownCommission('SUPPLIER_RULE_NOT_IN_F04_CANONICAL_TABLE');
  if (subscription && KAKAO_COMMISSION_POLICY.supplierPolicyAssignments.basicSupplierIds.some(id => id === supplierId)) {
    return resolveTermLadder(termMonths, monthlyRent, side);
  }
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

function resolveCommission(input: CommissionInput, side: 'BILLING' | 'PAYOUT'): CommissionResolution {
  const result = resolveCommissionAmount(input, side);
  const id = result.ruleId ?? '';
  const product = input.productType.trim();
  const first = supplierFirstRow[input.supplierId];
  let rows: number[] = [];
  if (input.individualException || input.individualAgreement || input.individualExceptionEvidence !== undefined) rows = input.individualAgreement ? [input.individualAgreement.sourceRow] : [160, 163];
  else if (input.supplierId === 'RP034') rows = [168];
  else if (input.supplierId === KAKAO_COMMISSION_POLICY.mewcar.supplierId) rows = [...KAKAO_COMMISSION_POLICY.mewcar.sourceRows];
  else if (input.supplierId === 'RP012' && /^픽업\s*구독/.test(product)) rows = [190];
  else if (input.supplierId === 'RP012' && /구독/.test(product)) rows = [({12:10,24:11,36:12,48:13,60:14} as Record<number, number>)[input.termMonths] ?? 183, 173, 191];
  else if (input.supplierId === 'RP023' && /구독/.test(product)) rows = /전기/.test(input.fuel ?? '') ? [161] : [123, 161];
  else if (['RP021', 'PT-0026'].includes(input.supplierId) && /구독/.test(product)) rows = [162];
  else if (input.supplierId === 'RP014') rows = /구독/.test(product) ? ([12,24,36,48,60].includes(input.termMonths) ? [124 + [12,24,36,48,60].indexOf(input.termMonths)] : [183,184,185,186,187,188,189]) : [175,176];
  else if (/구독/.test(product) && first && KAKAO_COMMISSION_POLICY.supplierPolicyAssignments.basicSupplierIds.some(supplierId => supplierId === input.supplierId)) {
    const index = [12,24,36,48,60].indexOf(input.termMonths);
    rows = index >= 0 ? [first + 2 + index] : [183,184,185,186,187,188,189];
  }
  else if (input.supplierId === 'RP013' && /구독|발주/.test(product)) rows = /구독/.test(product) ? [174] : [164];
  else if (id.startsWith('IANCAR_EV')) rows = [138];
  else if (id.startsWith('IANCAR_RERENT_6')) rows = [132];
  else if (result.reasonCode === 'IANCAR_SHORT_TERM_BASIS_REQUIRED') rows = [131];
  else if (first) {
    if (/신차|선출고|견적출고/.test(product) && !/구독/.test(product)) rows = [first + (input.newProductSubtype === 'NEW_MATCHING' || product === '견적출고' ? 1 : 0)];
    else if (['RP018','RP033'].includes(input.supplierId)) rows = [first + 2];
    else { const offset = [12,24,36,48,60].indexOf(input.termMonths); rows = offset < 0 ? [183,184,185,186,187,188,189] : [first + (input.supplierId === 'RP004' ? 4 : 2) + offset]; }
  } else rows = [177,178,179,180,181,182];
  if (result.reasonCode === 'WON_ROUNDING_POLICY_UNCONFIRMED') rows.push(171);
  if (result.reasonCode === 'DEPOSIT_TIER_REQUIRED') rows.push(172);
  // 근거 행은 계산된 결과에만 단다. UNKNOWN·NOT_APPLICABLE·협의는 reasonCode만 — 미등록 공급사가 「근거 있는 규칙」처럼 보이지 않게.
  if (result.state !== 'CALCULATED') return result;
  if (id.startsWith('BILLIN_SUBSCRIPTION_36_RENT')) return { ...result, sourceRefs: ['USER:2026-10-09:BILLIN_LC_36_MONTH_RENT_100_80'] };
  return { ...result, sourceRefs: [...new Set(rows)].map(f04Ref) };
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
  // 뮤카: 프리패스 몫과 영업 GA 지급은 재원이 따로라 청구 − 지급 마진을 만들지 않는다(F04 169·170행).
  if ([supplierBillingFee, channelPayoutFee].some(r => r.ruleId?.startsWith('MEWCAR_') || r.reasonCode?.startsWith('MEWCAR_'))) {
    return {
      state: 'NOT_APPLICABLE', amount: null, currency: 'KRW',
      basis: 'SUPPLY_AMOUNT_EXCLUDING_VAT', reasonCode: 'SEPARATE_FUNDING_NO_MARGIN',
    };
  }
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

export type CommissionEvidenceByTerm = Readonly<Record<string, Partial<Pick<CommissionInput,
  'vehicleValue' | 'newProductSubtype' | 'depositTierPercent' | 'subscriptionForm' | 'q12Basis' | 'individualException' | 'individualAgreement' | 'individualExceptionEvidence'>>>>;

export function resolveReferencePolicyContext(source: Rec, policies: Record<string, Rec> = {}) {
  const policyId = text(source.policy_code) || null;
  const matches = policyId ? Object.entries(policies).filter(([id, policy]) =>
    id === policyId || text(policy.policy_code) === policyId) : [];
  const reasonCode = !policyId ? 'POLICY_LINK_MISSING' : matches.length === 0 ? 'POLICY_NOT_FOUND'
    : matches.length > 1 ? 'POLICY_LINK_AMBIGUOUS' : null;
  const empty = (reason: string) => ({ state: 'UNKNOWN' as const, policyId, sourceRef: null,
    facts: [] as Array<{ key: string; label: string; value: NonNullable<ReturnType<typeof policyScalar>>; sourceRef: string }>, reasonCode: reason });
  if (reasonCode) return empty(reasonCode);
  const [id, policy] = matches[0]!;
  if (text(policy.provider_company_code) && text(policy.provider_company_code) !== text(source.provider_company_code)) {
    return empty('POLICY_SUPPLIER_MISMATCH');
  }
  const values = policy.facts && typeof policy.facts === 'object' && !Array.isArray(policy.facts) ? policy.facts as Rec : policy;
  const allowed = new Map(CONDITION_DIMENSION_SPECS.flatMap(spec => spec.sourcePolicyKeys.map(key => [key, spec.label] as const)));
  const sourceRef = `policy/${id}`;
  const facts = [...allowed].flatMap(([key, label]) => {
    const value = policyScalar(values[key]);
    return value === undefined || value === '' || (Array.isArray(value) && !value.length) ? []
      : [{ key, label, value, sourceRef: `${sourceRef}/${key}` }];
  });
  // Raw allowed facts only: availability is not policy verification or eligibility approval.
  return { state: facts.length ? 'REFERENCE' as const : 'UNKNOWN' as const, policyId, sourceRef, facts,
    reasonCode: facts.length ? null : 'POLICY_FACTS_MISSING' };
}

export function buildKakaoCatalogReferenceProduct(documentId: string, source: Rec, evidenceByTerm: CommissionEvidenceByTerm = {}, policies: Record<string, Rec> = {}, observedAt?: string) {
  if (source.listable !== true) return null;
  const supplierId = text(source.provider_company_code);
  if (!supplierId) return null;
  const price = source.price;
  if (!price || typeof price !== 'object' || Array.isArray(price)) return null;
  const priceTerms = Object.entries(price as Rec).flatMap(([sourceKey, raw]) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const parsed = parseErp5CompatibilityPriceKey(sourceKey);
    const monthlyRent = integer((raw as Rec).rent);
    if (!parsed || monthlyRent === null || monthlyRent <= 0) return [];
    const basis36 = Object.entries(price as Rec).flatMap(([key, value]) => {
      const candidate = parseErp5CompatibilityPriceKey(key);
      if (!candidate || candidate.months !== 36 || candidate.settlement !== parsed.settlement || (candidate.contractedMileage?.km ?? candidate.mileageKm) !== (parsed.contractedMileage?.km ?? parsed.mileageKm) || (candidate.contractedMileage?.period ?? 'year') !== (parsed.contractedMileage?.period ?? 'year') || !value || typeof value !== 'object' || Array.isArray(value)) return [];
      const amount = integer((value as Rec).rent);
      return amount !== null && amount > 0 ? [amount] : [];
    });
    const billin36MonthlyRent = basis36.length === 1 ? basis36[0] : undefined;
    const depositInput = depositEvidenceInputFromProduct(source, (raw as Rec).deposit, {
      termMonths: parsed.months,
      monthlyRent,
      hasPositivePaidDeposit: hasConflictingPaidDeposit(price),
    });
    const publishedDeposit = supplierId === 'RP031' && source.iancar_phase_one
      ? readIancarPublishedDeposit(source, sourceKey, observedAt) : null;
    const deposit = publishedDeposit ? {
      depositAmount: publishedDeposit.amount,
      depositState: publishedDeposit.state,
      depositRule: publishedDeposit.state === 'UNKNOWN' ? null : {
        code: 'IANCAR_PUBLISHED_CONDITION_EVIDENCE', multiplier: null, label: '공급사 기간·주행거리 조건',
      },
    } : resolveReferenceDeposit(depositInput);
    const depositEvidence = {
      sourceRef: `source-product:${documentId}#price:${sourceKey}`,
      sourceAmount: typeof (raw as Rec).deposit === 'number' || typeof (raw as Rec).deposit === 'string' ? (raw as Rec).deposit as number | string : null,
      sourceNote: text(source.deposit_note) || null,
      reasonCode: publishedDeposit?.reason ?? deposit.depositRule?.code ?? assessDepositEvidence(depositInput).reason,
    };
    const channelPayoutFee = resolveSalesCommission({
      ...evidenceByTerm[sourceKey],
      supplierId,
      productType: text(source.product_type),
      fuel: text(source.fuel_type),
      termMonths: parsed.months,
      monthlyRent,
      billin36MonthlyRent,
    });
    const supplierBillingFee = resolveSupplierBillingFee({
      ...evidenceByTerm[sourceKey],
      supplierId,
      productType: text(source.product_type),
      fuel: text(source.fuel_type),
      termMonths: parsed.months,
      monthlyRent,
      billin36MonthlyRent,
    });
    const expectedGrossMargin = resolveExpectedGrossMargin(supplierBillingFee, channelPayoutFee);
    return [{
      termKey: `source:${sourceKey}`,
      termMonths: parsed.months,
      monthlyRent: { amount: monthlyRent, currency: 'KRW' as const },
      deposit: deposit.depositAmount === null ? null : { amount: deposit.depositAmount, currency: 'KRW' as const },
      ...deposit,
      ...('depositRuleDifference' in deposit && deposit.depositRuleDifference ? { depositRuleDifference: deposit.depositRuleDifference } : {}),
      depositEvidence,
      depositStatusLabel: depositStatusLabel(deposit.depositState, (raw as Rec).deposit, source.deposit_note),
      mileageLimitKmPerYear: parsed.mileageKm ?? null,
      ...(parsed.contractedMileage ? { contractedMileage: parsed.contractedMileage } : {}),
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
      policyContext: resolveReferencePolicyContext(source, policies),
      priceTerms,
    }],
  };
}

export function buildKakaoCatalogReference(input: {
  consumerId: string;
  products: Record<string, Rec>;
  observedAt: string;
  /** Policy documents captured with the same source read. Only approved fact keys are projected. */
  policies?: Record<string, Rec>;
  /** Trusted private evidence, keyed by product ID then exact ERP price key. */
  commissionEvidenceByProduct?: Readonly<Record<string, CommissionEvidenceByTerm>>;
  /** Master/trim share their sealed snapshot. Products/policies are separate reads. */
  vehicleMasterSnapshot?: VehicleMasterSnapshot | null;
  vehicleMasterReadState?: 'AVAILABLE' | 'UNAVAILABLE';
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

function buildReferenceFacts(input: KakaoCatalogReferenceSource) {
  type NativeReference = (VehicleMasterReference & { reasonCode: null }) | {
    state: 'HOLD'; authority: 'FREEPASS_DATA_VEHICLE_MASTER'; identityKind: 'FIRESTORE_DOCUMENT_ID';
    masterId: null; trimId: null; snapshotDigest: string | null; readAt: string | null; reasonCode: string;
  };
  const hold = (reasonCode: string, snapshot?: VehicleMasterSnapshot): NativeReference => ({ state: 'HOLD',
    authority: 'FREEPASS_DATA_VEHICLE_MASTER', identityKind: 'FIRESTORE_DOCUMENT_ID', masterId: null, trimId: null,
    snapshotDigest: snapshot?.digest ?? null, readAt: snapshot?.readAt ?? null, reasonCode });
  const master = input.vehicleMasterSnapshot;
  let resolveMaster: (source: Rec) => NativeReference = () => hold(input.vehicleMasterReadState === 'UNAVAILABLE'
    ? 'VEHICLE_MASTER_READ_UNAVAILABLE' : 'VEHICLE_MASTER_SNAPSHOT_MISSING');
  if (master && input.vehicleMasterReadState !== 'UNAVAILABLE') {
    try {
      const now = Date.parse(input.observedAt);
      const index = indexVehicleMaster(verifiedMasterRecords(master, now));
      resolveMaster = source => {
        const choice = chooseVehicleIdentity(index, { sheet: [text(source.maker), text(source.model), text(source.sub_model), text(source.trim_name)],
          data: null, raw: '', firstRegistration: '', modelYear: '' });
        if (choice.pick === 'HOLD') return hold('VEHICLE_MASTER_IDENTITY_NOT_UNIQUE', master);
        const verified = verifiedVehicleMasterReference(master, choice, now);
        return verified.state === 'KNOWN' ? { ...verified, reasonCode: null } : hold(verified.reason, master);
      };
    } catch {
      // No credentials/raw exception strings; unavailable identity must not remove economic terms.
      resolveMaster = () => hold('VEHICLE_MASTER_SNAPSHOT_UNVERIFIED');
    }
  }
  const data = Object.entries(input.products)
    .map(([id, source]) => buildKakaoCatalogReferenceProduct(id, source, input.commissionEvidenceByProduct?.[id], input.policies, input.observedAt))
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .map(row => ({ ...row, vehicleMasterReference: resolveMaster(input.products[row.sourceProductId]!) }))
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

/** All term conditions match one item; sibling terms remain visible. */
export function filterReferenceProducts<T extends KakaoCatalogReference | ReturnType<typeof buildInternalAiReference>>(reference: T, query: Record<string, unknown>): T {
  const fields = ['supplierId','supplierName','plateNumber','maker','model','commercialType','assetStatus'];
  const numeric = ['termMonths','mileageKm','monthlyRentMin','monthlyRentMax','depositMin','depositMax'];
  const keys = [...fields,...numeric,'mileagePeriod','depositState','depositScope'];
  const invalid = () => { throw new Error('REFERENCE_DEPOSIT_FILTER_INVALID'); };
  if (!Object.keys(query).length) return reference;
  for (const [key,value] of Object.entries(query)) {
    if (!keys.includes(key) || typeof value !== 'string' || !value.trim() || (!['supplierName','plateNumber'].includes(key) && value !== value.trim())) invalid();
    if (numeric.includes(key) && (!/^(0|[1-9]\d*)$/.test(String(value)) || !Number.isSafeInteger(Number(value)))) invalid();
  }
  const nameKey = (value: unknown) => typeof value === 'string' ? value.normalize('NFC').replace(/\s+/g,'') : '';
  // Lookup-only normalization explicitly requested by the user; never changes stored identity.
  const plateKey = (value: unknown) => plateIdentityKey(typeof value === 'string' ? value.normalize('NFC') : value).replace(/-/g,'');
  if (query.plateNumber !== undefined && !isStrictKoreanPlate(plateKey(query.plateNumber))) invalid();
  if (query.termMonths !== undefined && (Number(query.termMonths)<1 || Number(query.termMonths)>60)) invalid();
  if (query.depositState !== undefined && !['ZERO','KNOWN','UNKNOWN'].includes(String(query.depositState))) invalid();
  if (query.depositScope !== undefined && (query.depositState !== 'ZERO' || !['ANY_TERM','ALL_TERMS'].includes(String(query.depositScope)))) invalid();
  if (query.mileagePeriod !== undefined && !['year','month'].includes(String(query.mileagePeriod))) invalid();
  if ((query.mileageKm === undefined) !== (query.mileagePeriod === undefined)) invalid();
  for (const prefix of ['monthlyRent','deposit']) if (query[prefix+'Min'] !== undefined && query[prefix+'Max'] !== undefined && Number(query[prefix+'Min'])>Number(query[prefix+'Max'])) invalid();
  type Term = T['data'][number]['offers'][number]['priceTerms'][number];
  const zero = (t: Term) => t.depositState === 'ZERO' && t.depositAmount === 0 && t.deposit?.amount === 0;
  const range = (v: number | null | undefined, k: string) => (query[k+'Min'] === undefined && query[k+'Max'] === undefined) ||
    (v !== null && v !== undefined && (query[k+'Min'] === undefined || v>=Number(query[k+'Min'])) && (query[k+'Max'] === undefined || v<=Number(query[k+'Max'])));
  const match = (t: Term) => (query.termMonths === undefined || t.termMonths === Number(query.termMonths)) &&
    (query.depositState === undefined || (query.depositState === 'ZERO' ? zero(t) : t.depositState === query.depositState)) &&
    range(t.monthlyRent.amount,'monthlyRent') && range(t.depositAmount,'deposit') &&
    (query.mileageKm === undefined || (t.contractedMileage ? t.contractedMileage.km === Number(query.mileageKm) && t.contractedMileage.period === query.mileagePeriod : query.mileagePeriod === 'year' && t.mileageLimitKmPerYear === Number(query.mileageKm)));
  const data = reference.data.filter(p => (query.plateNumber === undefined || plateKey(p.vehicle.plateNumber) === plateKey(query.plateNumber)) && (query.maker === undefined || p.vehicle.maker === query.maker) &&
    (query.model === undefined || p.vehicle.model === query.model) && (query.commercialType === undefined || p.commercialType === query.commercialType) &&
    (query.assetStatus === undefined || p.vehicle.assetStatus === query.assetStatus) &&
    p.offers.some(o => (query.supplierId === undefined || o.supplierId === query.supplierId) && (query.supplierName === undefined || nameKey(o.supplierName) === nameKey(query.supplierName)) && o.priceTerms.some(match)) &&
    (query.depositScope !== 'ALL_TERMS' || p.offers.flatMap(o => o.priceTerms).every(zero)));
  const supplierCodes = new Set(data.flatMap(p => p.offers).filter(o => query.supplierName !== undefined && nameKey(o.supplierName) === nameKey(query.supplierName) && (query.supplierId === undefined || o.supplierId === query.supplierId) && o.priceTerms.some(match)).map(o => o.supplierId));
  const plateCandidates = query.plateNumber === undefined ? [] : data.filter(p => plateKey(p.vehicle.plateNumber) === plateKey(query.plateNumber));
  const queryResolution = { state: supplierCodes.size > 1 || plateCandidates.length > 1 ? 'HOLD' : data.length ? 'MATCHED' : 'NO_MATCH', reasonCode: supplierCodes.size > 1 ? 'SUPPLIER_NAME_MULTIPLE_CODES' : plateCandidates.length > 1 ? 'PLATE_MULTIPLE_PRODUCTS' : null, matchedProductCount: data.length };
  return { ...reference,data,meta: { ...reference.meta,projectedCount:data.length,dataDigest:hash(JSON.stringify(data)),queryFilter:{...query},...(query.supplierName !== undefined || query.plateNumber !== undefined ? {queryResolution} : {}),
    ...(query.depositState === 'ZERO' ? {depositFilter:{state:'ZERO',termMonths:query.termMonths === undefined ? null : Number(query.termMonths),scope:query.depositScope === 'ALL_TERMS' ? 'ALL_TERMS' : 'ANY_TERM'}} : {}) } } as T;
}
export const filterReferenceZeroDeposit = filterReferenceProducts;
