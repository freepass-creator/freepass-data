export const ESTIMATE_NEWCAR_MASTER_CONTRACT = 'estimate-newcar-master/v1';
export const ESTIMATE_NEWCAR_MASTER_PROJECTION_ID = 'estimate-newcar-master';
const duplicateValues = (values) => {
    const seen = new Set();
    const dup = new Set();
    for (const value of values) {
        if (seen.has(value))
            dup.add(value);
        seen.add(value);
    }
    return [...dup].sort();
};
export function validateEstimateMasterSemantics(records) {
    const issues = [];
    for (const id of duplicateValues(records.map((record) => record.productId))) {
        issues.push({ code: 'DUPLICATE_PRODUCT_ID', detail: id });
    }
    for (const id of duplicateValues(records.map((record) => record.trimId).filter((id) => Boolean(id)))) {
        issues.push({ code: 'DUPLICATE_TRIM_ID', detail: id });
    }
    for (const record of records) {
        const optionIds = record.options.map((option) => option.optionId).filter((id) => Boolean(id));
        const optionSet = new Set(optionIds);
        for (const id of duplicateValues(optionIds)) {
            issues.push({ code: 'DUPLICATE_OPTION_ID', productId: record.productId, field: 'options', detail: id });
        }
        for (const option of record.options) {
            if (!option.optionId) {
                if (record.status === 'ACTIVE') {
                    issues.push({ code: 'ACTIVE_OPTION_ID_REQUIRED', productId: record.productId, field: 'options' });
                }
                continue;
            }
            for (const requiredId of option.requires) {
                if (!optionSet.has(requiredId)) {
                    issues.push({
                        code: 'OPTION_REQUIRES_UNKNOWN',
                        productId: record.productId,
                        field: option.optionId,
                        detail: requiredId
                    });
                }
                if (requiredId === option.optionId) {
                    issues.push({
                        code: 'OPTION_REQUIRES_SELF',
                        productId: record.productId,
                        field: option.optionId
                    });
                }
            }
            for (const excludedId of option.excludes) {
                if (!optionSet.has(excludedId)) {
                    issues.push({
                        code: 'OPTION_EXCLUDES_UNKNOWN',
                        productId: record.productId,
                        field: option.optionId,
                        detail: excludedId
                    });
                }
                if (excludedId === option.optionId) {
                    issues.push({
                        code: 'OPTION_EXCLUDES_SELF',
                        productId: record.productId,
                        field: option.optionId
                    });
                }
                if (option.requires.includes(excludedId)) {
                    issues.push({
                        code: 'OPTION_REQUIRES_EXCLUDES_CONFLICT',
                        productId: record.productId,
                        field: option.optionId,
                        detail: excludedId
                    });
                }
            }
        }
        for (const [field, colors] of [
            ['exteriorColors', record.exteriorColors],
            ['interiorColors', record.interiorColors]
        ]) {
            for (const id of duplicateValues(colors.map((color) => color.colorId).filter((id) => Boolean(id)))) {
                issues.push({ code: 'DUPLICATE_COLOR_ID', productId: record.productId, field, detail: id });
            }
        }
        if (record.status === 'ACTIVE') {
            for (const [field, value] of [
                ['vehicleModelId', record.vehicleModelId],
                ['modelYearId', record.modelYearId],
                ['trimId', record.trimId],
                ['powertrainId', record.powertrainId],
            ]) {
                if (!value)
                    issues.push({ code: 'ACTIVE_STABLE_ID_REQUIRED', productId: record.productId, field });
            }
            if (typeof record.modelYear !== 'number' || !Number.isInteger(record.modelYear)) {
                issues.push({ code: 'ACTIVE_MODEL_YEAR_REQUIRED', productId: record.productId, field: 'modelYear' });
            }
            if (record.exteriorColors.some((color) => !color.colorId)) {
                issues.push({ code: 'ACTIVE_COLOR_ID_REQUIRED', productId: record.productId, field: 'exteriorColors' });
            }
            if (record.interiorColors.some((color) => !color.colorId)) {
                issues.push({ code: 'ACTIVE_COLOR_ID_REQUIRED', productId: record.productId, field: 'interiorColors' });
            }
            if (!record.exteriorColors.length) {
                issues.push({ code: 'ACTIVE_EXTERIOR_COLOR_REQUIRED', productId: record.productId, field: 'exteriorColors' });
            }
            if (!record.interiorColors.length) {
                issues.push({ code: 'ACTIVE_INTERIOR_COLOR_REQUIRED', productId: record.productId, field: 'interiorColors' });
            }
            if (record.holdReasons?.length) {
                issues.push({ code: 'ACTIVE_RECORD_HAS_HOLD_REASON', productId: record.productId, field: 'holdReasons' });
            }
        }
        if (record.status === 'HOLD' && !record.holdReasons?.length) {
            issues.push({ code: 'HOLD_REASON_REQUIRED', productId: record.productId, field: 'holdReasons' });
        }
    }
    return issues;
}
function candidateText(value, field) {
    const normalized = String(value ?? '').trim();
    if (!normalized)
        throw new Error(`ESTIMATE_MASTER_CANDIDATE_INVALID:${field}`);
    return normalized;
}
function candidateNullableId(value) {
    const normalized = String(value ?? '').trim();
    return normalized || null;
}
function candidateMoney(value, field) {
    if (!value || value.currency !== 'KRW' || !Number.isSafeInteger(value.amount) || value.amount < 0) {
        throw new Error(`ESTIMATE_MASTER_CANDIDATE_INVALID:${field}`);
    }
    return { amount: value.amount, currency: 'KRW' };
}
function normalizeCandidateOption(option) {
    return {
        optionId: candidateNullableId(option?.optionId),
        name: candidateText(option?.name, 'option.name'),
        price: candidateMoney(option?.price, 'option.price'),
        requires: [...new Set((option?.requires || []).map((id) => candidateText(id, 'option.requires')))].sort(),
        excludes: [...new Set((option?.excludes || []).map((id) => candidateText(id, 'option.excludes')))].sort(),
        exclusiveGroupId: candidateNullableId(option?.exclusiveGroupId),
    };
}
function normalizeCandidateColor(color) {
    return {
        colorId: candidateNullableId(color?.colorId),
        name: candidateText(color?.name, 'color.name'),
        code: candidateNullableId(color?.code),
        price: candidateMoney(color?.price, 'color.price'),
    };
}
function uniqueHoldReasons(values) {
    return [...new Set(values.filter(Boolean))].sort();
}
/**
 * Converts reviewed source/canonical facts into one Estimate master projection record.
 * Missing evidence is represented as HOLD; no stable identity or model year is invented.
 */
