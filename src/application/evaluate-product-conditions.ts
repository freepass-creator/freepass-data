import type { Offer, Policy } from '../domain/catalog.js';
import type {
  ProductConditionSelection,
  ProductPriceResult,
} from '../domain/commercial-product-view.js';
import { resolveOfferCommercialTerms } from './resolve-offer-commercial-terms.js';

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

function uniqueSorted(values: number[]) {
  return [...new Set(values)].sort((a, b) => a - b);
}

export function buildDefaultProductConditionSelection(
  offer: Offer,
  policy?: Policy,
): { selection: ProductConditionSelection; decisions: string[]; invalidFacts: string[] } {
  const commercial = resolveOfferCommercialTerms(offer, policy);
  const decisions = [...commercial.decisions];
  const invalidFacts = [...commercial.invalidFacts];
  const availableTerms = uniqueSorted(commercial.terms.map((term) => term.termMonths));

  let termMonths: number | undefined;
  const rawDefaultTerm = policy?.facts.default_term_months;
  if (rawDefaultTerm !== undefined) {
    if (!positiveInteger(rawDefaultTerm)) invalidFacts.push('INVALID_DEFAULT_TERM_MONTHS');
    else if (!availableTerms.includes(rawDefaultTerm)) decisions.push('DEFAULT_TERM_PRICE_MISSING');
    else termMonths = rawDefaultTerm;
  } else if (availableTerms.length === 1) {
    termMonths = availableTerms[0];
  } else {
    decisions.push('DEFAULT_TERM_REQUIRED');
  }

  const selection: ProductConditionSelection = { options: {} };
  if (termMonths !== undefined) selection.termMonths = termMonths;
  if (commercial.defaultMileage.state === 'KNOWN') {
    selection.mileageKmPerYear = commercial.defaultMileage.kmPerYear;
  }

  const rawDriverAge = policy?.facts.basic_driver_age;
  if (rawDriverAge !== undefined) {
    if (!positiveInteger(rawDriverAge)) invalidFacts.push('INVALID_BASIC_DRIVER_AGE');
    else selection.driverAge = rawDriverAge;
  }

  return {
    selection,
    decisions: [...new Set(decisions)].sort(),
    invalidFacts: [...new Set(invalidFacts)].sort(),
  };
}

export function evaluateProductConditions(
  offer: Offer,
  policy: Policy | undefined,
  selection: ProductConditionSelection,
): ProductPriceResult {
  const commercial = resolveOfferCommercialTerms(offer, policy);
  const decisions = [...commercial.decisions];
  const invalidFacts = [...commercial.invalidFacts];

  if (!selection.termMonths) decisions.push('TERM_SELECTION_REQUIRED');
  if (!selection.mileageKmPerYear) decisions.push('MILEAGE_SELECTION_REQUIRED');

  const basis = commercial.terms.find((term) =>
    selection.termMonths !== undefined &&
    selection.mileageKmPerYear !== undefined &&
    term.termMonths === selection.termMonths &&
    term.mileage.state === 'KNOWN' &&
    term.mileage.kmPerYear === selection.mileageKmPerYear
  );

  if (selection.termMonths && selection.mileageKmPerYear && !basis) {
    decisions.push('PRICE_BASIS_NOT_FOUND');
  }

  const basicDriverAge = policy?.facts.basic_driver_age;
  if (selection.driverAge !== undefined && positiveInteger(basicDriverAge) && selection.driverAge !== basicDriverAge) {
    decisions.push('DRIVER_AGE_PRICE_RULE_REQUIRED');
  }

  for (const key of Object.keys(selection.options).sort()) {
    decisions.push(`CONDITION_PRICE_RULE_REQUIRED:${key}`);
  }

  if (basis?.deposit.state === 'UNKNOWN') decisions.push('FINAL_DEPOSIT_UNRESOLVED');

  const uniqueDecisions = [...new Set(decisions)].sort();
  const uniqueInvalidFacts = [...new Set(invalidFacts)].sort();
  const status = uniqueInvalidFacts.length
    ? 'INVALID'
    : uniqueDecisions.length
      ? 'NEEDS_DECISION'
      : 'READY';

  return {
    status,
    selection: structuredClone(selection),
    ...(basis ? { basisTermKey: basis.termKey } : {}),
    ...(status === 'READY' && basis ? {
      monthlyRent: structuredClone(basis.monthlyRent),
      deposit: {
        state: basis.deposit.state,
        ...('amount' in basis.deposit ? { amount: structuredClone(basis.deposit.amount) } : {}),
      },
    } : {}),
    decisions: uniqueDecisions,
    invalidFacts: uniqueInvalidFacts,
  };
}
