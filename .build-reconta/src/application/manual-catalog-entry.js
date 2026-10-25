import { assertCommandWriter } from '../domain/authority.js';
import { stableDigest } from '../shared/stable-digest.js';
import { assertCatalogWriterOwnership, resolveExecutionWriter } from '../domain/writer-ownership.js';
export class InvalidManualCatalogEntryError extends Error {
    code = 'INVALID_MANUAL_CATALOG_ENTRY';
}
export class ManualCatalogEntryIdempotencyConflictError extends Error {
    code = 'MANUAL_CATALOG_ENTRY_IDEMPOTENCY_CONFLICT';
}
export class ManualCatalogEntryCollisionError extends Error {
    code = 'MANUAL_CATALOG_ENTRY_COLLISION';
}
function token(...parts) {
    return stableDigest(parts).slice(0, 24);
}
function requestDigest(input, writerId) {
    return stableDigest({
        commandType: 'CREATE_MANUAL_CATALOG_ENTRY',
        entry: input.entry,
        actor: {
            id: input.actor.id,
            kind: input.actor.kind,
            organizationId: input.actor.organizationId ?? null
        },
        writerId,
        reason: input.reason
    });
}
function optionalText(value) {
    const text = value?.trim();
    return text ? text : undefined;
}
function assertMoney(input, index) {
    if (input.monthlyRent.currency !== 'KRW' ||
        !Number.isInteger(input.monthlyRent.amount) ||
        input.monthlyRent.amount < 0) {
        throw new InvalidManualCatalogEntryError(`priceTerms[${index}].monthlyRent must be a non-negative integer KRW amount`);
    }
    if (!Number.isInteger(input.termMonths) || input.termMonths < 1 || input.termMonths > 120) {
        throw new InvalidManualCatalogEntryError(`priceTerms[${index}].termMonths must be an integer between 1 and 120`);
    }
    if (input.mileageLimitKmPerYear !== undefined &&
        input.mileageLimitKmPerYear !== null &&
        (!Number.isInteger(input.mileageLimitKmPerYear) || input.mileageLimitKmPerYear < 0)) {
        throw new InvalidManualCatalogEntryError(`priceTerms[${index}].mileageLimitKmPerYear must be a non-negative integer`);
    }
    if (input.depositState === 'KNOWN') {
        if (!input.deposit ||
            input.deposit.currency !== 'KRW' ||
            !Number.isInteger(input.deposit.amount) ||
            input.deposit.amount <= 0) {
            throw new InvalidManualCatalogEntryError(`priceTerms[${index}] KNOWN deposit requires a positive integer KRW amount`);
        }
    }
    else if (input.depositState === 'ZERO') {
        if (!input.deposit ||
            input.deposit.currency !== 'KRW' ||
            input.deposit.amount !== 0) {
            throw new InvalidManualCatalogEntryError(`priceTerms[${index}] ZERO deposit requires KRW 0`);
        }
    }
    else if (input.deposit !== undefined && input.deposit !== null) {
        throw new InvalidManualCatalogEntryError(`priceTerms[${index}] ${input.depositState} deposit must not contain an amount`);
    }
}
function normalizeManualEntry(entry, sourceRecordId, fingerprint) {
    const maker = entry.maker.trim();
    const model = entry.model.trim();
    const supplierId = entry.supplierId.trim();
    if (!maker || !model || !supplierId) {
        throw new InvalidManualCatalogEntryError('maker, model and supplierId are required');
    }
    if (!entry.priceTerms.length) {
        throw new InvalidManualCatalogEntryError('at least one price term is required');
    }
    if (entry.mileageKm !== undefined &&
        entry.mileageKm !== null &&
        (!Number.isInteger(entry.mileageKm) || entry.mileageKm < 0)) {
        throw new InvalidManualCatalogEntryError('mileageKm must be a non-negative integer');
    }
    if (entry.seats !== undefined &&
        entry.seats !== null &&
        (!Number.isInteger(entry.seats) || entry.seats < 1)) {
        throw new InvalidManualCatalogEntryError('seats must be a positive integer');
    }
    const seen = new Set();
    const priceTerms = entry.priceTerms.map((term, index) => {
        assertMoney(term, index);
        const mileage = term.mileageLimitKmPerYear ?? null;
        const semanticKey = `${term.termMonths}|${mileage ?? 'na'}`;
        if (seen.has(semanticKey)) {
            throw new InvalidManualCatalogEntryError(`duplicate contract condition for ${term.termMonths} months / ${mileage ?? 'no mileage'}`);
        }
        seen.add(semanticKey);
        return {
            termKey: `manual:${term.termMonths}:${mileage ?? 'na'}`,
            termMonths: term.termMonths,
            monthlyRent: structuredClone(term.monthlyRent),
            depositState: term.depositState,
            ...(term.deposit ? { deposit: structuredClone(term.deposit) } : {}),
            ...(mileage !== null ? { mileageLimitKmPerYear: mileage } : {})
        };
    });
    const carNumber = optionalText(entry.carNumber);
    const subModel = optionalText(entry.subModel);
    const trimName = optionalText(entry.trimName);
    const fuelType = optionalText(entry.fuelType);
    const driveType = optionalText(entry.driveType);
    return {
        sourceRecordId,
        sourceFingerprint: fingerprint,
        ...(carNumber ? { carNumber } : {}),
        maker,
        model,
        ...(subModel ? { subModel } : {}),
        ...(trimName ? { trimName } : {}),
        commercialType: entry.commercialType,
        providerCompanyCode: supplierId,
        ...(fuelType ? { fuelType } : {}),
        ...(entry.mileageKm !== undefined && entry.mileageKm !== null
            ? { mileageKm: entry.mileageKm }
            : {}),
        ...(driveType ? { driveType } : {}),
        ...(entry.seats !== undefined && entry.seats !== null
            ? { seats: entry.seats }
            : {}),
        priceTerms,
        issues: []
    };
}
function lineageRecord(input) {
    const lineageId = stableDigest([
        input.sourceId,
        input.sourceRecordId,
        input.fingerprint,
        input.sourceFieldPath,
        input.normalizedFieldPath
    ]);
    return {
        lineageRecordId: 'lin_' + stableDigest([lineageId, input.runId]).slice(0, 40),
        lineageId,
        stage: 'RAW_TO_NORMALIZED',
        runId: input.runId,
        sourceId: input.sourceId,
        sourceRecordId: input.sourceRecordId,
        sourceFingerprint: input.fingerprint,
        observedAt: input.observedAt,
        source: {
            fieldPath: input.sourceFieldPath,
            value: structuredClone(input.sourceValue)
        },
        normalized: {
            candidateId: input.candidateId,
            fieldPath: input.normalizedFieldPath,
            value: structuredClone(input.normalizedValue)
        },
        transformId: 'manual-catalog-entry-normalizer',
        transformVersion: '1.0.0'
    };
}
function buildLineage(input) {
    const records = [];
    const direct = [
        ['maker', 'maker', input.entry.maker, input.candidate.maker],
        ['model', 'model', input.entry.model, input.candidate.model],
        ['commercialType', 'commercialType', input.entry.commercialType, input.candidate.commercialType],
        ['supplierId', 'providerCompanyCode', input.entry.supplierId, input.candidate.providerCompanyCode]
    ];
    const optional = [
        ['carNumber', 'carNumber'],
        ['subModel', 'subModel'],
        ['trimName', 'trimName'],
        ['fuelType', 'fuelType'],
        ['mileageKm', 'mileageKm'],
        ['driveType', 'driveType'],
        ['seats', 'seats']
    ];
    for (const [sourceKey, normalizedKey] of optional) {
        const sourceValue = input.entry[sourceKey];
        const normalizedValue = input.candidate[normalizedKey];
        if (normalizedValue !== undefined) {
            direct.push([sourceKey, normalizedKey, sourceValue, normalizedValue]);
        }
    }
    for (const [sourceKey, normalizedKey, sourceValue, normalizedValue] of direct) {
        records.push(lineageRecord({
            runId: input.runId,
            sourceId: input.sourceId,
            sourceRecordId: input.candidate.sourceRecordId,
            fingerprint: input.candidate.sourceFingerprint,
            observedAt: input.observedAt,
            candidateId: input.candidateId,
            sourceFieldPath: String(sourceKey),
            sourceValue,
            normalizedFieldPath: String(normalizedKey),
            normalizedValue
        }));
    }
    input.candidate.priceTerms.forEach((term, index) => {
        const raw = input.entry.priceTerms[index];
        const sourcePrefix = `priceTerms.${index}`;
        const normalizedPrefix = `priceTerms.${term.termKey}`;
        const mappings = [
            [`${sourcePrefix}.termMonths`, raw.termMonths, `${normalizedPrefix}.termMonths`, term.termMonths],
            [`${sourcePrefix}.monthlyRent.amount`, raw.monthlyRent.amount, `${normalizedPrefix}.monthlyRent.amount`, term.monthlyRent.amount],
            [`${sourcePrefix}.depositState`, raw.depositState, `${normalizedPrefix}.depositState`, term.depositState]
        ];
        if (term.deposit) {
            mappings.push([
                `${sourcePrefix}.deposit.amount`,
                raw.deposit?.amount ?? null,
                `${normalizedPrefix}.deposit.amount`,
                term.deposit.amount
            ]);
        }
        if (term.mileageLimitKmPerYear !== undefined && term.mileageLimitKmPerYear !== null) {
            mappings.push([
                `${sourcePrefix}.mileageLimitKmPerYear`,
                raw.mileageLimitKmPerYear ?? null,
                `${normalizedPrefix}.mileageLimitKmPerYear`,
                term.mileageLimitKmPerYear
            ]);
        }
        for (const [sourceFieldPath, sourceValue, normalizedFieldPath, normalizedValue] of mappings) {
            records.push(lineageRecord({
                runId: input.runId,
                sourceId: input.sourceId,
                sourceRecordId: input.candidate.sourceRecordId,
                fingerprint: input.candidate.sourceFingerprint,
                observedAt: input.observedAt,
                candidateId: input.candidateId,
                sourceFieldPath,
                sourceValue,
                normalizedFieldPath,
                normalizedValue
            }));
        }
    });
    return records;
}
export async function createManualCatalogEntry(store, input, now = new Date().toISOString()) {
    assertCommandWriter('CREATE_MANUAL_CATALOG_ENTRY', input.actor);
    if (!input.reason.trim()) {
        throw new InvalidManualCatalogEntryError('reason is required');
    }
    if (!Number.isFinite(Date.parse(now))) {
        throw new InvalidManualCatalogEntryError('observed time is invalid');
    }
    const writer = resolveExecutionWriter(input.actor, input.writer);
    const digest = requestDigest(input, writer.id);
    const fingerprint = stableDigest(input.entry);
    const identity = token(input.idempotencyKey);
    const sourceRecordId = `manual_${identity}`;
    const candidate = normalizeManualEntry(input.entry, sourceRecordId, fingerprint);
    const sourceId = `manual/catalog/${sourceRecordId}`;
    const runId = `run_manual_${identity}`;
    const candidateId = `cand_manual_${identity}`;
    const rawRecordId = `raw_manual_${identity}`;
    const lineage = buildLineage({
        entry: input.entry,
        candidate,
        runId,
        sourceId,
        candidateId,
        observedAt: now
    });
    const sourceDefinition = {
        sourceId,
        kind: 'MANUAL',
        displayName: `Manual Catalog Entry ${sourceRecordId}`,
        authorityScope: ['catalog:manual-entry'],
        expectedFreshnessSeconds: null,
        health: 'HEALTHY',
        enabled: true
    };
    const checkpoint = {
        sourceId,
        checksum: fingerprint,
        observedAt: now
    };
    const coverage = {
        mode: 'FULL',
        completeness: 'COMPLETE',
        scope: sourceRecordId
    };
    const run = {
        runId,
        sourceId,
        status: 'COMPLETED',
        startedAt: now,
        completedAt: now,
        observedAt: now,
        checkpoint,
        coverage,
        headStatus: 'CURRENT',
        rawCount: 1,
        candidateCount: 1,
        lineageCount: lineage.length,
        warningCount: 0
    };
    const head = {
        sourceId,
        runId,
        observedAt: now,
        acceptedAt: now,
        checkpoint,
        coverage
    };
    const raw = {
        rawRecordId,
        runId,
        sourceId,
        sourceRecordId,
        sourceFingerprint: fingerprint,
        observedAt: now,
        payload: JSON.parse(JSON.stringify(input.entry))
    };
    const candidateRecord = {
        candidateId,
        runId,
        sourceId,
        sourceRecordId,
        sourceFingerprint: fingerprint,
        status: 'VALID',
        candidate
    };
    return store.transact(async (tx) => {
        assertCatalogWriterOwnership(await tx.getCatalogWriterOwnership(), writer);
        const existingReceipt = await tx.getManualCatalogEntryReceipt(input.idempotencyKey);
        if (existingReceipt) {
            if (existingReceipt.requestDigest !== digest) {
                throw new ManualCatalogEntryIdempotencyConflictError(`Idempotency key ${input.idempotencyKey} was reused with different manual input`);
            }
            return existingReceipt;
        }
        const [existingSource, existingRun, existingHead, existingRaw, existingCandidate] = await Promise.all([
            tx.getSourceDefinition(sourceId),
            tx.getSourceRun(runId),
            tx.getSourceHead(sourceId),
            tx.getRawRecord(rawRecordId),
            tx.getCandidate(candidateId)
        ]);
        if (existingSource || existingRun || existingHead || existingRaw || existingCandidate) {
            throw new ManualCatalogEntryCollisionError('Manual source artifacts already exist without a matching receipt');
        }
        await tx.putSourceDefinition(sourceDefinition);
        await tx.putSourceRun(run);
        await tx.putSourceHead(head);
        await tx.putRawRecord(raw);
        await tx.putCandidate(candidateRecord);
        for (const record of lineage)
            await tx.appendLineage(record);
        const receipt = {
            idempotencyKey: input.idempotencyKey,
            commandId: input.commandId,
            status: 'SOURCE_ACCEPTED',
            requestDigest: digest,
            sourceId,
            sourceRecordId,
            runId,
            candidateId,
            sourceFingerprint: fingerprint,
            writerId: writer.id,
            actor: structuredClone(input.actor),
            reason: input.reason,
            acceptedAt: now
        };
        await tx.putManualCatalogEntryReceipt(receipt);
        return receipt;
    });
}
