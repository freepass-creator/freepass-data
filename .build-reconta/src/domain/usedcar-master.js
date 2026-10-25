import { stableDigest } from '../shared/stable-digest.js';
import { selectVehicles, } from './vehicle-selector.js';
export const USEDCAR_MASTER_CONTRACT = 'usedcar-master/v1';
export const USEDCAR_MASTER_PROJECTION_ID = 'usedcar-master';
export function usedcarMasterRecordId(trimId, fallbackIdentity) {
    return trimId
        ? `used_${trimId}`
        : `used_partial_${stableDigest(fallbackIdentity).slice(0, 24)}`;
}
export function validateUsedcarMasterSemantics(records) {
    const issues = [];
    const seen = new Set();
    for (const record of records) {
        if (seen.has(record.recordId)) {
            issues.push({ code: 'DUPLICATE_RECORD_ID', recordId: record.recordId });
        }
        seen.add(record.recordId);
        const dependencyPairs = [
            ['generationId', 'vehicleModelId'],
            ['phaseId', 'generationId'],
            ['modelYearId', 'phaseId'],
            ['powertrainId', 'modelYearId'],
            ['variantId', 'powertrainId'],
            ['trimId', 'variantId'],
        ];
        for (const [child, parent] of dependencyPairs) {
            if (record[child] && !record[parent]) {
                issues.push({
                    code: 'IDENTITY_PARENT_REQUIRED',
                    recordId: record.recordId,
                    field: String(child),
                    detail: String(parent),
                });
            }
        }
        if (record.identityStatus === 'RESOLVED') {
            for (const [field, value] of [
                ['vehicleModelId', record.vehicleModelId],
                ['generationId', record.generationId],
                ['phaseId', record.phaseId],
                ['modelYearId', record.modelYearId],
                ['powertrainId', record.powertrainId],
                ['variantId', record.variantId],
                ['trimId', record.trimId],
            ]) {
                if (!value) {
                    issues.push({
                        code: 'RESOLVED_STABLE_ID_REQUIRED',
                        recordId: record.recordId,
                        field,
                    });
                }
            }
            if (!Number.isInteger(record.modelYear)) {
                issues.push({
                    code: 'RESOLVED_MODEL_YEAR_REQUIRED',
                    recordId: record.recordId,
                    field: 'modelYear',
                });
            }
        }
        if (record.identityStatus === 'HOLD' && !record.holdReasons.length) {
            issues.push({
                code: 'HOLD_REASON_REQUIRED',
                recordId: record.recordId,
                field: 'holdReasons',
            });
        }
        for (const price of record.originalBasePriceHistory) {
            if (!Number.isSafeInteger(price.amount) || price.amount < 0) {
                issues.push({
                    code: 'INVALID_ORIGINAL_BASE_PRICE',
                    recordId: record.recordId,
                    field: price.priceRevisionId,
                });
            }
        }
    }
    return issues;
}
function nonEmptyQuery(query) {
    return Object.values(query).some((value) => typeof value === 'string' ? Boolean(value.trim()) : value != null);
}
export function usedcarMasterToSelectorRecord(record) {
    return {
        recordId: record.recordId,
        lifecycle: record.lifecycleStatus,
        identityStatus: record.identityStatus,
        maker: { id: null, label: record.maker },
        model: { id: record.vehicleModelId, label: record.model },
        generation: { id: record.generationId, label: record.generationName },
        phase: { id: record.phaseId, label: record.phaseName },
        modelYear: {
            id: record.modelYearId,
            label: record.modelYear == null ? null : `${record.modelYear}년형`,
            value: record.modelYear,
        },
        powertrain: { id: record.powertrainId, label: record.powertrainName },
        fuelType: { id: null, label: record.configuration.fuelType },
        drivetrain: { id: null, label: record.configuration.drivetrain },
        seats: {
            id: null,
            label: record.configuration.seats == null
                ? null
                : `${record.configuration.seats}인승`,
            value: record.configuration.seats,
        },
        trim: { id: record.trimId, label: record.trimName },
        aliases: [...record.aliases],
    };
}
export function searchUsedcarMaster(records, query) {
    if (!nonEmptyQuery(query)) {
        throw new Error('USEDCAR_MASTER_QUERY_REQUIRED');
    }
    const selection = {};
    if (query.maker !== undefined)
        selection.maker = query.maker;
    if (query.model !== undefined)
        selection.model = query.model;
    if (query.generation !== undefined)
        selection.generation = query.generation;
    if (query.phase !== undefined)
        selection.phase = query.phase;
    if (query.modelYear !== undefined)
        selection.modelYear = query.modelYear;
    if (query.powertrain !== undefined)
        selection.powertrain = query.powertrain;
    if (query.fuelType !== undefined)
        selection.fuelType = query.fuelType;
    if (query.drivetrain !== undefined)
        selection.drivetrain = query.drivetrain;
    if (query.seats !== undefined)
        selection.seats = query.seats;
    if (query.trim !== undefined)
        selection.trim = query.trim;
    const byId = new Map(records.map((record) => [record.recordId, record]));
    const hasSearchText = typeof query.searchText === 'string' && Boolean(query.searchText.trim());
    const result = selectVehicles(records.map(usedcarMasterToSelectorRecord), {
        mode: 'USED_CAR',
        selection,
        includeHold: true,
        ...(query.searchText !== undefined ? { searchText: query.searchText } : {}),
    });
    return result.candidates.map((candidate) => {
        const record = byId.get(candidate.record.recordId);
        return {
            record,
            score: candidate.score,
            matchedFields: [
                ...candidate.matchedAxes,
                ...(hasSearchText && candidate.search.matchedTokens > 0
                    ? ['searchText']
                    : []),
            ],
            unresolvedFields: [
                ...candidate.unresolvedAxes,
                ...(candidate.search.unresolvedTokens > 0 ? ['searchText'] : []),
            ],
            actionState: candidate.actionState,
            action: candidate.action,
            actionReasons: [...candidate.actionReasons],
            selectable: candidate.selectable,
        };
    });
}
