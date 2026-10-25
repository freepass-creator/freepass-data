export const SETTLEMENT_LEDGER_VIEW_CONTRACT = 'freepass-data.settlement-ledger/v1';
export const SETTLEMENT_LEDGER_FILTER_FIELDS = [
    'code',
    'plate',
    'receivedAt',
    'billMonth',
    'claimStage',
    'payStage',
    'supplierCode',
    'channelCode',
    'agent',
    'customer',
];
const safeId = (value) => typeof value === 'string'
    && value.trim() === value
    && value.length > 0
    && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value);
export function assertSettlementLedgerReadRequest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('INVALID_SETTLEMENT_LEDGER_READ');
    }
    const request = value;
    if (request.viewVersion !== undefined && request.viewVersion !== 1 && request.viewVersion !== 2) {
        throw new Error('INVALID_SETTLEMENT_LEDGER_READ');
    }
    if (request.kind === 'doc') {
        if (!safeId(request.id))
            throw new Error('INVALID_SETTLEMENT_LEDGER_DOCUMENT_ID');
        return;
    }
    if (request.kind !== 'query' || !Array.isArray(request.filters)) {
        throw new Error('INVALID_SETTLEMENT_LEDGER_READ');
    }
    if (request.filters.length < 1 || request.filters.length > 4) {
        throw new Error('SETTLEMENT_LEDGER_QUERY_REQUIRES_FILTER');
    }
    const allowed = new Set(SETTLEMENT_LEDGER_FILTER_FIELDS);
    for (const raw of request.filters) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('INVALID_SETTLEMENT_LEDGER_FILTER');
        }
        const filter = raw;
        if (!allowed.has(String(filter.field)) || !safeId(filter.value)) {
            throw new Error('INVALID_SETTLEMENT_LEDGER_FILTER');
        }
    }
    const fields = new Set(request.filters.map((raw) => raw.field));
    if (fields.has('agent') !== fields.has('customer')) {
        throw new Error('SETTLEMENT_LEDGER_PERSON_LOOKUP_REQUIRES_AGENT_AND_CUSTOMER');
    }
    if (request.limit !== undefined
        && (!Number.isSafeInteger(request.limit) || Number(request.limit) < 1 || Number(request.limit) > 100)) {
        throw new Error('INVALID_SETTLEMENT_LEDGER_LIMIT');
    }
}
