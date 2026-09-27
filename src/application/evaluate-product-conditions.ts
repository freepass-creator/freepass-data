import type { Offer, Policy } from '../domain/catalog.js';
import type {
  ProductConditionSelection,
  ProductPriceResult,
} from '../domain/commercial-product-view.js';
import { resolveOfferCommercialTerms } from './resolve-offer-commercial-terms.js';
import { numberFromPolicy } from './product-pricing-policy.js';

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
  const decisions: string[] = [];
  const invalidFacts: string[] = [];
  const availableTerms = uniqueSorted(commercial.terms.map((term) => term.termMonths));

  let termMonths: number | undefined;
  const rawDefaultTerm = policy?.facts.default_term_months;
  if (rawDefaultTerm !== undefined) {
    const parsed = numberFromPolicy(rawDefaultTerm);
    if (!parsed || !Number.isSafeInteger(parsed)) invalidFacts.push('INVALID_DEFAULT_TERM_MONTHS');
    else if (!availableTerms.includes(parsed)) decisions.push('DEFAULT_TERM_PRICE_MISSING');
    else termMonths = parsed;
  } else if (availableTerms.length === 1) {
    termMonths = availableTerms[0];
  } else {
    decisions.push('DEFAULT_TERM_REQUIRED');
  }

  const selection: ProductConditionSelection = { additionalDriverCount: 0, options: {} };
  if (termMonths !== undefined) selection.termMonths = termMonths;
  if (commercial.defaultMileage.state === 'KNOWN') {
    selection.mileageKmPerYear = commercial.defaultMileage.kmPerYear;
  }

  const basicDriverAge = numberFromPolicy(policy?.facts.basic_driver_age);
  if (policy?.facts.basic_driver_age !== undefined && basicDriverAge === undefined) {
    invalidFacts.push('INVALID_BASIC_DRIVER_AGE');
  } else if (basicDriverAge !== undefined) {
    selection.driverAge = basicDriverAge;
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

  if (!selection.termMonths) {
    return {
      status: 'NEEDS_DECISION',
      selection: structuredClone(selection),
      decisions: ['TERM_SELECTION_REQUIRED'],
      invalidFacts: [],
    };
  }

  const selectedMonths = selection.termMonths;

  if (!selection.mileageKmPerYear) {
    return {
      status: 'NEEDS_DECISION',
      selection: structuredClone(selection),
      decisions: ['MILEAGE_SELECTION_REQUIRED'],
      invalidFacts: [],
    };
  }

  const selectedMileage = selection.mileageKmPerYear;

  const basis = commercial.terms.find((term) =>
    term.termMonths === selectedMonths &&
    term.mileage.state === 'KNOWN' &&
    term.mileage.kmPerYear === selectedMileage
  );

  const selectedTermKey = basis?.termKey;
  const termDecisionCodes = new Set(['DEPOSIT_REQUIRED', 'MILEAGE_REQUIRED']);
  const termInvalidCodes = new Set([
    'DEPOSIT_NOT_APPLICABLE_WITH_AMOUNT',
    'UNKNOWN_DEPOSIT_WITH_AMOUNT',
    'INVALID_DEPOSIT_AMOUNT',
    'ZERO_DEPOSIT_WITH_NONZERO_AMOUNT',
    'KNOWN_DEPOSIT_WITH_ZERO_AMOUNT',
    'INVALID_TERM_MILEAGE',
  ]);
  const decisions = commercial.decisions.filter((item) => {
    const [code, suffix] = item.split(':', 2);
    if (termDecisionCodes.has(code!)) return !!selectedTermKey && suffix === selectedTermKey;
    if (code === 'DEFAULT_MILEAGE_PRICE_MISSING') return Number(suffix) === selectedMonths;
    return true;
  });
  const invalidFacts = commercial.invalidFacts.filter((item) => {
    const [code, suffix] = item.split(':', 2);
    if (termInvalidCodes.has(code!)) return !!selectedTermKey && suffix === selectedTermKey;
    return true;
  });

  if (!basis) {
    const defaultMileage = commercial.defaultMileage.state === 'KNOWN'
      ? commercial.defaultMileage.kmPerYear
      : undefined;
    const defaultBasis = commercial.terms.find((term) =>
      term.termMonths === selectedMonths &&
      term.mileage.state === 'KNOWN' &&
      term.mileage.kmPerYear === defaultMileage
    );
    if (defaultBasis && selectedMileage > (defaultMileage ?? 0)
      && policy?.facts.mileage_upcharge_per_10000km !== undefined) {
      decisions.push('MILEAGE_PRICE_ADJUSTMENT_REQUIRED');
    } else {
      decisions.push('PRICE_BASIS_NOT_FOUND');
    }
  }

  const basicDriverAge = numberFromPolicy(policy?.facts.basic_driver_age);
  const lowerableToAge = numberFromPolicy(policy?.facts.driver_age_lowering);
  const upperAge = numberFromPolicy(policy?.facts.driver_age_upper_limit);
  if (selection.driverAge !== undefined) {
    if (upperAge !== undefined && selection.driverAge > upperAge) {
      invalidFacts.push('DRIVER_AGE_ABOVE_ALLOWED_RANGE');
    } else if (basicDriverAge !== undefined && selection.driverAge < basicDriverAge) {
      if (lowerableToAge === undefined || selection.driverAge < lowerableToAge) {
        invalidFacts.push('DRIVER_AGE_BELOW_ALLOWED_RANGE');
      } else if (policy?.facts.age_lowering_cost !== undefined) {
        decisions.push('DRIVER_AGE_PRICE_ADJUSTMENT_REQUIRED');
      } else {
        decisions.push('DRIVER_AGE_PRICE_RULE_REQUIRED');
      }
    }
  }

  const additionalDriverCount = selection.additionalDriverCount ?? 0;
  if (!Number.isSafeInteger(additionalDriverCount) || additionalDriverCount < 0) {
    invalidFacts.push('INVALID_ADDITIONAL_DRIVER_COUNT');
  } else if (additionalDriverCount > 0) {
    const maxAdditional = numberFromPolicy(policy?.facts.additional_driver_allowance_count);
    if (maxAdditional === undefined) decisions.push('ADDITIONAL_DRIVER_ALLOWANCE_REQUIRED');
    else if (additionalDriverCount > maxAdditional) invalidFacts.push('ADDITIONAL_DRIVER_COUNT_EXCEEDS_POLICY');
    else if (policy?.facts.additional_driver_cost !== undefined) {
      decisions.push('ADDITIONAL_DRIVER_PRICE_ADJUSTMENT_REQUIRED');
    } else {
      decisions.push('ADDITIONAL_DRIVER_PRICE_RULE_REQUIRED');
    }
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
