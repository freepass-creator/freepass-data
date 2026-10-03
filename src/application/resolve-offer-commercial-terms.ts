import type { AdminPriceTerm, EconomicsCoverage, CommercialType, Offer, OfferTermEconomics, Policy, PriceTerm, TermEconomicAmount } from '../domain/catalog.js';
import type { CommissionInput } from './kakao-catalog-reference.js';
import { KAKAO_COMMISSION_POLICY, resolveSalesCommission, resolveSupplierBillingFee } from './kakao-catalog-reference.js';
import type {
  DepositResolution,
  MileageResolution,
  OfferCommercialTerms,
  OfferEconomicsAudit,
  ResolvedCommercialTerm,
} from '../domain/offer-commercial-terms.js';

const positiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Canonical save adapter for the existing pinned commission policy. No I/O or input mutation.
 * Fees are per whole contract, supply amounts excluding VAT; missing rules are not exemptions.
 * Reuses the period-fees prototype's fail-closed mapping without its compatibility storage path.
 */
export function precomputeOfferEconomics(
  offer: Pick<Offer, 'id' | 'supplierId' | 'priceTerms'>,
  commercialType?: CommercialType,
  fuel?: string | null,
  evidenceByTerm: Readonly<Record<string, Partial<Pick<CommissionInput, 'vehicleValue' | 'newProductSubtype' | 'depositTierPercent' | 'subscriptionForm' | 'q12Basis' | 'individualException'>>>> = {},
): OfferTermEconomics[] {
  const productType = commercialType ? ({
    NEW_RENT: '신차렌트', USED_RENT: '중고렌트', NEW_SUBSCRIPTION: '신차구독',
    USED_SUBSCRIPTION: '중고구독', OGONG_SUBSCRIPTION: '오공구독', PICKUP_SUBSCRIPTION: '픽업구독',
  } as const)[commercialType] : '';
  const policy = KAKAO_COMMISSION_POLICY;
  const source = policy.canonicalSource;
  const policyRef = `${source.repository}@${source.revision}:${source.path}`;
  return offer.priceTerms.map((term) => {
    const priceRef = `catalog_offers/${offer.id}/priceTerms/${term.termKey}`;
    const args = { ...evidenceByTerm[term.termKey], supplierId: offer.supplierId, productType, fuel: fuel ?? '',
      termMonths: term.termMonths, monthlyRent: term.monthlyRent.amount };
    const convert = (result: ReturnType<typeof resolveSalesCommission>, side: 'BILLING' | 'PAYOUT'): TermEconomicAmount => {
      const base = { ruleId: result.ruleId, policyId: policy.policyId,
        sourceRefs: [policy.currentAuthority, policyRef, priceRef, ...(args.q12Basis?.sourceRef ? [args.q12Basis.sourceRef] : [])],
        vatTreatment: result.vatTreatment, vatAmount: result.vatAmount, totalAmount: result.totalAmount };
      const unknown = (reasonCode: string): TermEconomicAmount => ({ ...base,
        state: 'UNKNOWN', amount: null, calculation: null, vatAmount: null, totalAmount: null, reasonCode });
      if (!productType) return unknown('PRODUCT_TYPE_REQUIRED');
      if (policy.exceptionSupplierIds.iancar.includes(offer.supplierId as 'RP004') && !fuel?.trim()) {
        return unknown('FUEL_REQUIRED_FOR_SUPPLIER_RULE');
      }
      if (!Number.isSafeInteger(term.termMonths) || term.termMonths < 1 ||
          term.monthlyRent.currency !== 'KRW' || !Number.isSafeInteger(args.monthlyRent) || args.monthlyRent < 0) {
        return unknown('INVALID_PRICE_TERM_INPUT');
      }
      if (result.state === 'NOT_APPLICABLE') return { ...base, state: 'NOT_APPLICABLE', amount: null, calculation: null, reasonCode: result.reasonCode };
      if (result.state === 'COORDINATION_REQUIRED') return unknown('COORDINATION_REQUIRED');
      if (result.state !== 'CALCULATED' || result.amount === null) return unknown(result.reasonCode ?? 'NO_MATCHING_RULE');

      let calculation: TermEconomicAmount['calculation'];
      if (result.ruleId?.endsWith('_RENT_X_TERM')) {
        // Read rates from the same policy table, including the Switch ladder alias.
        const billing = policy.rules.find((rule) => rule.id === 'STANDARD_RERENT_BILLING_LADDER')!;
        const payout = policy.rules.find((rule) => 'termMonths' in rule && rule.termMonths === term.termMonths &&
          rule.id.startsWith('STANDARD_RERENT_') && 'rateBasisPoints' in rule);
        const row = side === 'BILLING' ? billing.termRules.find((rule) => rule.termMonths === term.termMonths) : payout;
        const rate = row && 'rateBasisPoints' in row ? row.rateBasisPoints : null;
        if (rate == null) return unknown('CALCULATION_RULE_REQUIRED');
        calculation = { kind: 'RATE', base: 'MONTHLY_RENT_X_TERM', rate: rate / 10000 };
      } else {
        calculation = { kind: 'FIXED', amount: { amount: result.amount, currency: 'KRW' } };
      }
      return { ...base, state: result.amount === 0 ? 'ZERO' : 'KNOWN',
        amount: { amount: result.amount, currency: 'KRW' }, calculation, reasonCode: null };
    };
    const deposit = structuredClone(term.deposit ?? null);
    return {
      termKey: term.termKey, termMonths: term.termMonths, monthlyRent: structuredClone(term.monthlyRent),
      depositCalculation: { state: term.depositState, amount: deposit,
        calculation: deposit ? { kind: 'FIXED', amount: structuredClone(deposit) } : null,
        sourceRefs: [priceRef] },
      supplierBillingFee: convert(resolveSupplierBillingFee(args), 'BILLING'),
      channelPayoutFee: convert(resolveSalesCommission(args), 'PAYOUT'),
    };
  });
}

