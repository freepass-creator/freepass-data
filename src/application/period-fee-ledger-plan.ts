import { buildKakaoCatalogReferenceProduct, KAKAO_COMMISSION_POLICY } from './kakao-catalog-reference.js';
import { evidenceByTermForProduct, type NewCarTrimEvidenceInput, type VehicleValueEvidence } from './vehicle-value-evidence.js';
import { stableDigest } from '../shared/stable-digest.js';
import type {
  PeriodFeeDepositEvidenceKind,
  PeriodFeeDepositState,
  PeriodFeeLedgerDepositEvidence,
  PeriodFeeLedgerFeeAmount,
  PeriodFeeLedgerFeeState,
  PeriodFeeLedgerRow,
  PeriodFeeVehicleValueEvidence,
  ProductChangeHistoryRow,
} from '../domain/period-fee-ledger.js';

export type { PeriodFeeLedgerRow, ProductChangeHistoryRow } from '../domain/period-fee-ledger.js';

type Rec = Record<string, unknown>;

export type PeriodFeeLedgerPlan = {
  schema: 'freepass-data.period-fee-ledger-plan/v1';
  snapshotId: string;
  observedAt: string;
  rows: PeriodFeeLedgerRow[];
  history: ProductChangeHistoryRow[];
  baselines: {
    productStates: Record<string, Pick<ProductChangeBaseline, 'vehicle_status' | 'status' | 'status_kind' | 'listable' | 'sourceObservationRef'>>;
  };
  summary: {
    totalProducts: number;
    productsWithPriceRows: number;
    rows: number;
    historyRows: number;
    uid: { present: number; missing: number };
    apply: { ready: number; hold: number };
    feeStates: Record<'supplierBillingFee' | 'channelPayoutFee', Record<PeriodFeeLedgerFeeState, number>>;
    approxCount: Record<'supplierBillingFee' | 'channelPayoutFee', number>;
    depositEvidenceKinds: Record<PeriodFeeDepositEvidenceKind, number>;
    reasonCounts: Record<string, number>;
    settlementRowsAccessCount: 0;
    inputDigest: string;
    publicReport: {
      snapshotId: string;
      rows: number;
      historyRows: number;
      uidMissing: number;
      planDigest: string;
    };
  };
  planDigest: string;
};

export type PeriodFeePreviousSnapshot = {
  rows: readonly Pick<PeriodFeeLedgerRow, 'productId' | 'termKey' | 'monthlyRent' | 'deposit' | 'sourceDigest'>[];
  productStates: Record<string, Pick<ProductChangeBaseline, 'vehicle_status' | 'status' | 'status_kind' | 'listable' | 'sourceObservationRef'>>;
};

type ProductChangeBaseline = {
  productKey: string;
  vehicle_status: unknown;
  status: unknown;
  status_kind: unknown;
  listable: unknown;
  sourceObservationRef: string | null;
};

export type PlanPeriodFeeLedgerInput = {
  products: Record<string, Rec>;
  policies?: Record<string, Rec>;
  newCarTrim?: NewCarTrimEvidenceInput;
  referenceInputs?: Rec;
  previousSnapshot?: PeriodFeePreviousSnapshot | null;
};

export type PlanPeriodFeeLedgerOptions = {
  clock?: () => Date;
};

const ENGINE_REVISION = `kakao-reference:${KAKAO_COMMISSION_POLICY.policyId}`;

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
const pathSafe = (value: string) => value.replace(/[\/#?[\]*]/g, '_').slice(0, 180);
const sourceObservationId = (docKey: string) => `source_observation_${stableDigest({ docKey }).slice(0, 24)}`;
const ruleCalculationBasis: Record<string, string> = {
  SOURCE_AMOUNT: '원천 금액',
  RENT_X_2: '월 대여료×2',
  RENT_X_CONTRACT_YEARS_MAX3: '월 대여료×약정연수(최대 3개월)',
  IMPORT_12_X3_18_PLUS_X6: '12개월 월 대여료×3 / 18개월 이상 월 대여료×6',
  ZERO_DEPOSIT: '무보증 문구 근거',
};
const calculationBasis = (code: string) => ruleCalculationBasis[code] ?? null;
const snapshotDate = (snapshotId: string) => {
  const match = /^period-fee-(\d{4}-\d{2}-\d{2})$/.exec(snapshotId);
  if (!match) throw new Error('PERIOD_FEE_SNAPSHOT_ID_INVALID');
  return match[1]!;
};
const kstDate = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new Error('PERIOD_FEE_OBSERVED_AT_INVALID');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) throw new Error('PERIOD_FEE_OBSERVED_AT_INVALID');
  return `${year}-${month}-${day}`;
};
const nowFromClock = (clock: (() => Date) | undefined) => {
  const now = clock ? clock() : new Date();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error('PERIOD_FEE_CLOCK_INVALID');
  return now.toISOString();
};