export function buildEstimateNewcarMasterRecord(candidate) {
    const reasons = [...(candidate.holdReasons || []).map((reason) => candidateText(reason, 'holdReason'))];
    const vehicleModelId = candidateNullableId(candidate.vehicleModelId);
    const modelYearId = candidateNullableId(candidate.modelYearId);
    const trimId = candidateNullableId(candidate.trimId);
    const powertrainId = candidateNullableId(candidate.powertrainId);
    const modelYear = candidate.modelYear == null ? null : Number(candidate.modelYear);
    if (!vehicleModelId)
        reasons.push('VEHICLE_MODEL_ID_UNVERIFIED');
    if (!modelYearId)
        reasons.push('MODEL_YEAR_ID_UNVERIFIED');
    if (!trimId)
        reasons.push('TRIM_ID_UNVERIFIED');
    if (!powertrainId)
        reasons.push('POWERTRAIN_ID_UNVERIFIED');
    const validModelYear = typeof modelYear === 'number' &&
        Number.isInteger(modelYear) && modelYear >= 1900 && modelYear <= 2200;
    if (!validModelYear)
        reasons.push('MODEL_YEAR_UNVERIFIED');
    const options = (candidate.options || []).map(normalizeCandidateOption);
    const exteriorColors = (candidate.exteriorColors || []).map(normalizeCandidateColor);
    const interiorColors = (candidate.interiorColors || []).map(normalizeCandidateColor);
    if (options.some((option) => !option.optionId))
        reasons.push('OPTION_ID_UNVERIFIED');
    if (exteriorColors.some((color) => !color.colorId) ||
        interiorColors.some((color) => !color.colorId))
        reasons.push('COLOR_ID_UNVERIFIED');
    if (!exteriorColors.length)
        reasons.push('EXTERIOR_COLOR_UNAVAILABLE');
    if (!interiorColors.length)
        reasons.push('INTERIOR_COLOR_UNAVAILABLE');
    const seats = candidate.configuration?.seats == null ? null : Number(candidate.configuration.seats);
    if (seats !== null && (!Number.isSafeInteger(seats) || seats < 1)) {
        throw new Error('ESTIMATE_MASTER_CANDIDATE_INVALID:configuration.seats');
    }
    let record = {
        productId: candidateText(candidate.productId, 'productId'),
        vehicleModelId,
        modelYearId,
        trimId,
        powertrainId,
        maker: candidateText(candidate.maker, 'maker'),
        model: candidateText(candidate.model, 'model'),
        modelYear: validModelYear ? modelYear : null,
        trimName: candidateText(candidate.trimName, 'trimName'),
        powertrainName: candidateText(candidate.powertrainName, 'powertrainName'),
        basePrice: candidateMoney(candidate.basePrice, 'basePrice'),
        priceBefore: candidate.priceBefore ? candidateMoney(candidate.priceBefore, 'priceBefore') : null,
        priceAfter: candidate.priceAfter ? candidateMoney(candidate.priceAfter, 'priceAfter') : null,
        priceBasis: candidateNullableId(candidate.priceBasis),
        options,
        exteriorColors,
        interiorColors,
        configuration: {
            drivetrain: candidateNullableId(candidate.configuration?.drivetrain),
            seats,
            bodyConfiguration: candidateNullableId(candidate.configuration?.bodyConfiguration),
        },
        status: reasons.length ? 'HOLD' : 'ACTIVE',
        holdReasons: uniqueHoldReasons(reasons),
    };
    let semanticIssues = validateEstimateMasterSemantics([record]);
    if (semanticIssues.length) {
        record = {
            ...record,
            status: 'HOLD',
            holdReasons: uniqueHoldReasons([
                ...(record.holdReasons || []),
                ...semanticIssues.map((issue) => issue.code),
            ]),
        };
        semanticIssues = validateEstimateMasterSemantics([record]);
    }
    const recordedHoldReasons = new Set(record.holdReasons || []);
    const nonHoldRepresentationIssues = semanticIssues.filter((issue) => issue.code !== 'HOLD_REASON_REQUIRED' && !recordedHoldReasons.has(issue.code));
    if (nonHoldRepresentationIssues.length) {
        throw new Error(`ESTIMATE_MASTER_RECORD_INVALID:${nonHoldRepresentationIssues.map((issue) => issue.code).join(',')}`);
    }
    return Object.freeze({
        ...record,
        options: Object.freeze(record.options.map((option) => Object.freeze(option))),
        exteriorColors: Object.freeze(record.exteriorColors.map((color) => Object.freeze(color))),
        interiorColors: Object.freeze(record.interiorColors.map((color) => Object.freeze(color))),
        holdReasons: Object.freeze([...(record.holdReasons || [])]),
    });
}
export function uncoveredEstimateMasterIssues(records, issues = validateEstimateMasterSemantics(records)) {
    const byProductId = new Map(records.map((record) => [record.productId, record]));
    return issues.filter((issue) => {
        if (!issue.productId)
            return true;
        const record = byProductId.get(issue.productId);
        if (!record || record.status !== 'HOLD')
            return true;
        return !(record.holdReasons || []).includes(issue.code);
    });
}
