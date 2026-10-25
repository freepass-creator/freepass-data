import { canonicalDrivetrain } from '../domain/vehicle-master-normalization.js';
function normalized(value) {
    return value
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[()[\]{}]/g, ' ')
        .replace(/[^0-9a-z가-힣.]+/g, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}
function powertrainKey(value) {
    return normalized(value)
        .split(' ')
        .filter(Boolean)
        .sort()
        .join('|');
}
function trimKey(value) {
    return normalized(value).replace(/\s+/g, '');
}
function compatibleGroupKey(record) {
    return JSON.stringify([
        normalized(record.maker),
        normalized(record.model),
        normalized(record.subModel ?? ''),
        record.modelYear,
        powertrainKey(record.powertrainName),
        trimKey(record.trimName),
    ]);
}
function uniqueSorted(values) {
    return [...new Set(values)].sort();
}
function mergeScalar(field, rows, read) {
    const observed = rows
        .map((row) => ({
        sourceDocumentId: row.sourceDocumentId,
        value: read(row.record),
    }))
        .filter((row) => row.value !== null);
    const distinct = new Map();
    for (const item of observed) {
        distinct.set(JSON.stringify(item.value), item.value);
    }
    const evidence = uniqueSorted(observed.map((item) => item.sourceDocumentId));
    if (distinct.size === 0)
        return { value: null, evidence };
    if (distinct.size === 1)
        return { value: [...distinct.values()][0] ?? null, evidence };
    return {
        value: null,
        evidence,
        conflict: {
            field,
            values: [...distinct.values()],
            sourceDocumentIds: evidence,
        },
    };
}
function mergeOptions(rows) {
    const byIdentity = new Map();
    for (const row of rows) {
        for (const option of row.record.options) {
            const kind = option.kind ?? 'OPTION';
            const key = JSON.stringify([normalized(option.name), kind, option.price]);
            const current = byIdentity.get(key) ?? {
                name: option.name,
                kind,
                price: option.price,
                notes: [],
                packageItems: [],
                conditions: [],
                sourceDocumentIds: [],
            };
            if (option.note)
                current.notes.push(option.note);
            current.packageItems.push(...(option.packageItems ?? []));
            current.conditions.push(...(option.conditions ?? []));
            current.sourceDocumentIds.push(row.sourceDocumentId);
            byIdentity.set(key, current);
        }
    }
    return [...byIdentity.values()]
        .map((option) => ({
        name: option.name,
        kind: option.kind,
        price: option.price,
        note: uniqueSorted(option.notes).join(' / ') || null,
        packageItems: uniqueSorted(option.packageItems),
        conditions: option.conditions.filter((condition, index, values) => values.findIndex((candidate) => candidate.relation === condition.relation &&
            normalized(candidate.targetLabel) === normalized(condition.targetLabel) &&
            candidate.raw === condition.raw) === index),
        sourceDocumentIds: uniqueSorted(option.sourceDocumentIds),
    }))
        .sort((a, b) => a.name.localeCompare(b.name) || (a.price ?? -1) - (b.price ?? -1));
}
function mergeBaseItemDetails(rows) {
    const byIdentity = new Map();
    for (const row of rows) {
        for (const item of row.record.baseItemDetails ?? []) {
            const key = JSON.stringify([item.category ?? null, normalized(item.name)]);
            const current = byIdentity.get(key) ?? {
                category: item.category ?? null,
                name: item.name,
                sourceDocumentIds: [],
            };
            current.sourceDocumentIds.push(row.sourceDocumentId);
            byIdentity.set(key, current);
        }
    }
    return [...byIdentity.values()]
        .map((item) => ({
        ...item,
        sourceDocumentIds: uniqueSorted(item.sourceDocumentIds),
    }))
        .sort((a, b) => String(a.category ?? '').localeCompare(String(b.category ?? '')) ||
        a.name.localeCompare(b.name));
}
export function reconcileVehicleMasterTrimFacts(rows) {
    const groups = new Map();
    for (const row of rows) {
        const key = compatibleGroupKey(row.record);
        groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const reconciled = [];
    for (const group of groups.values()) {
        const first = group[0];
        const seats = mergeScalar('seats', group, (record) => record.seats);
        const drivetrain = mergeScalar('drivetrain', group, (record) => canonicalDrivetrain(record.drivetrain));
        const fuelType = mergeScalar('fuelType', group, (record) => record.fuelType);
        const basePrice = mergeScalar('basePrice', group, (record) => record.basePrice);
        const currency = mergeScalar('currency', group, (record) => record.currency);
        const conflicts = [seats.conflict, drivetrain.conflict, fuelType.conflict, basePrice.conflict, currency.conflict]
            .filter((value) => Boolean(value));
        const sourceDocumentIds = uniqueSorted(group.map((row) => row.sourceDocumentId));
        const effectiveDates = group
            .map((row) => row.record.effectiveFrom ?? null)
            .filter((value) => Boolean(value))
            .sort();
        const basePriceObservations = group
            .map((row) => ({
            sourceDocumentId: row.sourceDocumentId,
            amount: row.record.basePrice,
            currency: row.record.currency,
            effectiveFrom: row.record.effectiveFrom ?? null,
        }))
            .sort((a, b) => a.sourceDocumentId.localeCompare(b.sourceDocumentId) ||
            a.amount - b.amount ||
            String(a.effectiveFrom ?? '').localeCompare(String(b.effectiveFrom ?? '')));
        reconciled.push({
            maker: first.record.maker,
            model: first.record.model,
            subModel: first.record.subModel?.trim() || null,
            modelYear: first.record.modelYear,
            powertrainName: first.record.powertrainName,
            seats: seats.value,
            drivetrain: drivetrain.value,
            trimName: first.record.trimName,
            fuelType: fuelType.value,
            basePrice: basePrice.value ?? first.record.basePrice,
            basePriceObservations,
            currency: (currency.value ?? 'KRW'),
            effectiveFrom: effectiveDates[0] ?? null,
            baseItems: uniqueSorted(group.flatMap((row) => row.record.baseItems)),
            baseItemDetails: mergeBaseItemDetails(group),
            options: mergeOptions(group),
            sourceDocumentIds,
            fieldEvidence: {
                maker: sourceDocumentIds,
                model: sourceDocumentIds,
                subModel: first.record.subModel?.trim() ? sourceDocumentIds : [],
                modelYear: sourceDocumentIds,
                powertrainName: sourceDocumentIds,
                trimName: sourceDocumentIds,
                basePrice: basePrice.evidence,
                seats: seats.evidence,
                drivetrain: drivetrain.evidence,
                fuelType: fuelType.evidence,
                currency: currency.evidence,
            },
            conflicts,
        });
    }
    return reconciled.sort((a, b) => a.modelYear - b.modelYear ||
        a.powertrainName.localeCompare(b.powertrainName) ||
        (a.seats ?? 0) - (b.seats ?? 0) ||
        String(a.drivetrain ?? '').localeCompare(String(b.drivetrain ?? '')) ||
        a.trimName.localeCompare(b.trimName) ||
        a.basePrice - b.basePrice);
}
export function parsedOptionsByName(options) {
    return new Map(options.map((option) => [normalized(option.name), option]));
}
