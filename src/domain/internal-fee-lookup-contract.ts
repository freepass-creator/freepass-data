import type { Money, OfferTermEconomics, PriceTerm, TermEconomicAmount } from './catalog.js';

/**
 * 내부 수수료 조회 계약 v1.
 * 저장된 Offer.internalEconomicsTerms 값을 계산 없이 읽되, 출력 행은 Offer.priceTerms와 1:1로 맞춘다.
 * 내부 어드민 정산과 카카오 PC 조회 전용이며 공개 응답에는 노출하지 않는다.
 */
export const INTERNAL_FEE_LOOKUP_CONTRACT_VERSION = 'internal-fee-lookup/v1' as const;

/** 확정: 금액이 정해진 KNOWN, 무료 ZERO, 해당 없음 NOT_APPLICABLE. 미확정 UNKNOWN은 reasonCode가 필요하다. */
export type InternalFeeStatus = 'CONFIRMED' | 'UNCONFIRMED';

export type InternalFeeAmount = {
  status: InternalFeeStatus;
  /** 원문 상태 그대로: KNOWN/ZERO/UNKNOWN/NOT_APPLICABLE. 0과 모름을 섞지 않는다. */
  state: TermEconomicAmount['state'];
  amount: Money | null;
  vatTreatment: TermEconomicAmount['vatTreatment'] | null;
  vatAmount: number | null;
  totalAmount: number | null;
  /** 미확정 이유. 확정이면 null. */
  reasonCode: string | null;
  /** 근거: 수수료 규칙 정본, F04 수수료표, 가격 근거 등. */
  ruleId: string | null;
  policyId: string | null;
  sourceRefs: string[];
};

/** 가격행 기준 기간별 청구(공급사에게 받는 것)와 지급(영업채널에 주는 것) 수수료. */
export type InternalFeeLookupTerm = {
  termKey: string;
  termMonths: number;
  supplierBillingFee: InternalFeeAmount;
  channelPayoutFee: InternalFeeAmount;
};

export type InternalFeeLookup = {
  contract: typeof INTERNAL_FEE_LOOKUP_CONTRACT_VERSION;
  offerId: string;
  terms: InternalFeeLookupTerm[];
  orphanTermKeys: string[];
};

export type InternalFeeLookupPriceTerm = Pick<PriceTerm, 'termKey' | 'termMonths'>;

const toAmount = (fee: TermEconomicAmount): InternalFeeAmount => {
  const confirmed = fee.state === 'KNOWN' || fee.state === 'ZERO' || fee.state === 'NOT_APPLICABLE';
  const reasonCode = fee.reasonCode?.trim() || 'REASON_NOT_RECORDED';
  return {
    status: confirmed ? 'CONFIRMED' : 'UNCONFIRMED',
    state: fee.state,
    amount: fee.amount ?? null,
    vatTreatment: fee.vatTreatment ?? null,
    vatAmount: fee.vatAmount ?? null,
    totalAmount: fee.totalAmount ?? null,
    reasonCode: confirmed ? null : reasonCode,
    ruleId: fee.ruleId ?? null,
    policyId: fee.policyId ?? null,
    sourceRefs: [...fee.sourceRefs],
  };
};

const unresolvedAmount = (reasonCode: string): InternalFeeAmount => ({
  status: 'UNCONFIRMED',
  state: 'UNKNOWN',
  amount: null,
  vatTreatment: null,
  vatAmount: null,
  totalAmount: null,
  reasonCode,
  ruleId: null,
  policyId: null,
  sourceRefs: [],
});

const unresolvedTerm = (priceTerm: InternalFeeLookupPriceTerm, reasonCode: string): InternalFeeLookupTerm => ({
  termKey: priceTerm.termKey,
  termMonths: priceTerm.termMonths,
  supplierBillingFee: unresolvedAmount(reasonCode),
  channelPayoutFee: unresolvedAmount(reasonCode),
});

/** 가격행 기준 1:1 조회 모양으로 바꾼다. 수수료 계산은 하지 않고 저장값만 읽는다. */
export function toInternalFeeLookup(
  offerId: string,
  priceTerms: readonly InternalFeeLookupPriceTerm[],
  terms: readonly OfferTermEconomics[] | undefined,
): InternalFeeLookup {
  const priceTermKeyCounts = new Map<string, number>();
  for (const term of priceTerms) {
    priceTermKeyCounts.set(term.termKey, (priceTermKeyCounts.get(term.termKey) ?? 0) + 1);
  }
  const duplicatePriceTermKeys = new Set(
    [...priceTermKeyCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([termKey]) => termKey)
  );
  const priceTermKeys = new Set(priceTerms.map((term) => term.termKey));
  const economicsByTermKey = new Map<string, OfferTermEconomics>();
  const duplicateTermKeys = new Set<string>();

  for (const term of terms ?? []) {
    if (!priceTermKeys.has(term.termKey)) {
      continue;
    }
    if (economicsByTermKey.has(term.termKey)) {
      duplicateTermKeys.add(term.termKey);
      continue;
    }
    economicsByTermKey.set(term.termKey, term);
  }

  const orphanTermKeys = [...new Set((terms ?? [])
    .map((term) => term.termKey)
    .filter((termKey) => !priceTermKeys.has(termKey)))];

  return {
    contract: INTERNAL_FEE_LOOKUP_CONTRACT_VERSION,
    offerId,
    terms: priceTerms.map((priceTerm) => {
      if (duplicatePriceTermKeys.has(priceTerm.termKey)) {
        return unresolvedTerm(priceTerm, 'DUPLICATE_PRICE_TERM_KEY');
      }
      if (duplicateTermKeys.has(priceTerm.termKey)) {
        return unresolvedTerm(priceTerm, 'DUPLICATE_TERM_KEY');
      }
      const term = economicsByTermKey.get(priceTerm.termKey);
      if (!term) {
        return unresolvedTerm(priceTerm, 'NO_EVIDENCE');
      }
      if (term.termMonths !== undefined && term.termMonths !== priceTerm.termMonths) {
        return unresolvedTerm(priceTerm, 'TERM_MONTHS_MISMATCH');
      }
      return {
        termKey: priceTerm.termKey,
        termMonths: priceTerm.termMonths,
        supplierBillingFee: toAmount(term.supplierBillingFee),
        channelPayoutFee: toAmount(term.channelPayoutFee),
      };
    }),
    orphanTermKeys,
  };
}
