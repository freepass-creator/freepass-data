import { buildKakaoCatalogReferenceProduct, KAKAO_COMMISSION_POLICY } from './kakao-catalog-reference.js';
import { stableDigest } from '../shared/stable-digest.js';

type Rec = Record<string, unknown>;

type LedgerFeeState = 'CALCULATED' | 'UNKNOWN' | 'NOT_APPLICABLE';
type DepositState = 'KNOWN' | 'ZERO' | 'UNKNOWN' | 'NOT_APPLICABLE';

type LedgerFeeAmount = {
  state: LedgerFeeState;
  amount: { amount: number; currency: 'KRW' } | null;
  vatTreatment: 'EXCLUDED' | 'INCLUDED' | 'UNKNOWN' | null;
  vatAmount: number | null;
  totalAmount: number | null;
  reasonCode: string | null;
  ruleId: string | null;
  policyId: string | null;
  sourceRefs: string[];
};

export type PeriodFeeLedgerRow = {
  schemaVersion: 'period-fee-ledger/v1';
  snapshotId: string;
  snapshotDateKst: string;
  computedAt: string;
  engineRevision: string;
  sourceDigest: string;
  documentKey: string;
  applyState: 'READY' | 'HOLD';
  holdReasonCode: string | null;
  vehicleUid: string | null;
  assetId: string | null;
  plateLookupKey: string | null;
  plateLast4ForReport: string | null;
  supplierId: string;
  productId: string;
  offerId: string;
  offerRevision: number;
  productUpdateTime: string | null;
  termKey: string;
  termMonths: number;
  monthlyRent: { amount: number; currency: 'KRW'; state: 'KNOWN' | 'UNKNOWN'; reasonCode: string | null };
  deposit: {
    state: DepositState;
    amount: { amount: number; currency: 'KRW' } | null;
    reasonCode: string | null;
    sourceRefs: string[];
  };
  supplierBillingFee: LedgerFeeAmount;
  channelPayoutFee: LedgerFeeAmount;
  ruleIds: string[];
  policyIds: string[];
  priceSourceRefs: string[];
  inputRefs: {
    productPath: string;
    offerPath: string;
    priceTermRef: string;
    internalEconomicsRef: string | null;
  };
};

export type ProductChangeHistoryRow = {
  schemaVersion: 'product-change-history/v1';
  productKey: string;
  kind: 'STATUS' | 'RENT' | 'DEPOSIT';
  fieldPath: 'vehicle_status' | 'status' | 'status_kind' | 'listable' | 'priceTerms.monthlyRent' | 'priceTerms.deposit';
  before: unknown;
  after: unknown;
  changedAtKst: string;
  snapshotId: string;
  sourceObservationRef: string | null;
};

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
    feeStates: Record<'supplierBillingFee' | 'channelPayoutFee', Record<LedgerFeeState, number>>;
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
  referenceInputs?: Rec;
  previousSnapshot?: PeriodFeePreviousSnapshot | null;
  observedAt: string;
  snapshotId: string;
};