function resolveDefaultMileage(
  offer: Offer,
  policy: Policy | undefined,
  decisions: string[],
  invalidFacts: string[],
): OfferCommercialTerms['defaultMileage'] {
  if (!offer.policyId) {
    decisions.push('DEFAULT_MILEAGE_POLICY_REQUIRED');
    return { state: 'UNKNOWN', source: 'UNRESOLVED' };
  }
  if (!policy) {
    decisions.push('POLICY_NOT_FOUND');
    return { state: 'UNKNOWN', source: 'UNRESOLVED' };
  }
  if (policy.id !== offer.policyId) {
    invalidFacts.push('POLICY_ID_MISMATCH');
    return { state: 'UNKNOWN', source: 'UNRESOLVED' };
  }

  const raw = policy.facts.annual_mileage;
  if (raw === undefined || raw === null || raw === '') {
    decisions.push('DEFAULT_MILEAGE_REQUIRED');
    return { state: 'UNKNOWN', source: 'UNRESOLVED' };
  }
  if (!positiveSafeInteger(raw)) {
    invalidFacts.push('INVALID_POLICY_ANNUAL_MILEAGE');
    return { state: 'UNKNOWN', source: 'UNRESOLVED' };
  }
  return { state: 'KNOWN', kmPerYear: raw, source: 'POLICY' };
}

