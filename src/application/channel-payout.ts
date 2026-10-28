import { parseErp5CompatibilityPriceKey } from '../domain/deposit-evidence.js';
import type { PayoutFeeSnapshotDocument, PayoutFeeSnapshotTerm } from '../ports/payout-fee-snapshot-store.js';

export type ChannelPayoutTerm = {
  key: string;
  months: number;
  state: 'KNOWN' | 'ZERO' | 'UNKNOWN' | 'NOT_APPLICABLE';
  amount: number | null;
  vatTreatment: 'EXCLUDED' | 'INCLUDED' | 'UNKNOWN' | null;
  vatAmount: number | null;
  totalAmount: number | null;
};

/** 저장된 기간 키를 GNA rates 키로 보수적으로 바꾼다. 해석이 하나로 정해지지 않으면 내보내지 않는다. */
export function toGnaRateKey(term: Pick<PayoutFeeSnapshotTerm, 'termKey' | 'termMonths'>): string | null {
  const parsed = parseErp5CompatibilityPriceKey(term.termKey);
  if (!parsed || parsed.months !== term.termMonths || parsed.settlement !== 'RETURN') return null;
  if (parsed.contractedMileage) {
    const unit = parsed.contractedMileage.period === 'month' ? '월' : '연';
    return `${term.termMonths}_${unit}${parsed.contractedMileage.km}km`;
  }
  if (parsed.mileageKm !== undefined) return `${term.termMonths}_연${parsed.mileageKm}km`;
  return String(term.termMonths);
}

const validMoney = (value: unknown): value is number | null => value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function buildChannelPayoutResponse(consumerId: string, snapshot: PayoutFeeSnapshotDocument | null) {
  const terms: ChannelPayoutTerm[] = [];
  for (const term of snapshot?.terms ?? []) {
    if (terms.length === 80) break;
    const key = toGnaRateKey(term);
    if (!key || !validMoney(term.amount) || !validMoney(term.vatAmount) || !validMoney(term.totalAmount)) continue;
    const vatTreatment = term.vatTreatment === 'EXCLUDED' || term.vatTreatment === 'INCLUDED' || term.vatTreatment === 'UNKNOWN'
      ? term.vatTreatment : null;
    terms.push({ key, months: term.termMonths, state: term.state, amount: term.amount, vatTreatment,
      vatAmount: term.vatAmount, totalAmount: term.totalAmount });
  }
  return { schema: 'freepass-data.channel-payout-fee/v1' as const, consumerId,
    snapshotDate: snapshot?.snapshotDate ?? null, terms };
}
