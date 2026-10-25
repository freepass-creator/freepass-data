import { stableDigest } from '../shared/stable-digest.js';
export const ADMIN_WORKFLOW_RESOURCES = {
    products: true,
    policies: true,
    vehicleMaster: true,
    settlementRows: true,
    settlementEvents: true,
    settlementInvoices: true,
    settlementCashEvents: true,
    settlementClawbacks: true,
    settlementFeeRules: true,
    settlementRules: true,
    partners: true,
    contracts: true,
    contractEvents: true,
    esignSessions: true,
    esignPrivate: true,
    esignEvents: true,
    esignIssueLocks: true,
};
export const ADMIN_WORKFLOW_RESOURCE_POLICIES = {
    products: { semanticOwner: 'FREEPASS_DATA_CATALOG', writeThroughGateway: false },
    policies: { semanticOwner: 'FREEPASS_DATA_CATALOG', writeThroughGateway: false },
    vehicleMaster: { semanticOwner: 'FREEPASS_DATA_CATALOG', writeThroughGateway: false },
    partners: { semanticOwner: 'FREEPASS_DATA_REFERENCE', writeThroughGateway: false },
    settlementRows: { semanticOwner: 'FREEPASS_DATA_SETTLEMENT', writeThroughGateway: true },
    settlementEvents: { semanticOwner: 'FREEPASS_DATA_SETTLEMENT', writeThroughGateway: true },
    settlementInvoices: { semanticOwner: 'FREEPASS_DATA_SETTLEMENT', writeThroughGateway: true },
    settlementCashEvents: { semanticOwner: 'FREEPASS_DATA_SETTLEMENT', writeThroughGateway: true },
    settlementClawbacks: { semanticOwner: 'FREEPASS_DATA_SETTLEMENT', writeThroughGateway: true },
    settlementFeeRules: { semanticOwner: 'FREEPASS_DATA_SETTLEMENT', writeThroughGateway: true },
    settlementRules: { semanticOwner: 'FREEPASS_DATA_SETTLEMENT', writeThroughGateway: true },
    contracts: { semanticOwner: 'FREEPASS_ADMIN_APPLICATION_CONTRACT', writeThroughGateway: true },
    contractEvents: { semanticOwner: 'FREEPASS_ADMIN_APPLICATION_CONTRACT', writeThroughGateway: true },
    esignSessions: { semanticOwner: 'FREEPASS_ADMIN_APPLICATION_CONTRACT', writeThroughGateway: true },
    esignPrivate: { semanticOwner: 'FREEPASS_ADMIN_APPLICATION_CONTRACT', writeThroughGateway: true },
    esignEvents: { semanticOwner: 'FREEPASS_ADMIN_APPLICATION_CONTRACT', writeThroughGateway: true },
    esignIssueLocks: { semanticOwner: 'FREEPASS_ADMIN_APPLICATION_CONTRACT', writeThroughGateway: true },
};
export function adminWorkflowSemanticOwners(request) {
    return [...new Set(request.mutations.map((mutation) => ADMIN_WORKFLOW_RESOURCE_POLICIES[mutation.resource].semanticOwner))].sort();
}
const id = (value, max = 256) => typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && !/[\u0000-\u001f\u007f]/.test(value);
const field = (value) => typeof value === 'string'
    && /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/.test(value);
