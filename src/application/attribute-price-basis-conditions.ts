import type { Policy, PriceTerm } from '../domain/catalog.js';
import type {
  PriceBasisAttribution,
  PriceConditionEvidence,
} from '../domain/commercial-product-view.js';
import type { ResolvedCommercialTerm } from '../domain/offer-commercial-terms.js';
import { CONDITION_DIMENSION_SPECS } from './product-condition-dimensions.js';
import { policyScalar } from './product-pricing-policy.js';

function sourcePriceKey(termKey: string): string | undefined {
  return termKey.startsWith('source:') ? termKey.slice('source:'.length) : undefined;
}

type ParsedSourceKey = {
  months?: number;
  mileageKmPerYear?: number;
  settlementType?: 'RETURN' | 'BUYOUT';
};

function parseSourceKey(termKey: string): ParsedSourceKey {
  const key = sourcePriceKey(termKey);
  if (!key) return {};
  const buyout = /^([1-9]\d*)_인수형$/.exec(key);
  if (buyout) {
    return { months: Number(buyout[1]), settlementType: 'BUYOUT' as const };
  }
  const standard = /^([1-9]\d*)(?:_([1-9]\d*)만)?$/.exec(key);
  if (!standard) return {};
  return {
    months: Number(standard[1]),
    ...(standard[2] ? { mileageKmPerYear: Number(standard[2]) * 10000 } : {}),
    settlementType: 'RETURN' as const,
  };
}

function known(
  dimensionKey: string,
  value: NonNullable<PriceConditionEvidence['value']>,
  origin: PriceConditionEvidence['origin'],
  sourceRef: string,
): PriceConditionEvidence {
  return { dimensionKey, status: 'KNOWN', value, origin, sourceRef };
}

function unknown(dimensionKey: string): PriceConditionEvidence {
  return { dimensionKey, status: 'UNKNOWN', origin: 'UNRESOLVED' };
}

export function attributePriceBasisConditions(input: {
  sourceTerm: PriceTerm;
  resolvedTerm: ResolvedCommercialTerm;
  policy?: Policy;
}): PriceBasisAttribution {
  const { sourceTerm, resolvedTerm, policy } = input;
  const parsed = parseSourceKey(sourceTerm.termKey);
  const conditions: PriceConditionEvidence[] = [];

  if (parsed.months !== undefined) {
    conditions.push(known(
      'term_months',
      parsed.months,
      'SOURCE_PRICE_KEY',
      sourceTerm.termKey,
    ));
  } else {
    conditions.push(known(
      'term_months',
      sourceTerm.termMonths,
      'CANONICAL_PRICE_TERM',
      sourceTerm.termKey,
    ));
  }

  if (parsed.mileageKmPerYear !== undefined) {
    conditions.push(known(
      'annual_mileage_km',
      parsed.mileageKmPerYear,
      'SOURCE_PRICE_KEY',
      sourceTerm.termKey,
    ));
  } else if (resolvedTerm.mileage.state === 'KNOWN') {
    const origin = resolvedTerm.mileage.source === 'POLICY_DEFAULT'
      ? 'LINKED_POLICY_FACT'
      : 'CANONICAL_PRICE_TERM';
    conditions.push(known(
      'annual_mileage_km',
      resolvedTerm.mileage.kmPerYear,
      origin,
      origin === 'LINKED_POLICY_FACT'
        ? `${policy?.id ?? 'missing-policy'}:annual_mileage`
        : sourceTerm.termKey,
    ));
  } else {
    conditions.push(unknown('annual_mileage_km'));
  }

  if (parsed.settlementType) {
    conditions.push(known(
      'settlement_type',
      parsed.settlementType,
      'SOURCE_PRICE_KEY',
      sourceTerm.termKey,
    ));
  } else {
    conditions.push(unknown('settlement_type'));
  }

  const handled = new Set(['term_months', 'annual_mileage_km', 'settlement_type']);
  for (const spec of CONDITION_DIMENSION_SPECS) {
    if (handled.has(spec.key)) continue;
    const basisKey = spec.defaultPolicyKey;
    if (!basisKey) {
      conditions.push(unknown(spec.key));
      continue;
    }
    const value = policyScalar(policy?.facts[basisKey]);
    if (value === undefined) {
      conditions.push(unknown(spec.key));
      continue;
    }
    conditions.push(known(
      spec.key,
      value,
      'LINKED_POLICY_FACT',
      `${policy?.id ?? 'missing-policy'}:${basisKey}`,
    ));
  }

  const unknownConditionKeys = conditions
    .filter((condition) => condition.status === 'UNKNOWN')
    .map((condition) => condition.dimensionKey)
    .sort();

  return {
    status: unknownConditionKeys.length ? 'PARTIAL' : 'COMPLETE',
    conditions: conditions.sort((a, b) => a.dimensionKey.localeCompare(b.dimensionKey)),
    unknownConditionKeys,
    monthlyRentOrigin: {
      origin: 'CANONICAL_PRICE_TERM',
      sourceRef: sourceTerm.termKey,
    },
    depositOrigin: resolvedTerm.deposit.state === 'UNKNOWN'
      ? { origin: 'UNRESOLVED' }
      : {
          origin: 'CANONICAL_PRICE_TERM',
          sourceRef: sourceTerm.termKey,
        },
  };
}
