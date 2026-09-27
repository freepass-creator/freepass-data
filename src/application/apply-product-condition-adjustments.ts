import type { Money } from '../domain/catalog.js';
import type {
  ConditionPredicate,
  ProductConditionAdjustmentRule,
} from '../domain/pricing-condition-model.js';
import type { CommercialFactValue } from '../domain/commercial-product-view.js';

type ConditionValues = Record<string, CommercialFactValue | undefined>;

export type PricingRuleApplication = {
  ruleId: string;
  target: 'MONTHLY_RENT' | 'DEPOSIT' | 'UPFRONT_FEE';
  before: number | null;
  after: number | null;
};

export type PricingRuleEvaluation = {
  monthlyRent: Money;
  deposit?: Money;
  upfrontFee?: Money;
  appliedRules: PricingRuleApplication[];
  unresolvedRules: string[];
};

function same(a: CommercialFactValue, b: CommercialFactValue) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function matches(predicate: ConditionPredicate, values: ConditionValues): boolean {
  const actual = values[predicate.dimensionKey];
  if (actual === undefined) return false;
  switch (predicate.op) {
    case 'EQ': return same(actual, predicate.value);
    case 'NE': return !same(actual, predicate.value);
    case 'IN': return predicate.values.some((value) => same(actual, value));
    case 'GT': return typeof actual === 'number' && actual > predicate.value;
    case 'GTE': return typeof actual === 'number' && actual >= predicate.value;
    case 'LT': return typeof actual === 'number' && actual < predicate.value;
    case 'LTE': return typeof actual === 'number' && actual <= predicate.value;
  }
}

function money(amount: number): Money {
  return { amount: Math.round(amount), currency: 'KRW' };
}

export function applyProductConditionAdjustmentRules(input: {
  basisMonthlyRent: Money;
  basisDeposit?: Money;
  basisUpfrontFee?: Money;
  conditions: ConditionValues;
  rules: ProductConditionAdjustmentRule[];
}): PricingRuleEvaluation {
  let monthlyRent = input.basisMonthlyRent.amount;
  let deposit = input.basisDeposit?.amount;
  let upfrontFee = input.basisUpfrontFee?.amount;
  const appliedRules: PricingRuleApplication[] = [];
  const unresolvedRules: string[] = [];

  const sorted = [...input.rules].sort((a, b) =>
    a.priority - b.priority || a.ruleId.localeCompare(b.ruleId)
  );

  const readTarget = (target: ProductConditionAdjustmentRule['target']) =>
    target === 'MONTHLY_RENT' ? monthlyRent : target === 'DEPOSIT' ? deposit : upfrontFee;
  const writeTarget = (target: ProductConditionAdjustmentRule['target'], amount: number) => {
    if (target === 'MONTHLY_RENT') monthlyRent = amount;
    else if (target === 'DEPOSIT') deposit = amount;
    else upfrontFee = amount;
  };

  for (const rule of sorted) {
    if (!rule.when.every((predicate) => matches(predicate, input.conditions))) continue;
    const before = readTarget(rule.target);
    const op = rule.operation;

    if (op.kind === 'REQUIRE_EXPLICIT_VARIANT') {
      unresolvedRules.push(rule.ruleId);
      continue;
    }

    if (op.kind === 'SET_FIXED') {
      writeTarget(rule.target, op.amount.amount);
    } else if (op.kind === 'ADD_FIXED') {
      if (before === undefined) { unresolvedRules.push(rule.ruleId); continue; }
      writeTarget(rule.target, before + op.amount.amount);
    } else if (op.kind === 'ADD_RATE') {
      if (before === undefined) { unresolvedRules.push(rule.ruleId); continue; }
      const base = op.base === 'BASIS_MONTHLY_RENT'
        ? input.basisMonthlyRent.amount
        : monthlyRent;
      writeTarget(rule.target, before + base * op.rate);
    } else if (op.kind === 'ADD_PER_UNIT') {
      if (before === undefined) { unresolvedRules.push(rule.ruleId); continue; }
      const actual = input.conditions[rule.dimensionKey];
      if (typeof actual !== 'number') { unresolvedRules.push(rule.ruleId); continue; }
      const from = op.fromValue ?? 0;
      const units = Math.max(0, Math.ceil((actual - from) / op.unit));
      writeTarget(rule.target, before + units * op.amount.amount);
    } else if (op.kind === 'MULTIPLY') {
      const base = op.base === 'BASIS_MONTHLY_RENT'
        ? input.basisMonthlyRent.amount
        : op.base === 'CURRENT_MONTHLY_RENT'
          ? monthlyRent
          : deposit;
      if (base === undefined) { unresolvedRules.push(rule.ruleId); continue; }
      writeTarget(rule.target, base * op.multiplier);
    }

    const after = readTarget(rule.target);
    appliedRules.push({
      ruleId: rule.ruleId,
      target: rule.target,
      before: before ?? null,
      after: after ?? null,
    });
  }

  return {
    monthlyRent: money(monthlyRent),
    ...(deposit !== undefined ? { deposit: money(deposit) } : {}),
    ...(upfrontFee !== undefined ? { upfrontFee: money(upfrontFee) } : {}),
    appliedRules,
    unresolvedRules,
  };
}