export function assertAdminWorkflowReadSpec(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('INVALID_ADMIN_WORKFLOW_READ');
    const v = value;
    if (v.view !== undefined && (v.view !== 'current-facts/v1' || !['settlementRows', 'contracts'].includes(String(v.resource)))) {
        throw new Error('INVALID_ADMIN_WORKFLOW_VIEW');
    }
    if (v.view && v.kind === 'query' && v.limit === undefined)
        throw new Error('INVALID_ADMIN_WORKFLOW_VIEW_LIMIT_REQUIRED');
    if (typeof v.resource !== 'string' || !(v.resource in ADMIN_WORKFLOW_RESOURCES))
        throw new Error('INVALID_ADMIN_WORKFLOW_RESOURCE');
    if (v.kind === 'doc') {
        if (!id(v.id))
            throw new Error('INVALID_ADMIN_WORKFLOW_DOCUMENT_ID');
        return;
    }
    if (v.kind !== 'query')
        throw new Error('INVALID_ADMIN_WORKFLOW_READ');
    if (v.limit !== undefined && (!Number.isSafeInteger(v.limit) || Number(v.limit) < 1 || Number(v.limit) > 5000)) {
        throw new Error('INVALID_ADMIN_WORKFLOW_LIMIT');
    }
    if (v.filters !== undefined) {
        if (!Array.isArray(v.filters) || v.filters.length > 8)
            throw new Error('INVALID_ADMIN_WORKFLOW_FILTER');
        for (const raw of v.filters) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw))
                throw new Error('INVALID_ADMIN_WORKFLOW_FILTER');
            const f = raw;
            if (!field(f.field) || f.op !== '==')
                throw new Error('INVALID_ADMIN_WORKFLOW_FILTER');
        }
    }
}
export function assertAdminWorkflowCommitRequest(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('INVALID_ADMIN_WORKFLOW_COMMIT');
    const v = value;
    if (!id(v.operationId, 200) || !id(v.actor, 256) || !id(v.purpose, 256)) {
        throw new Error('INVALID_ADMIN_WORKFLOW_COMMIT');
    }
    if (!Array.isArray(v.expectations) || v.expectations.length > 64)
        throw new Error('INVALID_ADMIN_WORKFLOW_EXPECTATIONS');
    for (const raw of v.expectations) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new Error('INVALID_ADMIN_WORKFLOW_EXPECTATIONS');
        const e = raw;
        assertAdminWorkflowReadSpec(e.spec);
        if (typeof e.digest !== 'string' || !/^[a-f0-9]{64}$/.test(e.digest)) {
            throw new Error('INVALID_ADMIN_WORKFLOW_EXPECTATION_DIGEST');
        }
    }
    if (!Array.isArray(v.mutations) || v.mutations.length < 1 || v.mutations.length > 128) {
        throw new Error('INVALID_ADMIN_WORKFLOW_MUTATIONS');
    }
    for (const raw of v.mutations) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new Error('INVALID_ADMIN_WORKFLOW_MUTATION');
        const m = raw;
        if (!['set', 'update', 'create'].includes(String(m.op)))
            throw new Error('INVALID_ADMIN_WORKFLOW_MUTATION');
        if (typeof m.resource !== 'string' || !(m.resource in ADMIN_WORKFLOW_RESOURCES) || !id(m.id)) {
            throw new Error('INVALID_ADMIN_WORKFLOW_MUTATION');
        }
        if (!m.data || typeof m.data !== 'object' || Array.isArray(m.data))
            throw new Error('INVALID_ADMIN_WORKFLOW_MUTATION');
        if (m.merge !== undefined && typeof m.merge !== 'boolean')
            throw new Error('INVALID_ADMIN_WORKFLOW_MUTATION');
        const policy = ADMIN_WORKFLOW_RESOURCE_POLICIES[m.resource];
        if (!policy.writeThroughGateway)
            throw new Error('ADMIN_WORKFLOW_RESOURCE_READ_ONLY');
        if (m.resource === 'settlementEvents' && Object.keys(m.data).some((key) => key.startsWith('aud_') && key.includes('.'))) {
            throw new Error('INVALID_ADMIN_WORKFLOW_AUDIT_FIELD_PATH');
        }
    }
    // A whole-document replacement is checked against the stored document, so no other
    // mutation in the same command may reshape that document first.
    const touches = new Map();
    for (const m of v.mutations) {
        const key = `${m.resource}/${m.id}`;
        touches.set(key, (touches.get(key) ?? 0) + 1);
    }
    for (const m of adminWorkflowReplacements(v.mutations)) {
        if (touches.get(`${m.resource}/${m.id}`) > 1)
            throw new Error('INVALID_ADMIN_WORKFLOW_REPLACEMENT_NOT_EXCLUSIVE');
    }
}
/** Existing audit objects are immutable; only new keys or identical retries are allowed. */
export function changedSettlementAuditKeys(stored, next) {
    return Object.keys(stored).filter((key) => key.startsWith('aud_')
        && (!Object.hasOwn(next, key) || stableDigest(stored[key]) !== stableDigest(next[key]))).sort();
}
/** `set` without merge replaces the whole stored document. */
export function adminWorkflowReplacements(mutations) {
    return mutations.filter((m) => m.op === 'set' && m.merge !== true);
}
/**
 * Data is retired by status, never erased: a replacement may change values but must keep
 * every top-level field of the stored document. Nested map keys are not checked yet (HOLD).
 */
export function droppedTopLevelFields(stored, next) {
    return Object.keys(stored).filter((key) => !Object.hasOwn(next, key)).sort();
}
