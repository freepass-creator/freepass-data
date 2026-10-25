const OPTION_KINDS = new Set([
    'OPTION',
    'COLOR',
    'SEATS',
    'DRIVETRAIN',
    'ACCESSORY',
]);
function object(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}`);
    }
    return value;
}
function text(value, field) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}`);
    }
    return value.trim();
}
function nullableText(value, field) {
    if (value === null || value === undefined)
        return null;
    return text(value, field);
}
function integer(value, field, min = 0) {
    if (!Number.isSafeInteger(value) || Number(value) < min) {
        throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}`);
    }
    return Number(value);
}
function nullableInteger(value, field, min = 0) {
    if (value === null || value === undefined)
        return null;
    return integer(value, field, min);
}
function stringArray(value, field) {
    if (!Array.isArray(value)) {
        throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}`);
    }
    return value.map((item, index) => text(item, `${field}[${index}]`));
}
function parseConditions(value, field) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value)) {
        throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}`);
    }
    return value.map((item, index) => {
        const row = object(item, `${field}[${index}]`);
        const relation = text(row.relation, `${field}[${index}].relation`);
        if (relation !== 'REQUIRES' && relation !== 'EXCLUDES') {
            throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}[${index}].relation`);
        }
        return {
            relation,
            targetLabel: text(row.targetLabel, `${field}[${index}].targetLabel`),
            raw: text(row.raw, `${field}[${index}].raw`),
        };
    });
}
function parseOption(value, field) {
    const row = object(value, field);
    const kindValue = row.kind === undefined ? 'OPTION' : text(row.kind, `${field}.kind`);
    if (!OPTION_KINDS.has(kindValue)) {
        throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}.kind`);
    }
    const price = row.price === null || row.price === undefined
        ? null
        : integer(row.price, `${field}.price`);
    const option = {
        name: text(row.name, `${field}.name`),
        kind: kindValue,
        price,
        sourceText: typeof row.sourceText === 'string' ? row.sourceText : '',
    };
    if (row.note !== undefined && row.note !== null) {
        option.note = text(row.note, `${field}.note`);
    }
    const conditions = parseConditions(row.conditions, `${field}.conditions`);
    if (conditions.length)
        option.conditions = conditions;
    if (row.packageItems !== undefined) {
        option.packageItems = stringArray(row.packageItems, `${field}.packageItems`);
    }
    return option;
}
function parseBaseItemDetails(value, field) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value)) {
        throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}`);
    }
    return value.map((item, index) => {
        const row = object(item, `${field}[${index}]`);
        return {
            category: nullableText(row.category, `${field}[${index}].category`),
            name: text(row.name, `${field}[${index}].name`),
            sourceText: typeof row.sourceText === 'string' ? row.sourceText : '',
        };
    });
}
function parseTrimPayload(value, field) {
    const row = object(value, field);
    if (row.currency !== 'KRW') {
        throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}.currency`);
    }
    const optionsRaw = row.options;
    if (!Array.isArray(optionsRaw)) {
        throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}.options`);
    }
    const parsed = {
        maker: text(row.maker, `${field}.maker`),
        model: text(row.model, `${field}.model`),
        subModel: nullableText(row.subModel, `${field}.subModel`),
        modelYear: integer(row.modelYear, `${field}.modelYear`, 1900),
        powertrainName: text(row.powertrainName, `${field}.powertrainName`),
        seats: nullableInteger(row.seats, `${field}.seats`, 1),
        drivetrain: nullableText(row.drivetrain, `${field}.drivetrain`),
        trimName: text(row.trimName, `${field}.trimName`),
        fuelType: nullableText(row.fuelType, `${field}.fuelType`),
        basePrice: integer(row.basePrice, `${field}.basePrice`),
        currency: 'KRW',
        effectiveFrom: nullableText(row.effectiveFrom, `${field}.effectiveFrom`),
        baseItems: stringArray(row.baseItems, `${field}.baseItems`),
        baseItemDetails: parseBaseItemDetails(row.baseItemDetails, `${field}.baseItemDetails`),
        options: optionsRaw.map((item, index) => parseOption(item, `${field}.options[${index}]`)),
        sourceText: typeof row.sourceTextExcerpt === 'string' ? row.sourceTextExcerpt : '',
    };
    if (parsed.effectiveFrom && !Number.isFinite(Date.parse(parsed.effectiveFrom))) {
        throw new Error(`VEHICLE_MASTER_NORMALIZED_INVALID:${field}.effectiveFrom`);
    }
    return parsed;
}
export async function loadNormalizedVehicleMasterTrimRecords(store, sourceDocumentIds) {
    const rows = [];
    for (const sourceDocumentId of [...new Set(sourceDocumentIds)].sort()) {
        const source = await store.getSourceDocument(sourceDocumentId);
        if (!source) {
            throw new Error(`VEHICLE_MASTER_SOURCE_DOCUMENT_NOT_FOUND:${sourceDocumentId}`);
        }
        const records = await store.listPipelineRecords('NORMALIZED_RECORD', sourceDocumentId);
        for (const record of records) {
            if (record.payload.recordKind !== 'TRIM')
                continue;
            rows.push({
                sourceDocumentId,
                record: parseTrimPayload(record.payload.record, `${record.recordId}.record`),
            });
        }
    }
    if (!rows.length)
        throw new Error('VEHICLE_MASTER_NORMALIZED_TRIMS_NOT_FOUND');
    return rows;
}