const ENGINE_REVISION = `kakao-reference:${KAKAO_COMMISSION_POLICY.policyId}`;

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
const pathSafe = (value: string) => value.replace(/[\/#?[\]*]/g, '_').slice(0, 180);
const sourceObservationId = (docKey: string) => `source_observation_${stableDigest({ docKey }).slice(0, 24)}`;
const snapshotDate = (snapshotId: string) => {
  const match = /^period-fee-(\d{4}-\d{2}-\d{2})$/.exec(snapshotId);
  if (!match) throw new Error('PERIOD_FEE_SNAPSHOT_ID_INVALID');
  return match[1]!;
};

function normalizeFee(value: Rec | undefined): LedgerFeeAmount {
  const state = value?.state === 'NOT_APPLICABLE' ? 'NOT_APPLICABLE' : value?.state === 'CALCULATED' ? 'CALCULATED' : 'UNKNOWN';
  const rawAmount = value?.amount;
  const rawVatAmount = value?.vatAmount;
  const rawTotalAmount = value?.totalAmount;
  const amount = state === 'CALCULATED' && Number.isSafeInteger(rawAmount)
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

export function planPeriodFeeLedger(input: PlanPeriodFeeLedgerInput): PeriodFeeLedgerPlan {
  const date = snapshotDate(input.snapshotId);
  const rows: PeriodFeeLedgerRow[] = [];
  const baselines: ProductChangeBaseline[] = [];
  const reasonCounts: Record<string, number> = {};
  const feeStates = {
    supplierBillingFee: { CALCULATED: 0, UNKNOWN: 0, NOT_APPLICABLE: 0 },
    channelPayoutFee: { CALCULATED: 0, UNKNOWN: 0, NOT_APPLICABLE: 0 },
  };
  let uidPresent = 0;
  let uidMissing = 0;

  for (const [docKey, rawProduct] of Object.entries(input.products).sort(([a], [b]) => a.localeCompare(b))) {
    const product = { ...rawProduct, listable: true };
    const projected = buildKakaoCatalogReferenceProduct(docKey, product, {}, input.policies ?? {}, input.observedAt, 'COLLECTED');
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
      const billing = normalizeFee(term.supplierBillingFee as Rec | undefined);
      const payout = normalizeFee(term.channelPayoutFee as Rec | undefined);
      feeStates.supplierBillingFee[billing.state] += 1;
      feeStates.channelPayoutFee[payout.state] += 1;
      for (const reason of [billing.reasonCode, payout.reasonCode, !vehicleUid ? 'HOLD_NO_UID' : null].filter((v): v is string => !!v)) {
        reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
      }
      const documentKey = vehicleUid
        ? [input.snapshotId, vehicleUid, supplierId, productId, offerId, term.termKey].map(pathSafe).join('__')
        : [input.snapshotId, productKey, supplierId, productId, offerId, term.termKey].map(pathSafe).join('__');
      const depositState = String(term.depositState);
      rows.push({
        schemaVersion: 'period-fee-ledger/v1',
        snapshotId: input.snapshotId,
        snapshotDateKst: date,
        computedAt: input.observedAt,
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
          state: (depositState === 'KNOWN' || depositState === 'ZERO' || depositState === 'NOT_APPLICABLE') ? depositState : 'UNKNOWN',
          amount: term.deposit ? { amount: term.deposit.amount, currency: 'KRW' } : null,
          reasonCode: text((term.depositEvidence as Rec | undefined)?.reasonCode),
          sourceRefs: [`source-product:${docKey}#${term.termKey}`],
        },
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
  const history = buildHistory({ previousSnapshot: input.previousSnapshot ?? null, baselines, rows, snapshotId: input.snapshotId, changedAtKst: date });
  const digestBase = { snapshotId: input.snapshotId, rows, history, baselines: outputBaselines };
  const planDigest = stableDigest(digestBase);
  const summary = {
    totalProducts: Object.keys(input.products).length,
    productsWithPriceRows: baselines.length,
    rows: rows.length,
    historyRows: history.length,
    uid: { present: uidPresent, missing: uidMissing },
    apply: { ready: rows.filter(row => row.applyState === 'READY').length, hold: rows.filter(row => row.applyState === 'HOLD').length },
    feeStates,
    reasonCounts: Object.fromEntries(Object.entries(reasonCounts).sort(([a], [b]) => a.localeCompare(b))),
    settlementRowsAccessCount: 0 as const,
    inputDigest: stableDigest({ products: input.products, policies: input.policies ?? {}, referenceInputs: input.referenceInputs ?? null, previousSnapshot: input.previousSnapshot ?? null, observedAt: input.observedAt, snapshotId: input.snapshotId }),
    publicReport: { snapshotId: input.snapshotId, rows: rows.length, historyRows: history.length, uidMissing, planDigest },
  };
  return { schema: 'freepass-data.period-fee-ledger-plan/v1', snapshotId: input.snapshotId, observedAt: input.observedAt, rows, history, baselines: outputBaselines, summary, planDigest };
}
