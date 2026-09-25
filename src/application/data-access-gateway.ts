import { randomUUID } from 'node:crypto';
import type {
  DataAccessContext,
  DataAccessEvent,
  DataAccessMode,
  DataAccessResource,
  DataAccessResultEvidence
} from '../domain/data-access.js';
import { DataAccessAuditUnavailableError } from '../domain/data-access.js';
import type { DataAccessLogStore } from '../ports/data-access.js';

type AccessSpec<T> = {
  context: DataAccessContext;
  operation: string;
  resource: DataAccessResource;
  requestDigest?: string;
  summarize?: (result: T) => DataAccessResultEvidence | undefined;
};

const bounded = (value: string, max: number) =>
  value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const digest = (value: string | undefined) =>
  value === undefined || /^[a-f0-9]{64}$/.test(value);

function assertSpec<T>(spec: AccessSpec<T>) {
  if (
    !bounded(spec.operation, 100) ||
    !/^[A-Z][A-Z0-9_]{2,99}$/.test(spec.operation) ||
    !bounded(spec.context.actor.id, 256) ||
    !['USER', 'SERVICE'].includes(spec.context.actor.kind) ||
    (spec.context.actor.organizationId !== undefined &&
      spec.context.actor.organizationId !== null &&
      !bounded(spec.context.actor.organizationId, 256)) ||
    !bounded(spec.context.clientId, 128) ||
    !bounded(spec.context.purpose, 256) ||
    !bounded(spec.resource.name, 256) ||
    !digest(spec.requestDigest)
  ) {
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

function assertResultEvidence(result: DataAccessResultEvidence | undefined) {
  if (!result) return;
  if (
    (result.count !== undefined && (!Number.isSafeInteger(result.count) || result.count < 0)) ||
    (result.revision !== undefined && (!Number.isSafeInteger(result.revision) || result.revision < 0)) ||
    !digest(result.digest)
  ) {
    throw new Error('INVALID_DATA_ACCESS_RESULT_EVIDENCE');
  }
  for (const value of [result.releaseId, result.manifestId]) {
    if (value !== undefined && !bounded(value, 256)) {
      throw new Error('INVALID_DATA_ACCESS_RESULT_EVIDENCE');
    }
  }
}

const codeOf = (error: unknown) => {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,100}$/.test(code)) return code;
  }
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,100}$/.test(error.message)) {
    return error.message;
  }
  return 'UNCLASSIFIED_ACCESS_FAILURE';
};

export class DataAccessGateway {
  constructor(
    private readonly logs: DataAccessLogStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly id: () => string = () => randomUUID()
  ) {}

  private async append(event: DataAccessEvent) {
    try {
      await this.logs.appendDataAccessEvent(event);
    } catch {
      throw new DataAccessAuditUnavailableError(
        'Data access audit could not be persisted; data access was not authorized to proceed'
      );
    }
  }

  private base<T>(
    mode: DataAccessMode,
    spec: AccessSpec<T>,
    operationId: string,
    startedAt: string
  ) {
    return {
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

  async deny<T>(mode: DataAccessMode, spec: AccessSpec<T>, reasonCode: string) {
    assertSpec(spec);
    if (!bounded(reasonCode, 100) || !/^[A-Z][A-Z0-9_]{2,99}$/.test(reasonCode)) {
      throw new Error('INVALID_DATA_ACCESS_REASON');
    }
    const operationId = this.id();
    const startedAt = this.now();
    await this.append({
      eventId: this.id(),
      ...this.base(mode, spec, operationId, startedAt),
      phase: 'DENIED',
      reasonCode,
      occurredAt: this.now()
    });
  }

  private async execute<T>(
    mode: DataAccessMode,
    spec: AccessSpec<T>,
    run: () => Promise<T>
  ): Promise<T> {
    assertSpec(spec);
    const operationId = this.id();
    const startedAt = this.now();
    const base = this.base(mode, spec, operationId, startedAt);

    // Fail closed before touching the underlying data source.
    await this.append({
      eventId: this.id(),
      ...base,
      phase: 'STARTED',
      occurredAt: startedAt
    });

    try {
      const result = await run();
      const summary = spec.summarize?.(result);
      assertResultEvidence(summary);
      await this.append({
        eventId: this.id(),
        ...base,
        phase: 'SUCCEEDED',
        ...(summary ? { result: summary } : {}),
        occurredAt: this.now()
      });
      return result;
    } catch (error) {
      await this.append({
        eventId: this.id(),
        ...base,
        phase: 'FAILED',
        reasonCode: codeOf(error),
        occurredAt: this.now()
      });
      throw error;
    }
  }

  read<T>(spec: AccessSpec<T>, run: () => Promise<T>) {
    return this.execute('READ', spec, run);
  }

  write<T>(spec: AccessSpec<T>, run: () => Promise<T>) {
    return this.execute('WRITE', spec, run);
  }
}