export const periodFeeSnapshotIdFromObservedAt = (observedAt: string) => `period-fee-${kstDate(observedAt)}`;

function sourcePriceKey(termKey: string): string {
  return termKey.startsWith('source:') ? termKey.slice('source:'.length) : termKey;
}

export function normalizeLedgerDepositEvidence(input: {
  state: PeriodFeeDepositState;
  amount: { amount: number; currency: 'KRW' } | null;
  term: Rec;
  rawProduct: Rec;
  sourcePriceKey: string;
}): { state: PeriodFeeDepositState; reasonCode: string | null; evidence: PeriodFeeLedgerDepositEvidence } {
  const termEvidence = input.term.depositEvidence && typeof input.term.depositEvidence === 'object' && !Array.isArray(input.term.depositEvidence)
    ? input.term.depositEvidence as Rec : {};
  const rule = input.term.depositRule && typeof input.term.depositRule === 'object' && !Array.isArray(input.term.depositRule)
    ? input.term.depositRule as Rec : {};
  const basis = rule.depositEvidenceBasis && typeof rule.depositEvidenceBasis === 'object' && !Array.isArray(rule.depositEvidenceBasis)
    ? rule.depositEvidenceBasis as Rec : {};
  const ruleCode = text(rule.code) ?? (text(termEvidence.reasonCode)?.startsWith('SUPPLIER_RULE_NOTE:')
    ? text(termEvidence.reasonCode)!.slice('SUPPLIER_RULE_NOTE:'.length) : text(termEvidence.reasonCode));
  const policyCode = text(input.rawProduct.policy_code);
  const noteText = text(termEvidence.sourceNote) ?? text(basis.text);
  const noteField = noteText ? 'deposit_note' : text(basis.field);
  const base = {
    ruleCode,
    noteField,
    noteText,
    sourcePriceKey: input.sourcePriceKey,
    calculationBasis: ruleCode ? ruleCalculationBasis[ruleCode] ?? text(rule.label) : null,
    policyCode,
  };
  const reasonCode = text(termEvidence.reasonCode);
  const sourceAmount = termEvidence.sourceAmount;
  const hasSourceAmount = (typeof sourceAmount === 'number' && Number.isSafeInteger(sourceAmount) && sourceAmount > 0)
    || (typeof sourceAmount === 'string' && /^(?:[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)$/.test(sourceAmount));

  if (input.state === 'KNOWN' && (reasonCode === 'SOURCE_AMOUNT' || ruleCode === 'SOURCE_AMOUNT') && hasSourceAmount) {
    return { state: input.state, reasonCode, evidence: { kind: 'SOURCE_AMOUNT', ...base, ruleCode: 'SOURCE_AMOUNT',
      calculationBasis: calculationBasis('SOURCE_AMOUNT') } };
  }
  if (input.state === 'KNOWN' && ruleCode && ruleCode !== 'SOURCE_AMOUNT' && noteText) {
    return { state: input.state, reasonCode, evidence: { kind: 'SUPPLIER_RULE_NOTE', ...base,
      calculationBasis: base.calculationBasis ?? ruleCalculationBasis[ruleCode] ?? null } };
  }
  if (input.state === 'ZERO' && (ruleCode === 'ZERO_DEPOSIT' || reasonCode === 'EXPLICIT_ZERO_DEPOSIT') && (noteText || text(basis.text))) {
    return { state: input.state, reasonCode, evidence: { kind: 'VERIFIED_ZERO_TEXT', ...base, ruleCode: ruleCode ?? 'ZERO_DEPOSIT',
      noteText: noteText ?? text(basis.text) ?? null, calculationBasis: calculationBasis('ZERO_DEPOSIT') } };
  }
  if (input.state === 'KNOWN') {
    return { state: 'UNKNOWN', reasonCode: 'DEPOSIT_POLICY_EVIDENCE_REQUIRED',
      evidence: { kind: 'UNKNOWN', ...base, ruleCode: ruleCode ?? null, calculationBasis: null } };
  }
  return { state: input.state, reasonCode, evidence: { kind: 'UNKNOWN', ...base, ruleCode: ruleCode ?? null,
    calculationBasis: null } };
}

function normalizeFee(value: Rec | undefined, vehicleValueEvidence: PeriodFeeVehicleValueEvidence | null): PeriodFeeLedgerFeeAmount {
  const calculatedState = vehicleValueEvidence?.grade === 'APPROX' ? 'CALCULATED_APPROX' : 'CALCULATED';
  const state = value?.state === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : value?.state === 'CALCULATED' ? calculatedState : 'UNKNOWN';
  const rawAmount = value?.amount;
  const rawVatAmount = value?.vatAmount;
  const rawTotalAmount = value?.totalAmount;
  const amount = (state === 'CALCULATED' || state === 'CALCULATED_APPROX') && Number.isSafeInteger(rawAmount)
    ? { amount: rawAmount as number, currency: 'KRW' as const }
    : null;
  return {
    state,
    amount,
    vatTreatment: value?.vatTreatment === 'EXCLUDED' || value?.vatTreatment === 'INCLUDED' || value?.vatTreatment === 'UNKNOWN' ? value.vatTreatment : null,
    vatAmount: Number.isSafeInteger(rawVatAmount) ? rawVatAmount as number : null,
    totalAmount: Number.isSafeInteger(rawTotalAmount) ? rawTotalAmount as number : null,
    reasonCode: text(value?.reasonCode),
    ruleId: text(value?.ruleId),
    policyId: text(value?.policyId) ?? KAKAO_COMMISSION_POLICY.policyId,
    sourceRefs: Array.isArray(value?.sourceRefs) ? value.sourceRefs.filter((ref): ref is string => typeof ref === 'string') : [],
  };
}

function productVehicleUid(product: Rec): string | null {
  return text(product.vehicle_uid) ?? text(product.vehicleUid) ?? text(product.assetId) ?? text(product.vehicleAssetId);
}

function productUpdateTime(product: Rec): string | null {
  const value = product.updateTime ?? product.updatedAt ?? product.updated_at;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function productState(productKey: string, product: Rec): ProductChangeBaseline {
  return {
    productKey,
    vehicle_status: product.vehicle_status ?? null,
    status: product.status ?? null,
    status_kind: product.status_kind ?? null,
    listable: typeof product.listable === 'boolean' ? product.listable : null,
    sourceObservationRef: text(product._sourceObservationRef) ?? `products/${productKey}`,
  };
}

function buildHistory(input: {
  previousSnapshot?: PeriodFeePreviousSnapshot | null;
  baselines: ProductChangeBaseline[];
  rows: PeriodFeeLedgerRow[];
  snapshotId: string;
  changedAtKst: string;
}): ProductChangeHistoryRow[] {
  if (!input.previousSnapshot) return [];
  const history: ProductChangeHistoryRow[] = [];
  const previousStates = input.previousSnapshot.productStates ?? {};
  for (const current of input.baselines) {
    const before = previousStates[current.productKey];
    if (!before) continue;
    for (const field of ['vehicle_status', 'status', 'status_kind', 'listable'] as const) {
      if (stableDigest(before[field]) !== stableDigest(current[field])) {
        history.push({ schemaVersion: 'product-change-history/v1', productKey: current.productKey, kind: 'STATUS',
          fieldPath: field, before: before[field], after: current[field], changedAtKst: input.changedAtKst,
          snapshotId: input.snapshotId, sourceObservationRef: current.sourceObservationRef });
      }
    }
  }
  const previousTerms = new Map(input.previousSnapshot.rows.map(row => [`${row.productId}\0${row.termKey}`, row]));
  for (const row of input.rows) {
    const before = previousTerms.get(`${row.productId}\0${row.termKey}`);
    if (!before) continue;
    if (stableDigest(before.monthlyRent) !== stableDigest(row.monthlyRent)) {
      history.push({ schemaVersion: 'product-change-history/v1', productKey: row.vehicleUid ?? row.productId, kind: 'RENT',
        fieldPath: 'priceTerms.monthlyRent', before: before.monthlyRent, after: row.monthlyRent,
        changedAtKst: input.changedAtKst, snapshotId: input.snapshotId, sourceObservationRef: row.inputRefs.priceTermRef });
    }
    if (stableDigest(before.deposit) !== stableDigest(row.deposit)) {
      history.push({ schemaVersion: 'product-change-history/v1', productKey: row.vehicleUid ?? row.productId, kind: 'DEPOSIT',
        fieldPath: 'priceTerms.deposit', before: before.deposit, after: row.deposit,
        changedAtKst: input.changedAtKst, snapshotId: input.snapshotId, sourceObservationRef: row.inputRefs.priceTermRef });
    }
  }
  return history.sort((a, b) => `${a.productKey}:${a.fieldPath}:${a.sourceObservationRef ?? ''}`.localeCompare(`${b.productKey}:${b.fieldPath}:${b.sourceObservationRef ?? ''}`));
}

export function planPeriodFeeLedger(input: PlanPeriodFeeLedgerInput, options: PlanPeriodFeeLedgerOptions = {}): PeriodFeeLedgerPlan {
  const observedAt = nowFromClock(options.clock);
  const snapshotId = periodFeeSnapshotIdFromObservedAt(observedAt);
  const date = snapshotDate(snapshotId);
  const valueAsOf = kstDate(observedAt);
  const rows: PeriodFeeLedgerRow[] = [];
  const baselines: ProductChangeBaseline[] = [];
  const reasonCounts: Record<string, number> = {};
  const feeStates = {
    supplierBillingFee: { CALCULATED: 0, CALCULATED_APPROX: 0, UNKNOWN: 0, NOT_APPLICABLE: 0 },
    channelPayoutFee: { CALCULATED: 0, CALCULATED_APPROX: 0, UNKNOWN: 0, NOT_APPLICABLE: 0 },
  };
  const depositEvidenceKinds: Record<PeriodFeeDepositEvidenceKind, number> = { SOURCE_AMOUNT: 0, SUPPLIER_RULE_NOTE: 0, VERIFIED_ZERO_TEXT: 0, UNKNOWN: 0 };
  let uidPresent = 0;
  let uidMissing = 0;

  for (const [docKey, rawProduct] of Object.entries(input.products).sort(([a], [b]) => a.localeCompare(b))) {
    const product = { ...rawProduct, listable: true };
    const { evidenceByTerm, vehicleValueEvidence } = evidenceByTermForProduct(product, input.newCarTrim);
    const projected = buildKakaoCatalogReferenceProduct(docKey, product, evidenceByTerm, input.policies ?? {}, observedAt, 'COLLECTED');
    const priceTerms = projected?.offers.flatMap(offer => offer.priceTerms.map(term => ({ offer, term }))) ?? [];
    if (!priceTerms.length) continue;

    const vehicleUid = productVehicleUid(product);
    if (vehicleUid) uidPresent += 1; else uidMissing += 1;
    const productKey = vehicleUid ?? sourceObservationId(docKey);
    baselines.push(productState(productKey, rawProduct));
    const supplierId = text(rawProduct.provider_company_code) ?? 'UNKNOWN_SUPPLIER';
    const sourceDigest = stableDigest(rawProduct);
    const productId = `reference_${docKey}`;
    const offerId = `reference_offer_${docKey}`;
    const productPath = `products/${docKey}`;

    for (const { term } of priceTerms) {
      const billing = normalizeFee(term.supplierBillingFee as Rec | undefined, vehicleValueEvidence);
      const payout = normalizeFee(term.channelPayoutFee as Rec | undefined, vehicleValueEvidence);
      feeStates.supplierBillingFee[billing.state] += 1;
      feeStates.channelPayoutFee[payout.state] += 1;
      for (const reason of [billing.reasonCode, payout.reasonCode, !vehicleUid ? 'HOLD_NO_UID' : null].filter((v): v is string => !!v)) {
        reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
      }
      const documentKey = vehicleUid
        ? [snapshotId, vehicleUid, supplierId, productId, offerId, term.termKey].map(pathSafe).join('__')
        : [snapshotId, productKey, supplierId, productId, offerId, term.termKey].map(pathSafe).join('__');
      const depositState = String(term.depositState);
      const normalizedDepositState: PeriodFeeDepositState = (depositState === 'KNOWN' || depositState === 'ZERO' || depositState === 'NOT_APPLICABLE') ? depositState : 'UNKNOWN';
      const depositAmount = term.deposit ? { amount: term.deposit.amount, currency: 'KRW' as const } : null;
      const depositWithEvidence = normalizeLedgerDepositEvidence({
        state: normalizedDepositState,
        amount: depositAmount,
        term: term as Rec,
        rawProduct,
        sourcePriceKey: sourcePriceKey(term.termKey),
      });
      depositEvidenceKinds[depositWithEvidence.evidence.kind] += 1;
      if (depositWithEvidence.reasonCode) reasonCounts[depositWithEvidence.reasonCode] = (reasonCounts[depositWithEvidence.reasonCode] ?? 0) + 1;
      rows.push({
        schemaVersion: 'period-fee-ledger/v1',
        snapshotId,
        snapshotDateKst: date,
        computedAt: observedAt,
        valueBasis: 'CURRENT_AT_SNAPSHOT',
        valueAsOf,
        engineRevision: ENGINE_REVISION,
        sourceDigest,
        documentKey,
        applyState: vehicleUid ? 'READY' : 'HOLD',
        holdReasonCode: vehicleUid ? null : 'HOLD_NO_UID',
        vehicleUid,
        assetId: vehicleUid,
        plateLookupKey: text(rawProduct.car_number) ? stableDigest({ plate: rawProduct.car_number }) : null,
        plateLast4ForReport: null,
        supplierId,
        productId,
        offerId,
        offerRevision: integer(rawProduct.offerRevision) ?? 0,
        productUpdateTime: productUpdateTime(rawProduct),
        termKey: term.termKey,
        termMonths: term.termMonths,
        monthlyRent: { amount: term.monthlyRent.amount, currency: 'KRW', state: 'KNOWN', reasonCode: null },
        deposit: {
          state: depositWithEvidence.state,
          amount: depositWithEvidence.state === 'UNKNOWN' ? null : depositAmount,
          reasonCode: depositWithEvidence.reasonCode,
          sourceRefs: [`source-product:${docKey}#${term.termKey}`],
          depositEvidence: depositWithEvidence.evidence,
        },
        vehicleValueEvidence,
        supplierBillingFee: billing,
        channelPayoutFee: payout,
        ruleIds: [...new Set([billing.ruleId, payout.ruleId].filter((v): v is string => !!v))].sort(),
        policyIds: [...new Set([billing.policyId, payout.policyId].filter((v): v is string => !!v))].sort(),
        priceSourceRefs: [`source-product:${docKey}#${term.termKey}`],
        inputRefs: {
          productPath,
          offerPath: `${productPath}/offers/${offerId}`,
          priceTermRef: `${productPath}/price/${term.termKey}`,
          internalEconomicsRef: null,
        },
      });
    }
  }

  rows.sort((a, b) => a.documentKey.localeCompare(b.documentKey));
  const outputBaselines = {
    productStates: Object.fromEntries([...baselines]
      .sort((a, b) => a.productKey.localeCompare(b.productKey))
      .map(({ productKey, ...state }) => [productKey, state])),
  };
  const history = buildHistory({ previousSnapshot: input.previousSnapshot ?? null, baselines, rows, snapshotId, changedAtKst: date });
  const digestBase = { snapshotId, rows, history, baselines: outputBaselines };
  const planDigest = stableDigest(digestBase);
  const summary = {
    totalProducts: Object.keys(input.products).length,
    productsWithPriceRows: baselines.length,
    rows: rows.length,
    historyRows: history.length,
    uid: { present: uidPresent, missing: uidMissing },
    apply: { ready: rows.filter(row => row.applyState === 'READY').length, hold: rows.filter(row => row.applyState === 'HOLD').length },
    feeStates,
    approxCount: {
      supplierBillingFee: feeStates.supplierBillingFee.CALCULATED_APPROX,
      channelPayoutFee: feeStates.channelPayoutFee.CALCULATED_APPROX,
    },
    depositEvidenceKinds,
    reasonCounts: Object.fromEntries(Object.entries(reasonCounts).sort(([a], [b]) => a.localeCompare(b))),
    settlementRowsAccessCount: 0 as const,
    inputDigest: stableDigest({ products: input.products, policies: input.policies ?? {}, newCarTrim: input.newCarTrim ?? null, referenceInputs: input.referenceInputs ?? null, previousSnapshot: input.previousSnapshot ?? null, observedAt, snapshotId }),
    publicReport: { snapshotId, rows: rows.length, historyRows: history.length, uidMissing, planDigest },
  };
  return { schema: 'freepass-data.period-fee-ledger-plan/v1', snapshotId, observedAt, rows, history, baselines: outputBaselines, summary, planDigest };
}
