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
      await this.append({
        eventId: this.id(),
        ...base,
        phase: 'SUCCEEDED',
        ...(spec.summarize ? { result: spec.summarize(result) } : {}),
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
