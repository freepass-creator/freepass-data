import { CONDITION_DIMENSION_SPECS } from './product-condition-dimensions.js';
import { policyScalar } from './product-pricing-policy.js';
function sourcePriceKey(termKey) {
    return termKey.startsWith('source:') ? termKey.slice('source:'.length) : undefined;
}
function parseSourceKey(termKey) {
    const key = sourcePriceKey(termKey);
    if (!key)
        return {};
    const buyout = /^([1-9]\d*)_인수형$/.exec(key);
    if (buyout) {
        return { months: Number(buyout[1]), settlementType: 'BUYOUT' };
    }
    const standard = /^([1-9]\d*)(?:_([1-9]\d*)만)?$/.exec(key);
    if (!standard)
        return {};
    return {
        months: Number(standard[1]),
        ...(standard[2] ? { mileageKmPerYear: Number(standard[2]) * 10000 } : {}),
        settlementType: 'RETURN',
    };
}
function known(dimensionKey, value, origin, sourceRef) {
    return { dimensionKey, status: 'KNOWN', value, origin, sourceRef };
}
function unknown(dimensionKey) {
    return { dimensionKey, status: 'UNKNOWN', origin: 'UNRESOLVED' };
}
export function attributePriceBasisConditions(input) {
    const { sourceTerm, resolvedTerm, policy } = input;
    const parsed = parseSourceKey(sourceTerm.termKey);
    const conditions = [];
    if (parsed.months !== undefined) {
        conditions.push(known('term_months', parsed.months, 'SOURCE_PRICE_KEY', sourceTerm.termKey));
    }
    else {
        conditions.push(known('term_months', sourceTerm.termMonths, 'CANONICAL_PRICE_TERM', sourceTerm.termKey));
    }
    if (parsed.mileageKmPerYear !== undefined) {
        conditions.push(known('annual_mileage_km', parsed.mileageKmPerYear, 'SOURCE_PRICE_KEY', sourceTerm.termKey));
    }
    else if (resolvedTerm.mileage.state === 'KNOWN') {
        const origin = resolvedTerm.mileage.source === 'POLICY_DEFAULT'
            ? 'LINKED_POLICY_FACT'
            : 'CANONICAL_PRICE_TERM';
        conditions.push(known('annual_mileage_km', resolvedTerm.mileage.kmPerYear, origin, origin === 'LINKED_POLICY_FACT'
            ? `${policy?.id ?? 'missing-policy'}:annual_mileage`
            : sourceTerm.termKey));
    }
    else {
        conditions.push(unknown('annual_mileage_km'));
    }
    if (parsed.settlementType) {
        conditions.push(known('settlement_type', parsed.settlementType, 'SOURCE_PRICE_KEY', sourceTerm.termKey));
    }
    else {
        conditions.push(unknown('settlement_type'));
    }
    const handled = new Set(['term_months', 'annual_mileage_km', 'settlement_type']);
    for (const spec of CONDITION_DIMENSION_SPECS) {
        if (handled.has(spec.key))
            continue;
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
        conditions.push(known(spec.key, value, 'LINKED_POLICY_FACT', `${policy?.id ?? 'missing-policy'}:${basisKey}`));
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
