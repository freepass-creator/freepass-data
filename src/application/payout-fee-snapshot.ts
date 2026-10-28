import { buildKakaoCatalogReferenceProduct, explicitNewProductSubtypeFromSource, KAKAO_COMMISSION_POLICY, type CommissionEvidenceByTerm } from './kakao-catalog-reference.js';
import { precomputeOfferEconomics } from './resolve-offer-commercial-terms.js';
import type { CommercialType } from '../domain/catalog.js';
import { stableDigest } from '../shared/stable-digest.js';
import { legacyProductMileageKm } from '../adapters/legacy-normalizer.js';

type Rec = Record<string, unknown>;
import type { PayoutFeeSnapshotDocument, PayoutFeeSnapshotTerm, PayoutFeeState } from '../ports/payout-fee-snapshot-store.js';
export type { PayoutFeeSnapshotDocument, PayoutFeeSnapshotTerm, PayoutFeeState };

export type PayoutFeeEvidence = {
  productId?: string;
  plate?: string;
  confidence: 'high' | 'medium' | 'low';
  vehicleValue?: number;
  priceSource?: string;
  evidenceUrl?: string;
  newProductSubtype?: 'NEW_PREDELIVERY' | 'NEW_MATCHING';
  depositPayment?: 'PREPAID' | 'INSTALLMENT';
  extraDeposit?: number;
  contractDate?: string;
  depositTierPercent?: 5 | 10;
};

type StateCounts = Record<PayoutFeeState, number>;
export type PayoutFeeSnapshotPlan = {
  schema: 'product-payout-fee-snapshot-plan/v1';
  snapshotDate: string;
  documents: PayoutFeeSnapshotDocument[];
  supplierCounts: Record<string, StateCounts>;
  evidenceAppliedCounts: { vehicleValue: number; subtype: number; mewcar: number };
  inferredCounts: Record<string, { productType: number; subtype: number }>;
  nonstandardTermRuleCounts: Record<string, number>;
  payoutExceedsBillingCounts: Record<string, number>;
  planDigest: string;
};

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const plateOf = (product: Rec) => text(product.car_number) ?? text(product.plate) ?? text(product.vehicle_number);
const emptyCounts = (): StateCounts => ({ KNOWN: 0, ZERO: 0, UNKNOWN: 0, NOT_APPLICABLE: 0 });
const commercialType = (value: unknown, supplierId?: string): CommercialType | undefined =>
  text(value) === '오플구독' && supplierId !== 'RP023' ? undefined : ({
  '신차렌트': 'NEW_RENT', '중고렌트': 'USED_RENT', '재렌트': 'USED_RENT',
  '신차구독': 'NEW_SUBSCRIPTION', '중고구독': 'USED_SUBSCRIPTION', '구독': 'USED_SUBSCRIPTION',
  '오공구독': 'OGONG_SUBSCRIPTION', '픽업구독': 'PICKUP_SUBSCRIPTION',
  // 오토플러스(RP023) 구독만. 수수료는 공급사 규칙(F04 123행 구독 정액 · 161행 전기 구독)이 «구독»이면 기간 무관으로 정한다.
  // 다른 공급사에 붙은 «오플구독»은 중고구독 일반 규칙으로 새지 않게 상품구분 미정(PRODUCT_TYPE_REQUIRED)으로 둔다.
  '오플구독': 'USED_SUBSCRIPTION',
} as Record<string, CommercialType>)[text(value) ?? ''];

function exactEvidence(productId: string, product: Rec, evidence: readonly PayoutFeeEvidence[]) {
  const plate = plateOf(product);
  const matches = evidence.filter(item => item.confidence !== 'low' &&
    (item.productId === productId || (!!plate && item.plate === plate)));
  return matches.length === 1 ? matches[0]! : null;
}

function evidenceByPriceKey(product: Rec, evidence: PayoutFeeEvidence | null): CommissionEvidenceByTerm {
  if (!evidence) return {};
  const price = product.price && typeof product.price === 'object' && !Array.isArray(product.price) ? product.price as Rec : {};
  const value = {
    ...(Number.isSafeInteger(evidence.vehicleValue) && evidence.vehicleValue! > 0 ? { vehicleValue: evidence.vehicleValue } : {}),
    ...(evidence.newProductSubtype && commercialType(product.product_type) === 'NEW_RENT' ? { newProductSubtype: evidence.newProductSubtype } : {}),
    ...(evidence.depositPayment ? { depositPayment: evidence.depositPayment } : {}),
    ...(Number.isSafeInteger(evidence.extraDeposit) && evidence.extraDeposit! >= 0 ? { extraDeposit: evidence.extraDeposit } : {}),
    ...(evidence.contractDate ? { contractDate: evidence.contractDate } : {}),
    ...(evidence.depositTierPercent ? { depositTierPercent: evidence.depositTierPercent } : {}),
  };
  return Object.fromEntries(Object.keys(price).map(key => [key, value]));
}

