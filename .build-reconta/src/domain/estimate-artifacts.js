import { createHash } from 'node:crypto';
export const QUOTE_CONTRACT_V2 = 'freepass-quote/v2';
export const QUOTE_SNAPSHOT_CONTRACT_V2 = 'freepass-quote-snapshot/v2';
export const QUOTE_REVISION_CONTRACT_V1 = 'freepass-quote-revision/v1';
export const QUOTE_REPOSITORY_CONTRACT = 'freepass-quote-repository/v1';
export const QUOTE_WRITE_RECEIPT_CONTRACT = 'freepass-quote-write-receipt/v1';
export const QUOTE_READ_RECEIPT_CONTRACT = 'freepass-quote-read-receipt/v1';
export const SHARE_ENVELOPE_CONTRACT = 'freepass-share-envelope/v1';
export const SHARE_ENVELOPE_SNAPSHOT_CONTRACT = 'freepass-share-envelope-snapshot/v1';
export const SHARE_ENVELOPE_REPOSITORY_CONTRACT = 'freepass-share-envelope-repository/v1';
export const SHARE_ENVELOPE_WRITE_RECEIPT_CONTRACT = 'freepass-share-envelope-write-receipt/v1';
export const SHARE_ENVELOPE_READ_RECEIPT_CONTRACT = 'freepass-share-envelope-read-receipt/v1';
const SNAPSHOT_FIELDS = [
    'vehicleModelId',
    'modelYearId',
    'trimId',
    'powertrainId',
    'selectedOptionIds',
    'exteriorColorId',
    'interiorColorId',
    'contractTerm',
    'mileageCondition',
    'conditionSnapshot',
    'deposit',
    'prepayment',
    'depositRatePct',
    'prepaymentRatePct',
    'vehiclePriceSnapshot',
    'optionPriceSnapshot',
    'totalVehiclePrice',
    'monthlyRental',
    'pricingEngineVersion',
    'calculationProvenance',
    'sourceRevision',
];
export const MAX_SHARE_ENVELOPE_QUOTE_REFS = 100;
function artifactStableValue(value) {
    if (Array.isArray(value))
        return value.map(artifactStableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([key, child]) => [key, artifactStableValue(child)]));
    }
    return value;
}
export function estimateArtifactDigest(value) {
    return createHash('sha256')
        .update(JSON.stringify(artifactStableValue(value)))
        .digest('hex');
}
const record = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function coded(code) {
    const error = new Error(code);
    error.code = code;
    return error;
}
function requiredId(value, code) {
    const id = String(value ?? '').trim();
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(id))
        throw coded(code);
    return id;
}
function positiveInteger(value, code) {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1)
        throw coded(code);
    return n;
}
function sha256(value, code) {
    const hash = String(value ?? '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash))
        throw coded(code);
    return hash;
}
function iso(value, code) {
    const text = String(value ?? '').trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/);
    if (!match)
        throw coded(code);
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const validCalendarDay = month >= 1 && month <= 12 &&
        day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (!validCalendarDay ||
        Number(hourText) > 23 ||
        Number(minuteText) > 59 ||
        Number(secondText) > 59 ||
        (offsetHourText !== undefined && Number(offsetHourText) > 23) ||
        (offsetMinuteText !== undefined && Number(offsetMinuteText) > 59) ||
        !Number.isFinite(Date.parse(text)))
        throw coded(code);
    return text;
}
function assertSnapshotShape(value) {
    for (const field of SNAPSHOT_FIELDS) {
        if (!(field in value) || value[field] === undefined)
            throw coded('QUOTE_REPOSITORY_QUOTE_INVALID');
    }
    if (!Array.isArray(value.selectedOptionIds) || !Array.isArray(value.optionPriceSnapshot)) {
        throw coded('QUOTE_REPOSITORY_QUOTE_INVALID');
    }
    if (!record(value.vehiclePriceSnapshot) || !record(value.conditionSnapshot) || !record(value.calculationProvenance)) {
        throw coded('QUOTE_REPOSITORY_QUOTE_INVALID');
    }
    if (value.calculationProvenance.verified !== true) {
        throw coded('QUOTE_PRICING_ENGINE_UNVERIFIED');
    }
}
export function quoteSnapshotFromIssuedQuote(quote) {
    const source = quote;
    assertSnapshotShape(source);
    return {
        contract: QUOTE_SNAPSHOT_CONTRACT_V2,
        ...Object.fromEntries(SNAPSHOT_FIELDS.map((field) => [field, source[field]])),
    };
}
export function assertIssuedQuoteV2(value) {
    if (!record(value) || value.contract !== QUOTE_CONTRACT_V2) {
        throw coded('QUOTE_REPOSITORY_QUOTE_INVALID');
    }
    const quoteId = requiredId(value.quoteId, 'QUOTE_REPOSITORY_QUOTE_INVALID');
    const quoteVersion = positiveInteger(value.quoteVersion, 'QUOTE_REPOSITORY_QUOTE_INVALID');
    iso(value.createdAt, 'QUOTE_REPOSITORY_QUOTE_INVALID');
    const snapshotHash = sha256(value.snapshotHash, 'QUOTE_REPOSITORY_QUOTE_INVALID');
    const snapshot = quoteSnapshotFromIssuedQuote(value);
    if (estimateArtifactDigest(snapshot) !== snapshotHash) {
        throw coded('QUOTE_V2_INTEGRITY_MISMATCH');
    }
    if (quoteVersion === 1) {
        if (quoteId !== `q_${snapshotHash.slice(0, 24)}` || value.revision != null || value.revisionHash != null) {
            throw coded('QUOTE_V2_INTEGRITY_MISMATCH');
        }
        return;
    }
    if (!record(value.revision) || value.revision.contract !== QUOTE_REVISION_CONTRACT_V1) {
        throw coded('QUOTE_REVISION_INVALID');
    }
    if (positiveInteger(value.revision.previousQuoteVersion, 'QUOTE_REVISION_INVALID') !== quoteVersion - 1) {
        throw coded('QUOTE_REVISION_INVALID');
    }
    sha256(value.revision.previousSnapshotHash, 'QUOTE_REVISION_INVALID');
    if (value.revision.previousRevisionHash != null) {
        sha256(value.revision.previousRevisionHash, 'QUOTE_REVISION_INVALID');
    }
    const revisionHash = sha256(value.revisionHash, 'QUOTE_REVISION_INVALID');
    if (revisionHash !== estimateArtifactDigest({
        contract: QUOTE_REVISION_CONTRACT_V1,
        quoteId,
        quoteVersion,
        snapshotHash,
        revision: value.revision,
    })) {
        throw coded('QUOTE_REVISION_INVALID');
    }
}
export function quoteIdempotencyKey(quote) {
    assertIssuedQuoteV2(quote);
    return `${quote.quoteId}:v${quote.quoteVersion}:${quote.snapshotHash}`;
}
function quoteRef(value) {
    if (!record(value))
        throw coded('SHARE_ENVELOPE_INVALID');
    return {
        quoteId: requiredId(value.quoteId, 'SHARE_ENVELOPE_INVALID'),
        quoteVersion: positiveInteger(value.quoteVersion, 'SHARE_ENVELOPE_INVALID'),
        snapshotHash: sha256(value.snapshotHash, 'SHARE_ENVELOPE_INVALID'),
    };
}
export function assertShareEnvelopeV1(value) {
    if (!record(value) || value.contract !== SHARE_ENVELOPE_CONTRACT) {
        throw coded('SHARE_ENVELOPE_INVALID');
    }
    requiredId(value.envelopeId, 'SHARE_ENVELOPE_INVALID');
    if (positiveInteger(value.envelopeVersion, 'SHARE_ENVELOPE_INVALID') !== 1) {
        throw coded('SHARE_ENVELOPE_VERSION_UNSUPPORTED');
    }
    const createdAt = iso(value.createdAt, 'SHARE_ENVELOPE_INVALID');
    const expiresAt = iso(value.expiresAt, 'SHARE_ENVELOPE_INVALID');
    if (Date.parse(expiresAt) <= Date.parse(createdAt))
        throw coded('SHARE_ENVELOPE_INVALID');
    if (!Array.isArray(value.quoteRefs) ||
        value.quoteRefs.length < 1 ||
        value.quoteRefs.length > MAX_SHARE_ENVELOPE_QUOTE_REFS)
        throw coded('SHARE_ENVELOPE_INVALID');
    const refs = value.quoteRefs.map(quoteRef);
    if (new Set(refs.map((item) => item.quoteId)).size !== refs.length) {
        throw coded('SHARE_ENVELOPE_INVALID');
    }
    const snapshotHash = sha256(value.snapshotHash, 'SHARE_ENVELOPE_INVALID');
    const snapshot = {
        contract: SHARE_ENVELOPE_SNAPSHOT_CONTRACT,
        quoteRefs: refs,
        expiresAt,
    };
    if (estimateArtifactDigest(snapshot) !== snapshotHash) {
        throw coded('SHARE_ENVELOPE_INTEGRITY_MISMATCH');
    }
    if (value.envelopeId !== `se_${snapshotHash.slice(0, 24)}`) {
        throw coded('SHARE_ENVELOPE_INTEGRITY_MISMATCH');
    }
}
export function shareEnvelopeIdempotencyKey(envelope) {
    assertShareEnvelopeV1(envelope);
    return `${envelope.envelopeId}:v${envelope.envelopeVersion}:${envelope.snapshotHash}`;
}
export function assertQuotePutCommand(value, headerIdempotencyKey) {
    if (!record(value) || value.command !== 'PUT_ISSUED_QUOTE' || value.contract !== QUOTE_REPOSITORY_CONTRACT) {
        throw coded('QUOTE_REPOSITORY_COMMAND_INVALID');
    }
    assertIssuedQuoteV2(value.quote);
    const key = quoteIdempotencyKey(value.quote);
    if (String(value.idempotencyKey ?? '').trim() !== key || String(headerIdempotencyKey ?? '').trim() !== key) {
        throw coded('QUOTE_REPOSITORY_CONFLICT');
    }
}
export function assertShareEnvelopePutCommand(value, headerIdempotencyKey) {
    if (!record(value) || value.command !== 'PUT_SHARE_ENVELOPE' || value.contract !== SHARE_ENVELOPE_REPOSITORY_CONTRACT) {
        throw coded('SHARE_ENVELOPE_COMMAND_INVALID');
    }
    assertShareEnvelopeV1(value.envelope);
    const key = shareEnvelopeIdempotencyKey(value.envelope);
    if (String(value.idempotencyKey ?? '').trim() !== key || String(headerIdempotencyKey ?? '').trim() !== key) {
        throw coded('SHARE_ENVELOPE_CONFLICT');
    }
}
export function normalizedArtifactVersion(value, code) {
    if (value === undefined || value === null || value === '')
        return null;
    return positiveInteger(value, code);
}