function resolveDeposit(
  term: PriceTerm,
  decisions: string[],
  invalidFacts: string[],
): DepositResolution {
  if (term.depositState === 'NOT_APPLICABLE') {
    if (term.deposit != null) invalidFacts.push(`DEPOSIT_NOT_APPLICABLE_WITH_AMOUNT:${term.termKey}`);
    return { state: 'NOT_APPLICABLE', source: 'TERM' };
  }

  if (term.depositState === 'UNKNOWN') {
    if (term.deposit != null) invalidFacts.push(`UNKNOWN_DEPOSIT_WITH_AMOUNT:${term.termKey}`);
    decisions.push(`DEPOSIT_REQUIRED:${term.termKey}`);
    return { state: 'UNKNOWN', source: 'UNRESOLVED' };
  }

  if (!term.deposit || term.deposit.currency !== 'KRW' || !Number.isSafeInteger(term.deposit.amount) || term.deposit.amount < 0) {
    invalidFacts.push(`INVALID_DEPOSIT_AMOUNT:${term.termKey}`);
    return { state: 'UNKNOWN', source: 'UNRESOLVED' };
  }

  if (term.depositState === 'ZERO') {
    if (term.deposit.amount !== 0) {
      invalidFacts.push(`ZERO_DEPOSIT_WITH_NONZERO_AMOUNT:${term.termKey}`);
      return { state: 'UNKNOWN', source: 'UNRESOLVED' };
    }
    return { state: 'ZERO', amount: structuredClone(term.deposit), source: 'TERM' };
  }

  if (term.deposit.amount === 0) {
    invalidFacts.push(`KNOWN_DEPOSIT_WITH_ZERO_AMOUNT:${term.termKey}`);
    return { state: 'UNKNOWN', source: 'UNRESOLVED' };
  }
  return { state: 'KNOWN', amount: structuredClone(term.deposit), source: 'TERM' };
}

function resolveMileage(
  term: PriceTerm,
  defaultMileage: OfferCommercialTerms['defaultMileage'],
  invalidFacts: string[],
): MileageResolution {
  const raw = term.mileageLimitKmPerYear;
  if (raw !== undefined && raw !== null) {
    if (!positiveSafeInteger(raw)) {
      invalidFacts.push(`INVALID_TERM_MILEAGE:${term.termKey}`);
      return { state: 'UNKNOWN', source: 'UNRESOLVED', isDefault: false };
    }
    return {
      state: 'KNOWN',
      kmPerYear: raw,
      source: 'TERM',
      isDefault: defaultMileage.state === 'KNOWN' && raw === defaultMileage.kmPerYear,
    };
  }
  if (defaultMileage.state === 'KNOWN') {
    return {
      state: 'KNOWN',
      kmPerYear: defaultMileage.kmPerYear,
      source: 'POLICY_DEFAULT',
      isDefault: true,
    };
  }
  return { state: 'UNKNOWN', source: 'UNRESOLVED', isDefault: false };
}

export function resolveOfferCommercialTerms(
  offer: Offer,
  policy?: Policy,
): OfferCommercialTerms {
  const decisions: string[] = [];
  const invalidFacts: string[] = [];
  const defaultMileage = resolveDefaultMileage(offer, policy, decisions, invalidFacts);

  const terms: ResolvedCommercialTerm[] = offer.priceTerms
    .map((term) => ({
      termKey: term.termKey,
      termMonths: term.termMonths,
      monthlyRent: structuredClone(term.monthlyRent),
      mileage: resolveMileage(term, defaultMileage, invalidFacts),
      deposit: resolveDeposit(term, decisions, invalidFacts),
    }))
    .sort((a, b) =>
      a.termMonths - b.termMonths ||
      (a.mileage.state === 'KNOWN' ? a.mileage.kmPerYear : Number.MAX_SAFE_INTEGER) -
        (b.mileage.state === 'KNOWN' ? b.mileage.kmPerYear : Number.MAX_SAFE_INTEGER) ||
      a.termKey.localeCompare(b.termKey)
    );

  const variantKeys = new Set<string>();
  for (const term of terms) {
    if (term.mileage.state !== 'KNOWN') {
      decisions.push(`MILEAGE_REQUIRED:${term.termKey}`);
      continue;
    }
    const variantKey = `${term.termMonths}:${term.mileage.kmPerYear}`;
    if (variantKeys.has(variantKey)) invalidFacts.push(`DUPLICATE_TERM_VARIANT:${variantKey}`);
    variantKeys.add(variantKey);
  }

  if (defaultMileage.state === 'KNOWN') {
    const months = [...new Set(terms.map((term) => term.termMonths))].sort((a, b) => a - b);
    for (const termMonths of months) {
      const hasDefaultVariant = terms.some((term) =>
        term.termMonths === termMonths &&
        term.mileage.state === 'KNOWN' &&
        term.mileage.kmPerYear === defaultMileage.kmPerYear
      );
      if (!hasDefaultVariant) decisions.push(`DEFAULT_MILEAGE_PRICE_MISSING:${termMonths}`);
    }
  }

  const uniqueDecisions = [...new Set(decisions)].sort();
  const uniqueInvalidFacts = [...new Set(invalidFacts)].sort();
  const status = uniqueInvalidFacts.length
    ? 'INVALID'
    : uniqueDecisions.length
      ? 'NEEDS_DECISION'
      : 'READY';

  return {
    offerId: offer.id,
    productId: offer.productId,
    supplierId: offer.supplierId,
    ...(offer.policyId ? { policyId: offer.policyId } : {}),
    defaultMileage,
    terms,
    status,
    decisions: uniqueDecisions,
    invalidFacts: uniqueInvalidFacts,
  };
}