export function planPayoutFeeSnapshots(input: {
  snapshotDate: string;
  products: Record<string, Rec>;
  policies?: Record<string, Rec>;
  evidence?: readonly PayoutFeeEvidence[];
  mewcarPrepaidDefault?: boolean;
  inferProductTypeByMileage?: boolean;
  stockNewAsPredelivery?: boolean;
}): PayoutFeeSnapshotPlan {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.snapshotDate)) throw new Error('PAYOUT_SNAPSHOT_DATE_INVALID');
  const evidence = input.evidence ?? [];
  const evidenceAppliedCounts = { vehicleValue: 0, subtype: 0, mewcar: 0 };
  const nonstandardTermRuleCounts: Record<string, number> = {};
  const payoutExceedsBillingCounts: Record<string, number> = {};
  const inferredCounts: Record<string, { productType: number; subtype: number }> = {};
  const drafts: Omit<PayoutFeeSnapshotDocument, 'planDigest'>[] = [];
  for (const [productId, product] of Object.entries(input.products).sort(([a], [b]) => a.localeCompare(b, 'en-US'))) {
    const supplierId = text(product.provider_company_code) ?? text(product.supplierId) ?? 'UNKNOWN';
    const mileageKm = input.inferProductTypeByMileage && !text(product.product_type) ? legacyProductMileageKm(product) : undefined;
    const inferredProductType = mileageKm === undefined ? null : mileageKm > 1000 ? '재렌트' : '신차렌트';
    // 원천 문서는 바꾸지 않고 이번 계산에 넘길 복사본만 보완한다.
    const effectiveProduct = inferredProductType ? { ...product, product_type: inferredProductType } : product;
    const explicit = exactEvidence(productId, product, evidence);
    const matched = explicit ?? (input.mewcarPrepaidDefault && supplierId === KAKAO_COMMISSION_POLICY.mewcar.supplierId
      ? { productId, confidence: 'high' as const, depositPayment: 'PREPAID' as const, extraDeposit: 0 }
      : null);
    const explicitSubtype = explicitNewProductSubtypeFromSource(effectiveProduct) ?? matched?.newProductSubtype;
    const inferredSubtype = input.stockNewAsPredelivery && commercialType(effectiveProduct.product_type) === 'NEW_RENT'
      && !!plateOf(effectiveProduct) && !explicitSubtype ? 'NEW_PREDELIVERY' as const : null;
    const rawEvidence = evidenceByPriceKey(effectiveProduct, inferredSubtype
      ? { ...(matched ?? { productId, confidence: 'high' as const }), newProductSubtype: inferredSubtype }
      : matched);
    if (matched?.vehicleValue && Object.values(rawEvidence).length) evidenceAppliedCounts.vehicleValue++;
    if (matched?.newProductSubtype && commercialType(effectiveProduct.product_type) === 'NEW_RENT' && Object.values(rawEvidence).length) evidenceAppliedCounts.subtype++;
    if (supplierId === KAKAO_COMMISSION_POLICY.mewcar.supplierId && matched?.depositPayment && Object.values(rawEvidence).length) evidenceAppliedCounts.mewcar++;
    const projected = buildKakaoCatalogReferenceProduct(productId, effectiveProduct, rawEvidence, input.policies ?? {}, undefined, 'COLLECTED');
    const projectedTerms = projected?.offers.flatMap(offer => offer.priceTerms) ?? [];
    const offer = { id: `payout-snapshot:${productId}`, supplierId, priceTerms: projectedTerms.map(term => ({
      termKey: term.termKey, termMonths: term.termMonths, monthlyRent: term.monthlyRent, deposit: term.deposit,
      depositState: term.depositState, mileageLimitKmPerYear: term.mileageLimitKmPerYear,
    })) };
    const engineEvidence = Object.fromEntries(Object.entries(rawEvidence).map(([key, value]) => [`source:${key}`, value]));
    const economics = new Map(precomputeOfferEconomics(offer, commercialType(effectiveProduct.product_type, supplierId), text(effectiveProduct.fuel_type), engineEvidence)
      .map(term => [term.termKey, supplierId === 'RP031' && (term.termMonths ?? Number.POSITIVE_INFINITY) < 12 && (inferredProductType || inferredSubtype)
        ? { ...term.channelPayoutFee, state: 'UNKNOWN' as const, amount: null, calculation: null, sourceRefs: [],
          vatAmount: null, totalAmount: null, reasonCode: 'IANCAR_SHORT_TERM_BASIS_REQUIRED' }
        : term.channelPayoutFee]));
    const terms: PayoutFeeSnapshotTerm[] = (projected?.offers ?? []).flatMap(offer => offer.priceTerms.map(term => {
      const fee = economics.get(term.termKey)!;
      const sourceKey = term.termKey.startsWith('source:') ? term.termKey.slice(7) : term.termKey;
      const rawPrice = product.price && typeof product.price === 'object' && !Array.isArray(product.price)
        ? (product.price as Rec)[sourceKey] as Rec | undefined : undefined;
      const deposit = rawPrice && typeof rawPrice === 'object' ? rawPrice.deposit : null;
      const evidenceRefs = [...new Set([
        ...(Array.isArray(fee.sourceRefs) ? fee.sourceRefs : []),
        ...(inferredProductType ? ['INFERRED_PRODUCT_TYPE_BY_MILEAGE'] : []),
        ...(inferredSubtype ? ['INFERRED_SUBTYPE_STOCK_NEW_PREDELIVERY'] : []),
        ...(matched?.priceSource ? [`price-source:${matched.priceSource}`] : []),
        ...(matched?.evidenceUrl ? [`evidence-url:${matched.evidenceUrl}`] : []),
      ])].sort();
      if (evidenceRefs.some(ref => ref.startsWith('NONSTANDARD_TERM_NEAREST_SHORTER_STANDARD('))) {
        nonstandardTermRuleCounts[supplierId] = (nonstandardTermRuleCounts[supplierId] ?? 0) + 1;
      }
      if (fee.reasonCode === 'PAYOUT_EXCEEDS_BILLING') {
        payoutExceedsBillingCounts[supplierId] = (payoutExceedsBillingCounts[supplierId] ?? 0) + 1;
      }
      if (inferredProductType || inferredSubtype) {
        inferredCounts[supplierId] ??= { productType: 0, subtype: 0 };
        if (inferredProductType) inferredCounts[supplierId]!.productType++;
        if (inferredSubtype) inferredCounts[supplierId]!.subtype++;
      }
      return {
        productId, supplierId, termKey: term.termKey, termMonths: term.termMonths,
        state: fee.state, amount: Number.isSafeInteger(fee.amount?.amount) ? fee.amount!.amount : null,
        vatAmount: typeof fee.vatAmount === 'number' && Number.isSafeInteger(fee.vatAmount) ? fee.vatAmount : null,
        totalAmount: typeof fee.totalAmount === 'number' && Number.isSafeInteger(fee.totalAmount) ? fee.totalAmount : null,
        ruleId: text(fee.ruleId), policyId: KAKAO_COMMISSION_POLICY.policyId,
        reasonCode: text(fee.reasonCode), evidenceRefs,
        computedFrom: {
          rent: { amount: Number.isSafeInteger(term.monthlyRent.amount) ? term.monthlyRent.amount : null, currency: 'KRW' as const, sourceRef: `products/${productId}/price/${sourceKey}/rent` },
          deposit: { state: term.depositState, amount: Number.isSafeInteger(deposit) ? deposit as number : null, currency: 'KRW' as const, sourceRef: `products/${productId}/price/${sourceKey}/deposit` },
        },
      };
    })).sort((a, b) => a.termKey.localeCompare(b.termKey, 'en-US'));
    if (!terms.length) continue;
    const base = { schema: 'product-payout-fee-snapshot/v1' as const, snapshotDate: input.snapshotDate, productId, supplierId,
      listable: product.listable === true, policyId: KAKAO_COMMISSION_POLICY.policyId, terms };
    drafts.push({ ...base, contentDigest: stableDigest(base) });
  }
  const digestInput = drafts.map(document => ({ documentId: `${input.snapshotDate}__${document.productId}`, contentDigest: document.contentDigest }));
  const planDigest = stableDigest({ snapshotDate: input.snapshotDate, documents: digestInput });
  const documents = drafts.map(document => ({ ...document, planDigest }));
  const supplierCounts: Record<string, StateCounts> = {};
  for (const document of documents) for (const term of document.terms) {
    supplierCounts[document.supplierId] ??= emptyCounts();
    supplierCounts[document.supplierId]![term.state]++;
  }
  return { schema: 'product-payout-fee-snapshot-plan/v1', snapshotDate: input.snapshotDate, documents,
    supplierCounts: Object.fromEntries(Object.entries(supplierCounts).sort(([a], [b]) => a.localeCompare(b, 'en-US'))),
    evidenceAppliedCounts,
    inferredCounts: Object.fromEntries(Object.entries(inferredCounts).sort(([a], [b]) => a.localeCompare(b, 'en-US'))),
    nonstandardTermRuleCounts: Object.fromEntries(Object.entries(nonstandardTermRuleCounts).sort(([a], [b]) => a.localeCompare(b, 'en-US'))),
    payoutExceedsBillingCounts: Object.fromEntries(Object.entries(payoutExceedsBillingCounts).sort(([a], [b]) => a.localeCompare(b, 'en-US'))),
    planDigest };
}
