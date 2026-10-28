import { buildKakaoCatalogReferenceProduct, KAKAO_COMMISSION_POLICY, type CommissionEvidenceByTerm } from './kakao-catalog-reference.js';
import { precomputeOfferEconomics } from './resolve-offer-commercial-terms.js';
import type { CommercialType } from '../domain/catalog.js';
import { stableDigest } from '../shared/stable-digest.js';

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
  nonstandardTermRuleCounts: Record<string, number>;
  planDigest: string;
};

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
const plateOf = (product: Rec) => text(product.car_number) ?? text(product.plate) ?? text(product.vehicle_number);
const emptyCounts = (): StateCounts => ({ KNOWN: 0, ZERO: 0, UNKNOWN: 0, NOT_APPLICABLE: 0 });
const commercialType = (value: unknown): CommercialType | undefined => ({
  '신차렌트': 'NEW_RENT', '중고렌트': 'USED_RENT', '재렌트': 'USED_RENT',
  '신차구독': 'NEW_SUBSCRIPTION', '중고구독': 'USED_SUBSCRIPTION', '구독': 'USED_SUBSCRIPTION',
  '오공구독': 'OGONG_SUBSCRIPTION', '픽업구독': 'PICKUP_SUBSCRIPTION',
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
}): PayoutFeeSnapshotPlan {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.snapshotDate)) throw new Error('PAYOUT_SNAPSHOT_DATE_INVALID');
  const evidence = input.evidence ?? [];
  const evidenceAppliedCounts = { vehicleValue: 0, subtype: 0, mewcar: 0 };
  const nonstandardTermRuleCounts: Record<string, number> = {};
  const drafts: Omit<PayoutFeeSnapshotDocument, 'planDigest'>[] = [];
  for (const [productId, product] of Object.entries(input.products).sort(([a], [b]) => a.localeCompare(b, 'en-US'))) {
    const supplierId = text(product.provider_company_code) ?? text(product.supplierId) ?? 'UNKNOWN';
    const explicit = exactEvidence(productId, product, evidence);
    const matched = explicit ?? (input.mewcarPrepaidDefault && supplierId === KAKAO_COMMISSION_POLICY.mewcar.supplierId
      ? { productId, confidence: 'high' as const, depositPayment: 'PREPAID' as const, extraDeposit: 0 }
      : null);
    const rawEvidence = evidenceByPriceKey(product, matched);
    if (matched?.vehicleValue && Object.values(rawEvidence).length) evidenceAppliedCounts.vehicleValue++;
    if (matched?.newProductSubtype && commercialType(product.product_type) === 'NEW_RENT' && Object.values(rawEvidence).length) evidenceAppliedCounts.subtype++;
    if (supplierId === KAKAO_COMMISSION_POLICY.mewcar.supplierId && matched?.depositPayment && Object.values(rawEvidence).length) evidenceAppliedCounts.mewcar++;
    const projected = buildKakaoCatalogReferenceProduct(productId, product, rawEvidence, input.policies ?? {}, undefined, 'COLLECTED');
    const projectedTerms = projected?.offers.flatMap(offer => offer.priceTerms) ?? [];
    const offer = { id: `payout-snapshot:${productId}`, supplierId, priceTerms: projectedTerms.map(term => ({
      termKey: term.termKey, termMonths: term.termMonths, monthlyRent: term.monthlyRent, deposit: term.deposit,
      depositState: term.depositState, mileageLimitKmPerYear: term.mileageLimitKmPerYear,
    })) };
    const engineEvidence = Object.fromEntries(Object.entries(rawEvidence).map(([key, value]) => [`source:${key}`, value]));
    const economics = new Map(precomputeOfferEconomics(offer, commercialType(product.product_type), text(product.fuel_type), engineEvidence)
      .map(term => [term.termKey, term.channelPayoutFee]));
    const terms: PayoutFeeSnapshotTerm[] = (projected?.offers ?? []).flatMap(offer => offer.priceTerms.map(term => {
      const fee = economics.get(term.termKey)!;
      const sourceKey = term.termKey.startsWith('source:') ? term.termKey.slice(7) : term.termKey;
      const rawPrice = product.price && typeof product.price === 'object' && !Array.isArray(product.price)
        ? (product.price as Rec)[sourceKey] as Rec | undefined : undefined;
      const deposit = rawPrice && typeof rawPrice === 'object' ? rawPrice.deposit : null;
      const evidenceRefs = [...new Set([
        ...(Array.isArray(fee.sourceRefs) ? fee.sourceRefs : []),
        ...(matched?.priceSource ? [`price-source:${matched.priceSource}`] : []),
        ...(matched?.evidenceUrl ? [`evidence-url:${matched.evidenceUrl}`] : []),
      ])].sort();
      if (evidenceRefs.some(ref => ref.startsWith('NONSTANDARD_TERM_NEAREST_SHORTER_STANDARD('))) {
        nonstandardTermRuleCounts[supplierId] = (nonstandardTermRuleCounts[supplierId] ?? 0) + 1;
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
    nonstandardTermRuleCounts: Object.fromEntries(Object.entries(nonstandardTermRuleCounts).sort(([a], [b]) => a.localeCompare(b, 'en-US'))),
    planDigest };
}
