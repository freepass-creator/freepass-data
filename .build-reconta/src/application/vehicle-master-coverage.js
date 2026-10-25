import { stableDigest } from '../shared/stable-digest.js';
const CORROBORATING_SOURCE_TYPES = new Set([
    'MANUFACTURER_OFFICIAL',
    'PUBLIC_CERTIFIED',
    'STRUCTURED_PROVIDER',
    'DANAWA',
    'CARNOON',
    'CARISYOU',
]);
function normalize(value) {
    return value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^0-9a-z가-힣]+/g, '')
        .trim();
}
function sourceOrigin(source) {
    if (source.sourceType !== 'STRUCTURED_PROVIDER' &&
        source.sourceType !== 'PUBLIC_CERTIFIED' &&
        source.sourceType !== 'OTHER') {
        return source.sourceType;
    }
    if (source.sourceUrl) {
        try {
            return `${source.sourceType}:${new URL(source.sourceUrl).hostname.toLowerCase()}`;
        }
        catch {
            // fall through
        }
    }
    return `${source.sourceType}:${source.sourceName.trim().toLowerCase()}`;
}
function trimPayload(record) {
    if (record.kind !== 'NORMALIZED_RECORD')
        return null;
    if (record.payload.recordKind !== 'TRIM')
        return null;
    const row = record.payload.record;
    if (!row || typeof row !== 'object' || Array.isArray(row))
        return null;
    const value = row;
    if (typeof value.maker !== 'string' ||
        typeof value.model !== 'string' ||
        typeof value.modelYear !== 'number' ||
        !Number.isInteger(value.modelYear)) {
        return null;
    }
    return {
        maker: value.maker.trim(),
        model: value.model.trim(),
        modelYear: value.modelYear,
        powertrainName: typeof value.powertrainName === 'string' ? value.powertrainName.trim() : '',
        trimName: typeof value.trimName === 'string' ? value.trimName.trim() : '',
        drivetrain: typeof value.drivetrain === 'string' ? value.drivetrain.trim() : '',
        seats: typeof value.seats === 'number' && Number.isInteger(value.seats)
            ? value.seats
            : null,
    };
}
function coverageStatus(sources) {
    if (sources.some((source) => source.sourceType === 'MANUFACTURER_OFFICIAL')) {
        return 'OFFICIAL';
    }
    const corroboratingOrigins = new Set(sources
        .filter((source) => CORROBORATING_SOURCE_TYPES.has(source.sourceType))
        .map(sourceOrigin));
    if (corroboratingOrigins.size >= 2)
        return 'CORROBORATED';
    if (corroboratingOrigins.size === 1)
        return 'SINGLE_SOURCE';
    return 'DISCOVERY_ONLY';
}
export function buildVehicleMasterCoverageFromEvidence(input) {
    const sourceById = new Map(input.sources.map((source) => [source.sourceDocumentId, source]));
    const normalized = input.normalized;
    const groups = new Map();
    for (const record of normalized) {
        if (!record.sourceDocumentId)
            continue;
        const source = sourceById.get(record.sourceDocumentId);
        if (!source)
            continue;
        const parsed = trimPayload(record);
        if (!parsed)
            continue;
        const key = stableDigest({
            maker: normalize(parsed.maker),
            model: normalize(parsed.model),
            modelYear: parsed.modelYear,
        });
        const acc = groups.get(key) ?? {
            maker: parsed.maker,
            model: parsed.model,
            modelYear: parsed.modelYear,
            sourceDocumentIds: new Set(),
            normalizedRecordCount: 0,
            powertrainKeys: new Set(),
            trimKeys: new Set(),
        };
        acc.sourceDocumentIds.add(source.sourceDocumentId);
        acc.normalizedRecordCount += 1;
        if (parsed.powertrainName) {
            acc.powertrainKeys.add(normalize(parsed.powertrainName));
        }
        if (parsed.trimName) {
            acc.trimKeys.add(normalize([
                parsed.powertrainName,
                parsed.drivetrain,
                parsed.seats == null ? '' : String(parsed.seats),
                parsed.trimName,
            ].join('|')));
        }
        groups.set(key, acc);
    }
    return [...groups.values()]
        .map((acc) => {
        const sourceRows = [...acc.sourceDocumentIds]
            .map((id) => sourceById.get(id))
            .filter((source) => Boolean(source));
        const sourceOrigins = [...new Set(sourceRows.map(sourceOrigin))].sort();
        const sourceTypes = [...new Set(sourceRows.map((source) => source.sourceType))].sort();
        const latestObservedAt = sourceRows
            .map((source) => source.observedAt)
            .sort()
            .at(-1) ?? '';
        return {
            coverageId: `vmcov_${stableDigest({
                maker: normalize(acc.maker),
                model: normalize(acc.model),
                modelYear: acc.modelYear,
            }).slice(0, 24)}`,
            maker: acc.maker,
            model: acc.model,
            modelYear: acc.modelYear,
            sourceDocumentIds: [...acc.sourceDocumentIds].sort(),
            sourceOrigins,
            sourceTypes,
            normalizedRecordCount: acc.normalizedRecordCount,
            powertrainKeys: [...acc.powertrainKeys].sort(),
            trimKeys: [...acc.trimKeys].sort(),
            latestObservedAt,
            status: coverageStatus(sourceRows),
        };
    })
        .sort((a, b) => b.modelYear - a.modelYear ||
        a.maker.localeCompare(b.maker) ||
        a.model.localeCompare(b.model));
}
export async function buildVehicleMasterCoverage(store) {
    const [sources, normalized] = await Promise.all([
        store.listSourceDocuments(),
        store.listPipelineRecordsByKind('NORMALIZED_RECORD'),
    ]);
    return buildVehicleMasterCoverageFromEvidence({ sources, normalized });
}
export function coverageStrength(status) {
    switch (status) {
        case 'OFFICIAL': return 4;
        case 'CORROBORATED': return 3;
        case 'SINGLE_SOURCE': return 2;
        case 'DISCOVERY_ONLY': return 1;
    }
}
export function findCoverageForHint(rows, modelHint, modelYearHint) {
    if (!modelHint || modelYearHint == null)
        return null;
    const hint = normalize(modelHint);
    const candidates = rows.filter((row) => row.modelYear === modelYearHint &&
        (hint.includes(normalize(row.model)) ||
            normalize(row.model).includes(hint)));
    return candidates.sort((a, b) => coverageStrength(b.status) - coverageStrength(a.status) ||
        b.normalizedRecordCount - a.normalizedRecordCount)[0] ?? null;
}