export function summarizeCommercialTerms(
  resolved: readonly OfferCommercialTerms[],
) {
  const byStatus = { READY: 0, NEEDS_DECISION: 0, INVALID: 0 };
  const decisionCounts: Record<string, number> = {};
  const invalidCounts: Record<string, number> = {};

  for (const item of resolved) {
    byStatus[item.status] += 1;
    for (const decision of item.decisions) {
      const code = decision.split(':', 1)[0]!;
      decisionCounts[code] = (decisionCounts[code] ?? 0) + 1;
    }
    for (const invalid of item.invalidFacts) {
      const code = invalid.split(':', 1)[0]!;
      invalidCounts[code] = (invalidCounts[code] ?? 0) + 1;
    }
  }

  return {
    total: resolved.length,
    byStatus,
    decisionCounts: Object.fromEntries(Object.entries(decisionCounts).sort(([a], [b]) => a.localeCompare(b))),
    invalidCounts: Object.fromEntries(Object.entries(invalidCounts).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function auditEconomicAmount(
  value: TermEconomicAmount,
  label: string,
  monthlyRent: number,
  termMonths: number,
  decisions: string[],
  invalidFacts: string[],
) {
  if (!['KNOWN', 'ZERO', 'UNKNOWN', 'NOT_APPLICABLE'].includes(value.state)) {
    invalidFacts.push(`INVALID_ECONOMICS_STATE:${label}`);
    return;
  }
  const amount = value.amount?.amount;
  const hasAmount = value.amount != null;
  const hasCalculation = value.calculation != null;
  const validRefs = Array.isArray(value.sourceRefs) && value.sourceRefs.length > 0 &&
    value.sourceRefs.every((ref) => typeof ref === 'string' && ref.trim().length > 0);

  if (!validRefs) invalidFacts.push(`ECONOMICS_SOURCE_REQUIRED:${label}`);
  if (value.state === 'UNKNOWN' || value.state === 'NOT_APPLICABLE') {
    if (hasAmount || hasCalculation) invalidFacts.push(`ECONOMICS_UNRESOLVED_WITH_VALUE:${label}`);
    if (value.state === 'UNKNOWN') decisions.push(`ECONOMICS_VALUE_REQUIRED:${label}`);
    return;
  }
  if (!hasAmount || value.amount?.currency !== 'KRW' || !Number.isSafeInteger(amount) || amount! < 0) {
    invalidFacts.push(`INVALID_ECONOMICS_AMOUNT:${label}`);
    return;
  }
  if (value.state === 'ZERO' && amount !== 0) invalidFacts.push(`ZERO_ECONOMICS_WITH_NONZERO_AMOUNT:${label}`);
  if (value.state === 'KNOWN' && amount === 0) invalidFacts.push(`KNOWN_ECONOMICS_WITH_ZERO_AMOUNT:${label}`);
  if (!hasCalculation) {
    invalidFacts.push(`ECONOMICS_CALCULATION_REQUIRED:${label}`);
    return;
  }

  const calculation = value.calculation!;
  let expected: number | undefined;
  if (calculation.kind === 'FIXED') {
    if (calculation.amount.currency !== 'KRW' || !Number.isSafeInteger(calculation.amount.amount) || calculation.amount.amount < 0) {
      invalidFacts.push(`INVALID_ECONOMICS_CALCULATION:${label}`);
      return;
    }
    expected = calculation.amount.amount;
  } else if (calculation.kind === 'MULTIPLY') {
    if (!Number.isFinite(calculation.multiplier) || calculation.multiplier < 0) {
      invalidFacts.push(`INVALID_ECONOMICS_CALCULATION:${label}`);
      return;
    }
    expected = Math.round(monthlyRent * calculation.multiplier);
  } else if (calculation.base === 'MONTHLY_RENT_X_TERM') {
    if (!Number.isFinite(calculation.rate) || calculation.rate < 0) {
      invalidFacts.push(`INVALID_ECONOMICS_CALCULATION:${label}`);
      return;
    }
    expected = Math.round(monthlyRent * termMonths * calculation.rate);
  } else if (!Number.isFinite(calculation.rate) || calculation.rate < 0) {
    invalidFacts.push(`INVALID_ECONOMICS_CALCULATION:${label}`);
    return;
  }

  if (calculation.kind === 'RATE' && calculation.base === 'VEHICLE_PRICE') {
    decisions.push(`ECONOMICS_CALCULATION_INPUT_REQUIRED:${label}:VEHICLE_PRICE`);
  }

  // VEHICLE_PRICE needs the contract/quote snapshot input and is validated there.
  if (expected !== undefined && expected !== amount) {
    invalidFacts.push(`ECONOMICS_CALCULATION_MISMATCH:${label}`);
  }
}

/**
 * Audits pre-contract product economics without becoming a settlement calculator.
 * Contract overrides, invoicing, collection and payout remain in the Admin settlement domain.
 */
export function auditOfferEconomicsTerms(offer: Offer): OfferEconomicsAudit {
  const decisions: string[] = [];
  const invalidFacts: string[] = [];
  const economics = structuredClone(offer.internalEconomicsTerms ?? []);
  const prices = new Map(offer.priceTerms.map((term) => [term.termKey, term]));
  const seen = new Set<string>();

  for (const term of economics) {
    if (seen.has(term.termKey)) invalidFacts.push(`DUPLICATE_ECONOMICS_TERM:${term.termKey}`);
    seen.add(term.termKey);
    const price = prices.get(term.termKey);
    if (!price) {
      invalidFacts.push(`ORPHAN_ECONOMICS_TERM:${term.termKey}`);
      continue;
    }
    if ((term.monthlyRent && (term.monthlyRent.amount !== price.monthlyRent.amount || term.monthlyRent.currency !== price.monthlyRent.currency)) ||
        (term.termMonths !== undefined && term.termMonths !== price.termMonths)) {
      invalidFacts.push(`STALE_ECONOMICS_INPUT:${term.termKey}`);
    }
    auditEconomicAmount(term.depositCalculation, `${term.termKey}:DEPOSIT`, price.monthlyRent.amount, price.termMonths, decisions, invalidFacts);
    auditEconomicAmount(term.supplierBillingFee, `${term.termKey}:SUPPLIER_BILLING_FEE`, price.monthlyRent.amount, price.termMonths, decisions, invalidFacts);
    auditEconomicAmount(term.channelPayoutFee, `${term.termKey}:CHANNEL_PAYOUT_FEE`, price.monthlyRent.amount, price.termMonths, decisions, invalidFacts);

    if (
      (term.depositCalculation.state === 'KNOWN' || term.depositCalculation.state === 'ZERO') &&
      (price.depositState === 'KNOWN' || price.depositState === 'ZERO') &&
      term.depositCalculation.amount?.amount !== price.deposit?.amount
    ) {
      invalidFacts.push(`DEPOSIT_ECONOMICS_MISMATCH:${term.termKey}`);
    }
  }
  for (const term of offer.priceTerms) {
    if (!seen.has(term.termKey)) decisions.push(`ECONOMICS_TERM_REQUIRED:${term.termKey}`);
  }

  const uniqueDecisions = [...new Set(decisions)].sort();
  const uniqueInvalidFacts = [...new Set(invalidFacts)].sort();
  return {
    status: uniqueInvalidFacts.length ? 'INVALID' : uniqueDecisions.length ? 'NEEDS_DECISION' : 'READY',
    terms: economics.sort((a, b) => a.termKey.localeCompare(b.termKey)),
    decisions: uniqueDecisions,
    invalidFacts: uniqueInvalidFacts,
  };
}


/** Reads stored facts only. Never calculate commissions on the Admin read path. */
export function readStoredTermFees(offer: Offer, price: PriceTerm): Pick<AdminPriceTerm, 'supplierBillingFee' | 'channelPayoutFee'> {
  const matches = (offer.internalEconomicsTerms ?? []).filter(row => row.termKey === price.termKey);
  const read = (field: 'supplierBillingFee' | 'channelPayoutFee'): TermEconomicAmount => {
    const row = matches.length === 1 ? matches[0] : undefined;
    const value = row?.[field];
    const unknown = (reasonCode: string): TermEconomicAmount => ({
      state: 'UNKNOWN', amount: null, calculation: null, reasonCode,
      ruleId: value?.ruleId ?? null, ...(value?.policyId ? { policyId: value.policyId } : {}),
      sourceRefs: [`catalog_offers/${offer.id}/internalEconomicsTerms/${price.termKey}/${field}`],
    });
    if (!value) return unknown(matches.length > 1 ? 'DUPLICATE_ECONOMICS_TERM' : 'ECONOMICS_NOT_PRECOMPUTED');
    if ((row?.monthlyRent && (row.monthlyRent.amount !== price.monthlyRent.amount || row.monthlyRent.currency !== price.monthlyRent.currency)) ||
        (row?.termMonths !== undefined && row.termMonths !== price.termMonths)) return unknown('STALE_ECONOMICS_INPUT');
    const errors: string[] = [];
    auditEconomicAmount(value, field, price.monthlyRent.amount, price.termMonths, [], errors);
    if (!['KNOWN', 'ZERO', 'UNKNOWN', 'NOT_APPLICABLE'].includes(value.state) || errors.length) return unknown('INVALID_STORED_ECONOMICS');
    return { ...structuredClone(value), amount: structuredClone(value.amount ?? null) };
  };
  return { supplierBillingFee: read('supplierBillingFee'), channelPayoutFee: read('channelPayoutFee') };
}

/** Each fee counts one entry per price term; UNKNOWN on either side makes coverage incomplete. */
export function summarizeEconomicsCoverage(
  terms: readonly Partial<Pick<AdminPriceTerm, 'supplierBillingFee' | 'channelPayoutFee'>>[],
): EconomicsCoverage {
  const counts = () => ({ KNOWN: 0, ZERO: 0, UNKNOWN: 0, NOT_APPLICABLE: 0 });
  const economicsTermCounts = { supplierBillingFee: counts(), channelPayoutFee: counts() };
  for (const term of terms) for (const side of ['supplierBillingFee', 'channelPayoutFee'] as const) {
    const state = term[side]?.state;
    economicsTermCounts[side][state && state in economicsTermCounts[side] ? state : 'UNKNOWN'] += 1;
  }
  return { economicsTermCounts, economicsCoverage: !terms.length ||
    economicsTermCounts.supplierBillingFee.UNKNOWN > 0 || economicsTermCounts.channelPayoutFee.UNKNOWN > 0
    ? 'INCOMPLETE' : 'COMPLETE' };
}
