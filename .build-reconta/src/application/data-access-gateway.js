import { randomUUID } from 'node:crypto';
import { DataAccessAuditUnavailableError } from '../domain/data-access.js';
const bounded = (value, max) => value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const digest = (value) => value === undefined || /^[a-f0-9]{64}$/.test(value);
const timestamp = (value) => Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d{2}:\d{2})$/.test(value);
const resourceKinds = new Set([
    'CATALOG', 'PROJECTION', 'HEALTH', 'COMMAND', 'SOURCE', 'SYSTEM'
]);
function assertSpec(spec) {
    if (!bounded(spec.operation, 100) ||
        !/^[A-Z][A-Z0-9_]{2,99}$/.test(spec.operation) ||
        !bounded(spec.context.actor.id, 256) ||
        !['USER', 'SERVICE'].includes(spec.context.actor.kind) ||
        (spec.context.actor.organizationId !== undefined &&
            spec.context.actor.organizationId !== null &&
            !bounded(spec.context.actor.organizationId, 256)) ||
        !bounded(spec.context.clientId, 128) ||
        !bounded(spec.context.purpose, 256) ||
        !resourceKinds.has(spec.resource.kind) ||
        !bounded(spec.resource.name, 256) ||
        !digest(spec.requestDigest)) {
        throw new Error('INVALID_DATA_ACCESS_SPEC');
    }
    for (const value of [
        spec.context.requestId,
        spec.context.correlationId,
        spec.resource.entityType,
        spec.resource.entityId,
        spec.resource.projectionId
    ]) {
        if (value !== undefined && !bounded(value, 256)) {
            throw new Error('INVALID_DATA_ACCESS_SPEC');
        }
    }
}
function assertResultEvidence(result) {
    if (!result)
        return;
    if ((result.count !== undefined && (!Number.isSafeInteger(result.count) || result.count < 0)) ||
        (result.revision !== undefined && (!Number.isSafeInteger(result.revision) || result.revision < 0)) ||
        !digest(result.digest) ||
        !digest(result.inputDigest)) {
        throw new Error('INVALID_DATA_ACCESS_RESULT_EVIDENCE');
    }
    for (const value of [result.releaseId, result.manifestId]) {
        if (value !== undefined && !bounded(value, 256)) {
            throw new Error('INVALID_DATA_ACCESS_RESULT_EVIDENCE');
        }
    }
}
const codeOf = (error) => {
    if (error && typeof error === 'object' && 'code' in error) {
        const code = error.code;
        if (typeof code === 'string' && bounded(code, 100) && /^[A-Z][A-Z0-9_]{2,99}$/.test(code))
            return code;
    }
    if (error instanceof Error && bounded(error.message, 100) && /^[A-Z][A-Z0-9_]{2,99}$/.test(error.message)) {
        return error.message;
    }
    return 'UNCLASSIFIED_ACCESS_FAILURE';
};
export class DataAccessGateway {
    logs;
    now;
    id;
    constructor(logs, now = () => new Date().toISOString(), id = () => randomUUID()) {
        this.logs = logs;
        this.now = now;
        this.id = id;
    }
    async append(event) {
        try {
            await this.logs.appendDataAccessEvent(event);
        }
        catch {
            throw new DataAccessAuditUnavailableError('Data access audit could not be persisted; data access was not authorized to proceed');
        }
    }
    base(mode, spec, operationId, startedAt) {
        return {
            contractVersion: 'data-access-event-v1',
            operationId,
            mode,
            operation: spec.operation,
            actor: structuredClone(spec.context.actor),
            clientId: spec.context.clientId,
            purpose: spec.context.purpose,
            resource: structuredClone(spec.resource),
            ...(spec.context.requestId ? { requestId: spec.context.requestId } : {}),
            ...(spec.context.correlationId ? { correlationId: spec.context.correlationId } : {}),
            ...(spec.requestDigest ? { requestDigest: spec.requestDigest } : {}),
            startedAt
        };
    }
    async deny(mode, spec, reasonCode) {
        assertSpec(spec);
        if (!bounded(reasonCode, 100) || !/^[A-Z][A-Z0-9_]{2,99}$/.test(reasonCode)) {
            throw new Error('INVALID_DATA_ACCESS_REASON');
        }
        const operationId = this.id();
        const eventId = this.id();
        const startedAt = this.now();
        const occurredAt = this.now();
        if (!bounded(operationId, 256) ||
            !bounded(eventId, 256) ||
            !timestamp(startedAt) ||
            !timestamp(occurredAt)) {
            throw new Error('INVALID_DATA_ACCESS_EVENT_METADATA');
        }
        await this.append({
            eventId,
            ...this.base(mode, spec, operationId, startedAt),
            phase: 'DENIED',
            reasonCode,
            occurredAt
        });
    }
    async execute(mode, spec, run) {
        assertSpec(spec);
        const operationId = this.id();
        const startedAt = this.now();
        if (!bounded(operationId, 256) || !timestamp(startedAt)) {
            throw new Error('INVALID_DATA_ACCESS_EVENT_METADATA');
        }
        const base = this.base(mode, spec, operationId, startedAt);
        // Fail closed before touching the underlying data source.
        const startedEventId = this.id();
        if (!bounded(startedEventId, 256)) {
            throw new Error('INVALID_DATA_ACCESS_EVENT_METADATA');
        }
        await this.append({
            eventId: startedEventId,
            ...base,
            phase: 'STARTED',
            occurredAt: startedAt
        });
        try {
            const result = await run();
            const summary = spec.summarize?.(result);
            assertResultEvidence(summary);
            const eventId = this.id();
            const occurredAt = this.now();
            if (!bounded(eventId, 256) || !timestamp(occurredAt)) {
                throw new Error('INVALID_DATA_ACCESS_EVENT_METADATA');
            }
            await this.append({
                eventId,
                ...base,
                phase: 'SUCCEEDED',
                ...(summary ? { result: summary } : {}),
                occurredAt
            });
            return result;
        }
        catch (error) {
            const eventId = this.id();
            const occurredAt = this.now();
            if (!bounded(eventId, 256) || !timestamp(occurredAt)) {
                throw new Error('INVALID_DATA_ACCESS_EVENT_METADATA');
            }
            await this.append({
                eventId,
                ...base,
                phase: 'FAILED',
                reasonCode: codeOf(error),
                occurredAt
            });
            throw error;
        }
    }
    read(spec, run) {
        return this.execute('READ', spec, run);
    }
    write(spec, run) {
        return this.execute('WRITE', spec, run);
    }
}
