import type { Offer, Policy, PriceTerm } from '../domain/catalog.js';
import type {
  DepositResolution,
  MileageResolution,
  OfferCommercialTerms,
  ResolvedCommercialTerm,
} from '../domain/offer-commercial-terms.js';

const positiveSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

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
