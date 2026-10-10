import type { Money, OfferTermEconomics, TermEconomicAmount } from './catalog.js';

/**
 * 내부 수수료 조회 계약 v1 (2026-10-10, 대표: 청구·지급 수수료는 프리패스 데이터에만 있으면 되고 조회는 내부 통로에서만).
 * 기존 Offer.internalEconomicsTerms(OfferTermEconomics)를 그대로 쓴다 — 새 저장 칸을 만들지 않는다.
 * 읽는 곳: 어드민(프리패스 정산)·카톡 PC 조회(프리패스안내.mjs, /catalog-reference·/internal-ai-reference)뿐.
 * ERP5·공개 응답(호환 응답·/catalog)·공통 시트 투영·내보내기에는 내보내지 않는다(호환 응답은 withoutInternalFeeFields 가 막는다).
 */
export const INTERNAL_FEE_LOOKUP_CONTRACT_VERSION = 'internal-fee-lookup/v1' as const;

/** 확정: 금액이 정해짐(KNOWN, 무료 ZERO) · 해당 없음(NOT_APPLICABLE). 미확정: UNKNOWN — 반드시 이유(reasonCode)를 같이 낸다. */
export type InternalFeeStatus = 'CONFIRMED' | 'UNCONFIRMED';

export type InternalFeeAmount = {
  status: InternalFeeStatus;
  /** 원문 상태 그대로(KNOWN/ZERO/UNKNOWN/NOT_APPLICABLE). 0 과 모름을 섞지 않는다. */
  state: TermEconomicAmount['state'];
  amount: Money | null;
  vatTreatment: TermEconomicAmount['vatTreatment'] | null;
  vatAmount: number | null;
  totalAmount: number | null;
  /** 미확정 이유(규칙 없음/원문 모순 등). 확정이면 null. */
  reasonCode: string | null;
  /** 근거: 수수료 규칙 정본 행(F04 수수료표 등)과 가격 근거. */
  ruleId: string | null;
  policyId: string | null;
  sourceRefs: string[];
};

/** 기간별 한 줄. 청구(공급사에게 받는 것)·지급(영업채널에 주는 것) 두 칸. */
export type InternalFeeLookupTerm = {
  termKey: string;
  termMonths: number | null;
  supplierBillingFee: InternalFeeAmount;
  channelPayoutFee: InternalFeeAmount;
};

export type InternalFeeLookup = {
  contract: typeof INTERNAL_FEE_LOOKUP_CONTRACT_VERSION;
  offerId: string;
  terms: InternalFeeLookupTerm[];
};

const toAmount = (fee: TermEconomicAmount): InternalFeeAmount => {
  const confirmed = fee.state === 'KNOWN' || fee.state === 'ZERO' || fee.state === 'NOT_APPLICABLE';
  return {
    status: confirmed ? 'CONFIRMED' : 'UNCONFIRMED',
    state: fee.state,
    amount: fee.amount ?? null,
    vatTreatment: fee.vatTreatment ?? null,
    vatAmount: fee.vatAmount ?? null,
    totalAmount: fee.totalAmount ?? null,
    // 미확정인데 이유가 비어 있으면 «이유 없음» 자체를 표시한다(빈칸으로 두지 않는다).
    reasonCode: confirmed ? null : (fee.reasonCode ?? 'REASON_NOT_RECORDED'),
    ruleId: fee.ruleId ?? null,
    policyId: fee.policyId ?? null,
    sourceRefs: [...fee.sourceRefs],
  };
};

/** 저장된 기간별 경제 조건을 내부 조회 모양으로 바꾼다(순수·계산 없음 — 값은 저장된 그대로). */
export function toInternalFeeLookup(offerId: string, terms: readonly OfferTermEconomics[] | undefined): InternalFeeLookup {
  return {
    contract: INTERNAL_FEE_LOOKUP_CONTRACT_VERSION,
    offerId,
    terms: (terms ?? []).map((term) => ({
      termKey: term.termKey,
      termMonths: term.termMonths ?? null,
      supplierBillingFee: toAmount(term.supplierBillingFee),
      channelPayoutFee: toAmount(term.channelPayoutFee),
    })),
  };
}
