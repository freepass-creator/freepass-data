import { createHash } from 'node:crypto';
import { parseErp5PriceKey } from '../adapters/erp5-product-mapping.js';

type Rec = Record<string, unknown>;
type DepositState = 'KNOWN' | 'ZERO' | 'UNKNOWN';
type VatTreatment = 'EXCLUDED' | 'INCLUDED' | 'UNKNOWN';
type CommissionState = 'CALCULATED' | 'COORDINATION_REQUIRED' | 'UNKNOWN' | 'NOT_APPLICABLE';
type MarginState = 'CALCULATED' | 'UNKNOWN' | 'NOT_APPLICABLE';

export const KAKAO_CATALOG_REFERENCE_SCHEMA = 'freepass-data.kakao-catalog-reference/v1' as const;

export const KAKAO_COMMISSION_POLICY = {
  policyId: 'sales-commission-2026-09-28',
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
    star: ['RP018'],
    autoplus: ['RP023'],
    switchplan: ['RP014'],
    iancar: ['RP004'],
    iron: ['RP006'],
    pacific: ['RP022'],
    mindcarWithoutPublishedRule: ['RP034'],
  },
  rules: [
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
    { id: 'SONOKONG_SUBSCRIPTION_12_MONTH_RENT_100_PERCENT', supplierGroup: 'SONOKONG', product: 'SUBSCRIPTION', basis: 'COORDINATION', rateBasisPoints: null, vatTreatment: 'EXCLUDED', coordinationRequired: true },
    { id: 'STAR_RERENT_ONE_MONTH_RENT_X_80_PERCENT', supplierGroup: 'STAR', product: 'RERENT', basis: 'COORDINATION', rateBasisPoints: null, vatTreatment: 'INCLUDED', coordinationRequired: true },
    { id: 'AUTOPLUS_SUBSCRIPTION_FIXED', supplierGroup: 'AUTOPLUS', product: 'SUBSCRIPTION', basis: 'FIXED', fixedAmount: 800000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'AUTOPLUS_SUBSCRIPTION_BILLING_FIXED', supplierGroup: 'AUTOPLUS', product: 'SUBSCRIPTION', basis: 'FIXED', fixedAmount: 1000000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'SWITCH_SUBSCRIPTION_LADDER', supplierGroup: 'SWITCH', product: 'SUBSCRIPTION', basis: 'TERM_LADDER', vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'IANCAR_RERENT_1_MONTH', supplierGroup: 'IANCAR', product: 'RERENT', termMonths: 1, basis: 'COORDINATION', rateBasisPoints: null, vatTreatment: 'EXCLUDED', coordinationRequired: true },
    { id: 'IANCAR_RERENT_6_MONTH_BILLING_FIXED', supplierGroup: 'IANCAR', product: 'RERENT', termMonths: 6, basis: 'FIXED', fixedAmount: 400000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'IANCAR_RERENT_6_MONTH_FIXED', supplierGroup: 'IANCAR', product: 'RERENT', termMonths: 6, basis: 'FIXED', fixedAmount: 300000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'IANCAR_EV_BILLING_FIXED', supplierGroup: 'IANCAR', product: 'EV', basis: 'FIXED', fixedAmount: 1000000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'IANCAR_EV_FIXED', supplierGroup: 'IANCAR', product: 'EV', basis: 'FIXED', fixedAmount: 800000, vatTreatment: 'EXCLUDED', coordinationRequired: false },
    { id: 'PACIFIC_NEW_PREDELIVERY_DEPOSIT_TIER', supplierGroup: 'PACIFIC', product: 'NEW_PREDELIVERY', basis: 'COORDINATION', rateBasisPoints: null, vatTreatment: 'INCLUDED', coordinationRequired: true },
    { id: 'PACIFIC_NEW_MATCHING_DEPOSIT_TIER', supplierGroup: 'PACIFIC', product: 'NEW_MATCHING', basis: 'COORDINATION', rateBasisPoints: null, vatTreatment: 'INCLUDED', coordinationRequired: true },
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
}) {
  const note = text(input.note);
  const known = (code: string, multiplier: number, label: string) => {
    const depositAmount = input.monthlyRent * multiplier;
    if (!Number.isSafeInteger(depositAmount)) {
      return { depositAmount: null, depositState: 'UNKNOWN' as DepositState, depositRule: null };
    }
    return {
      depositAmount,
      depositState: 'KNOWN' as DepositState,
      depositRule: { code, multiplier, label },
    };
  };
  if (note === '무보증') {
    return {
      depositAmount: 0,
      depositState: 'ZERO' as DepositState,
      depositRule: { code: 'ZERO_DEPOSIT', multiplier: 0, label: '무보증' },
    };
  }
  if (input.monthlyRent > 0) {
    if (/^월 대여료 × 약정연수 \(최대 3개월\)$/.test(note)) {
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
  if (!Number.isSafeInteger(amount) || amount < 0) {
    return { state: 'UNKNOWN', ruleId, amount: null, vatTreatment, vatAmount: null, totalAmount: null, reasonCode: 'ROUNDING_RULE_UNSPECIFIED' };
  }
  if (vatTreatment === 'INCLUDED') {
    return { state: 'CALCULATED', ruleId, amount, vatTreatment, vatAmount: null, totalAmount: amount, reasonCode: null };
  }
  const vatAmount = amount / 10;
  if (!Number.isSafeInteger(vatAmount)) {
    return { state: 'UNKNOWN', ruleId, amount: null, vatTreatment, vatAmount: null, totalAmount: null, reasonCode: 'VAT_ROUNDING_RULE_UNSPECIFIED' };
  }
  return { state: 'CALCULATED', ruleId, amount, vatTreatment, vatAmount, totalAmount: amount + vatAmount, reasonCode: null };
};

const coordination = (ruleId: string, vatTreatment: VatTreatment): CommissionResolution => ({
  state: 'COORDINATION_REQUIRED', ruleId, amount: null, vatTreatment, vatAmount: null, totalAmount: null, reasonCode: 'SALES_COORDINATION_REQUIRED',
});
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

export function resolveSalesCommission(input: {
  supplierId: string;
  productType: string;
  fuel: string;
  termMonths: number;
  monthlyRent: number;
}): CommissionResolution {
  const { supplierId, productType, fuel, termMonths, monthlyRent } = input;
  if (KAKAO_COMMISSION_POLICY.exceptionSupplierIds.sonokong.includes(supplierId as 'RP012') && /구독/.test(productType)) {
    return coordination('SONOKONG_SUBSCRIPTION_12_MONTH_RENT_100_PERCENT', 'EXCLUDED');
  }
  if (KAKAO_COMMISSION_POLICY.exceptionSupplierIds.star.includes(supplierId as 'RP018') && /렌트/.test(productType)) {
    return coordination('STAR_RERENT_ONE_MONTH_RENT_X_80_PERCENT', 'INCLUDED');
  }
  if (KAKAO_COMMISSION_POLICY.exceptionSupplierIds.autoplus.includes(supplierId as 'RP023') && /구독/.test(productType)) {
    return calculatedCommission('AUTOPLUS_SUBSCRIPTION_FIXED', 800000, 'EXCLUDED');
  }
  if (KAKAO_COMMISSION_POLICY.exceptionSupplierIds.switchplan.includes(supplierId as 'RP014') && /구독/.test(productType)) {
    return resolveTermLadder(termMonths, monthlyRent, 'PAYOUT', 'SWITCH_SUBSCRIPTION');
  }
  if (KAKAO_COMMISSION_POLICY.exceptionSupplierIds.iancar.includes(supplierId as 'RP004')) {
    if (/전기/.test(fuel)) return calculatedCommission('IANCAR_EV_FIXED', 800000, 'EXCLUDED');
    if (/렌트/.test(productType) && termMonths === 6) return calculatedCommission('IANCAR_RERENT_6_MONTH_FIXED', 300000, 'EXCLUDED');
    if (/렌트/.test(productType) && termMonths === 1) return coordination('IANCAR_RERENT_1_MONTH', 'EXCLUDED');
  }
  if (KAKAO_COMMISSION_POLICY.exceptionSupplierIds.pacific.includes(supplierId as 'RP022') && /신차/.test(productType)) {
    return coordination('PACIFIC_NEW_PREDELIVERY_DEPOSIT_TIER', 'INCLUDED');
  }
  if (!standardLadderSupplier(supplierId)) {
    return unknownCommission('SUPPLIER_RULE_NOT_IN_F04_CANONICAL_TABLE');
  }
  if (/중고렌트|재렌트/.test(productType)) {
    return resolveTermLadder(termMonths, monthlyRent, 'PAYOUT');
  }
  if (/신차/.test(productType)) return unknownCommission('NEW_PRODUCT_SUBTYPE_OR_VEHICLE_VALUE_NOT_RESOLVED');
  return { state: 'NOT_APPLICABLE', ruleId: null, amount: null, vatTreatment: 'UNKNOWN', vatAmount: null, totalAmount: null, reasonCode: 'NO_MATCHING_RULE' };
}

export function resolveSupplierBillingFee(input: {
  supplierId: string;
  productType: string;
  fuel?: string;
  termMonths: number;
  monthlyRent: number;
}): CommissionResolution {
  const { supplierId, productType, termMonths, monthlyRent } = input;
  if (KAKAO_COMMISSION_POLICY.exceptionSupplierIds.sonokong.includes(supplierId as 'RP012') && /구독/.test(productType)) {
    return coordination('SONOKONG_SUBSCRIPTION_BILLING_12_MONTH_RENT_PLUS_FIXED', 'EXCLUDED');
  }
  if (KAKAO_COMMISSION_POLICY.exceptionSupplierIds.star.includes(supplierId as 'RP018') && /렌트/.test(productType)) {
    return coordination('STAR_RERENT_ONE_MONTH_RENT_BILLING', 'INCLUDED');
  }
  if (KAKAO_COMMISSION_POLICY.exceptionSupplierIds.autoplus.includes(supplierId as 'RP023') && /구독/.test(productType)) {
    return calculatedCommission('AUTOPLUS_SUBSCRIPTION_BILLING_FIXED', 1000000, 'EXCLUDED');
  }
  if (KAKAO_COMMISSION_POLICY.exceptionSupplierIds.switchplan.includes(supplierId as 'RP014') && /구독/.test(productType)) {
    return resolveTermLadder(termMonths, monthlyRent, 'BILLING', 'SWITCH_SUBSCRIPTION');
  }
  if (KAKAO_COMMISSION_POLICY.exceptionSupplierIds.iancar.includes(supplierId as 'RP004')) {
    if (/전기/.test(input.fuel ?? '')) return calculatedCommission('IANCAR_EV_BILLING_FIXED', 1000000, 'EXCLUDED');
    if (/렌트/.test(productType) && termMonths === 6) return calculatedCommission('IANCAR_RERENT_6_MONTH_BILLING_FIXED', 400000, 'EXCLUDED');
    if (/렌트/.test(productType) && termMonths === 1) return coordination('IANCAR_RERENT_1_MONTH_BILLING', 'EXCLUDED');
  }
  if (KAKAO_COMMISSION_POLICY.exceptionSupplierIds.pacific.includes(supplierId as 'RP022') && /신차/.test(productType)) {
    return coordination('PACIFIC_NEW_PREDELIVERY_BILLING_DEPOSIT_TIER', 'INCLUDED');
  }
  if (!standardLadderSupplier(supplierId)) return unknownCommission('SUPPLIER_RULE_NOT_IN_F04_CANONICAL_TABLE');
  if (/중고렌트|재렌트/.test(productType)) return resolveTermLadder(termMonths, monthlyRent, 'BILLING');
  if (/신차/.test(productType)) return unknownCommission('NEW_PRODUCT_SUBTYPE_OR_VEHICLE_VALUE_NOT_RESOLVED');
  return { state: 'NOT_APPLICABLE', ruleId: null, amount: null, vatTreatment: 'UNKNOWN', vatAmount: null, totalAmount: null, reasonCode: 'NO_MATCHING_RULE' };
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
