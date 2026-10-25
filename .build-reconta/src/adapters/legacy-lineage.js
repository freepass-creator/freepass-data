import { createHash } from 'node:crypto';
const TRANSFORM_ID = 'legacy-freepasserp3-product-normalizer';
const TRANSFORM_VERSION = '1.1.0';
function getPath(input, path) {
    return path.split('.').reduce((value, part) => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return undefined;
        return value[part];
    }, input);
}
function stableId(parts) {
    return createHash('sha256').update(parts.join('|')).digest('hex');
}
function record(input) {
    const lineageId = stableId([
        input.raw.sourceId,
        input.raw.sourceRecordId,
        input.raw.fingerprint,
        input.sourceFieldPath,
        input.normalizedFieldPath
    ]);
    return {
        lineageRecordId: `lin_${stableId([lineageId, input.runId])}`,
        lineageId,
        stage: 'RAW_TO_NORMALIZED',
        runId: input.runId,
        sourceId: input.raw.sourceId,
        sourceRecordId: input.raw.sourceRecordId,
        sourceFingerprint: input.raw.fingerprint,
        observedAt: input.raw.observedAt,
        source: {
            fieldPath: input.sourceFieldPath,
            value: getPath(input.raw.data, input.sourceFieldPath) ?? null
        },
        normalized: {
            candidateId: input.candidateId,
            fieldPath: input.normalizedFieldPath,
            value: input.normalizedValue
        },
        transformId: TRANSFORM_ID,
        transformVersion: TRANSFORM_VERSION
    };
}
export function buildLegacyCandidateLineage(raw, candidate, runId, candidateId) {
    const out = [];
    const direct = [
        ['product_code', 'productCode'],
        ['car_number', 'carNumber'],
        ['maker', 'maker'],
        ['model', 'model'],
        ['sub_model', 'subModel'],
        ['trim_name', 'trimName'],
        ['product_type', 'commercialType'],
        ['provider_company_code', 'providerCompanyCode'],
        ['policy_code', 'policyCode'],
        ['vehicle_status', 'vehicleStatusRaw'],
        ['year', 'year'],
        ['fuel_type', 'fuelType'],
        ['mileage', 'mileageKm'],
        ['drive_type', 'driveType'],
        ['seats', 'seats'],
        ['origin', 'origin']
    ];
    for (const [sourceFieldPath, candidateKey] of direct) {
        const normalizedValue = candidate[candidateKey];
        if (normalizedValue === undefined)
            continue;
        out.push(record({
            raw,
            runId,
            candidateId,
            sourceFieldPath,
            normalizedFieldPath: String(candidateKey),
            normalizedValue
        }));
    }
    for (const term of candidate.priceTerms) {
        if (!term.termKey.startsWith('source:'))
            continue;
        const sourceKey = term.termKey.slice('source:'.length);
        const prefix = `price.${sourceKey}`;
        const normalizedPrefix = `priceTerms.${term.termKey}`;
        out.push(record({
            raw,
            runId,
            candidateId,
            sourceFieldPath: `${prefix}.rent`,
            normalizedFieldPath: `${normalizedPrefix}.monthlyRent.amount`,
            normalizedValue: term.monthlyRent.amount
        }));
        out.push(record({
            raw,
            runId,
            candidateId,
            sourceFieldPath: `${prefix}.deposit`,
            normalizedFieldPath: `${normalizedPrefix}.depositState`,
            normalizedValue: term.depositState
        }));
        // Preserve the exact RAW decision inputs alongside the per-term amount.
        for (const path of ['provider_company_code', 'product_type', 'deposit_note', 'deposit_free', 'price']) {
            out.push(record({ raw, runId, candidateId, sourceFieldPath: path,
                normalizedFieldPath: `${normalizedPrefix}.depositState`, normalizedValue: term.depositState }));
        }
        if (term.deposit) {
            out.push(record({
                raw,
                runId,
                candidateId,
                sourceFieldPath: `${prefix}.deposit`,
                normalizedFieldPath: `${normalizedPrefix}.deposit.amount`,
                normalizedValue: term.deposit.amount
            }));
        }
        out.push(record({
            raw,
            runId,
            candidateId,
            sourceFieldPath: `price.${sourceKey}`,
            normalizedFieldPath: `${normalizedPrefix}.termMonths`,
            normalizedValue: term.termMonths
        }));
        if (term.mileageLimitKmPerYear !== undefined && term.mileageLimitKmPerYear !== null) {
            out.push(record({
                raw,
                runId,
                candidateId,
                sourceFieldPath: `price.${sourceKey}`,
                normalizedFieldPath: `${normalizedPrefix}.mileageLimitKmPerYear`,
                normalizedValue: term.mileageLimitKmPerYear
            }));
        }
    }
    return out;
}
