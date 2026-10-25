import { CONDITION_DIMENSION_SPECS } from './product-condition-dimensions.js';
import { numberFromPolicy, policyScalar } from './product-pricing-policy.js';
function normalizeComparable(dimensionKey, value) {
    const spec = CONDITION_DIMENSION_SPECS.find((item) => item.key === dimensionKey);
    if (!spec)
        return undefined;
    if (spec.valueType === 'NUMBER' || spec.valueType === 'MONEY') {
        const n = numberFromPolicy(value);
        return n === undefined ? undefined : n;
    }
    return policyScalar(value);
}
function same(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}
export function matchPriceBasisToPolicyCandidates(input) {
    const independentEvidence = input.attribution.conditions.filter((condition) => condition.status === 'KNOWN'
        && condition.value !== undefined
        && (condition.origin === 'SOURCE_PRICE_KEY' || condition.origin === 'CANONICAL_PRICE_TERM'));
    const comparable = independentEvidence.flatMap((condition) => {
        const spec = CONDITION_DIMENSION_SPECS.find((item) => item.key === condition.dimensionKey);
        if (!spec?.defaultPolicyKey)
            return [];
        const expected = normalizeComparable(condition.dimensionKey, condition.value);
        if (expected === undefined)
            return [];
        return [{
                dimensionKey: condition.dimensionKey,
                expected,
                policyKey: spec.defaultPolicyKey,
                sourceRef: condition.sourceRef,
            }];
    });
    if (!comparable.length) {
        return {
            status: 'INSUFFICIENT_EVIDENCE',
            candidatePolicyIds: [],
            matchedDimensionKeys: [],
            sourceRefs: [],
        };
    }
    const matches = input.candidates
        .filter((candidate) => candidate.supplierId === input.supplierId)
        .filter((candidate) => comparable.every((evidence) => {
        const actual = normalizeComparable(evidence.dimensionKey, candidate.policy.facts[evidence.policyKey]);
        return actual !== undefined && same(actual, evidence.expected);
    }))
        .sort((a, b) => a.policy.id.localeCompare(b.policy.id));
    if (!matches.length) {
        return {
            status: 'NO_MATCH',
            candidatePolicyIds: [],
            matchedDimensionKeys: comparable.map((item) => item.dimensionKey).sort(),
            sourceRefs: comparable.flatMap((item) => item.sourceRef ? [item.sourceRef] : []).sort(),
        };
    }
    if (matches.length > 1) {
        return {
            status: 'AMBIGUOUS',
            candidatePolicyIds: matches.map((item) => item.policy.id),
            matchedDimensionKeys: comparable.map((item) => item.dimensionKey).sort(),
            sourceRefs: comparable.flatMap((item) => item.sourceRef ? [item.sourceRef] : []).sort(),
        };
    }
    return {
        status: 'UNIQUE_MATCH',
        matchedPolicyId: matches[0].policy.id,
        candidatePolicyIds: [matches[0].policy.id],
        matchedDimensionKeys: comparable.map((item) => item.dimensionKey).sort(),
        sourceRefs: comparable.flatMap((item) => item.sourceRef ? [item.sourceRef] : []).sort(),
    };
}
export function enrichUnknownConditionsFromUniquePolicyMatch(input) {
    if (input.match.status !== 'UNIQUE_MATCH' || !input.policy || input.policy.id !== input.match.matchedPolicyId) {
        return {
            ...structuredClone(input.attribution),
            policyMatch: structuredClone(input.match),
        };
    }
    const conditions = input.attribution.conditions.map((condition) => {
        if (condition.status === 'KNOWN')
            return structuredClone(condition);
        const spec = CONDITION_DIMENSION_SPECS.find((item) => item.key === condition.dimensionKey);
        if (!spec?.defaultPolicyKey)
            return structuredClone(condition);
        const raw = input.policy.facts[spec.defaultPolicyKey];
        const value = policyScalar(raw);
        if (value === undefined)
            return structuredClone(condition);
        return {
            dimensionKey: condition.dimensionKey,
            status: 'KNOWN',
            value,
            origin: 'MATCHED_POLICY_FACT',
            sourceRef: `${input.policy.id}:${spec.defaultPolicyKey}`,
        };
    });
    const unknownConditionKeys = conditions
        .filter((condition) => condition.status === 'UNKNOWN')
        .map((condition) => condition.dimensionKey)
        .sort();
    return {
        ...structuredClone(input.attribution),
        status: unknownConditionKeys.length ? 'PARTIAL' : 'COMPLETE',
        conditions,
        unknownConditionKeys,
        policyMatch: structuredClone(input.match),
    };
}
