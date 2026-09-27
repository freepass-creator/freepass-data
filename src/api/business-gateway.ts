import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import type { DataAccessGateway } from '../application/data-access-gateway.js';
import type {
  BusinessReadRequest,
  BusinessWriteRequest,
  BusinessWriteReceipt,
} from '../infra/firebase-business-store.js';
import { stableDigest } from '../shared/stable-digest.js';

export type BusinessConsumerBinding = {
  id: 'freepass-admin' | 'freepass-sales' | 'freepass-sales-intake' | 'freepass-estimate' | 'erp-com';
  token: string;
  read: boolean;
  write: boolean;
};

export type BusinessStore = {
  read(input: BusinessReadRequest): Promise<{
    contract: 'freepass-data.business-read/v1';
    consumerId: string;
    resource: string;
    data: unknown;
    readAt: string;
  }>;
  write(input: BusinessWriteRequest): Promise<BusinessWriteReceipt>;
};

const allowedIds = new Set([
  'freepass-admin',
  'freepass-sales',
  'freepass-sales-intake',
  'freepass-estimate',
  'erp-com',
]);

export function parseBusinessBindings(raw: string | undefined): BusinessConsumerBinding[] {
  if (!raw) throw new Error('FREEPASS_DATA_BUSINESS_CONSUMERS_JSON is required');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Business consumer registrations are required');
  const ids = new Set<string>();
  const tokens = new Set<string>();
  return parsed.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid business consumer registration');
    const item = value as Record<string, unknown>;
    const id = String(item.id ?? '');
    const token = String(item.token ?? '');
    if (!allowedIds.has(id)) throw new Error('Unsupported business consumer');
    if (token.trim() !== token || token.length < 32) throw new Error('Business consumer token must be at least 32 characters');
    if (ids.has(id) || tokens.has(token)) throw new Error('Duplicate business consumer or shared token');
    if (typeof item.read !== 'boolean' || typeof item.write !== 'boolean' || (!item.read && !item.write)) {
      throw new Error('Business consumer requires read and/or write capability');
    }
    ids.add(id);
    tokens.add(token);
    return { id, token, read: item.read, write: item.write } as BusinessConsumerBinding;
  });
}

const hash = (value: string) => createHash('sha256').update(value).digest();

export function createBusinessGateway(
  store: BusinessStore,
  bindings: BusinessConsumerBinding[],
  access: DataAccessGateway,
) {
  const registered = new Map(parseBusinessBindings(JSON.stringify(bindings)).map((item) => [item.id, item]));
  const app = Fastify({ logger: false });

  app.get('/health', async () => ({
    service: 'freepass-data-business-gateway',
    status: 'SERVING',
    firebaseAuthority: 'FREEPASS_DATA_ONLY',
  }));

  app.get<{ Params: { consumerId: string; resource: string }; Querystring: { id?: string; parentId?: string; limit?: string } }>(
    '/v1/business/:consumerId/:resource',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const binding = registered.get(request.params.consumerId as BusinessConsumerBinding['id']);
      const supplied = request.headers.authorization ?? '';
      const authorized = timingSafeEqual(
        hash(supplied),
        hash(binding ? `Bearer ${binding.token}` : 'unregistered-business-consumer')
      );
      const context = {
        actor: { id: `consumer:${binding?.id ?? 'unregistered'}`, kind: 'SERVICE' as const },
        clientId: binding?.id ?? 'unregistered',
        purpose: 'read business data through FreePass Data exclusive Firebase authority',
        requestId: request.id,
      };
      const resource = {
        kind: 'SYSTEM' as const,
        name: request.params.resource,
      };

      if (!binding || !authorized) {
        await access.deny('READ', { context, operation: 'READ_BUSINESS_RESOURCE', resource }, 'UNAUTHORIZED');
        return reply.code(401).send({ code: 'UNAUTHORIZED' });
      }
      if (!binding.read) {
        await access.deny('READ', { context, operation: 'READ_BUSINESS_RESOURCE', resource }, 'FORBIDDEN');
        return reply.code(403).send({ code: 'FORBIDDEN' });
      }

      try {
        return await access.read({
          context,
          operation: 'READ_BUSINESS_RESOURCE',
          resource,
          requestDigest: stableDigest({
            resource: request.params.resource,
            id: request.query.id ?? null,
            parentId: request.query.parentId ?? null,
            limit: request.query.limit ?? null,
          }),
          summarize: (result) => ({
            count: Array.isArray(result.data) ? result.data.length : result.data == null ? 0 : 1,
            digest: stableDigest(result),
          }),
        }, () => store.read({
          consumerId: binding.id,
          resource: request.params.resource,
          ...(request.query.id ? { id: request.query.id } : {}),
          ...(request.query.parentId ? { parentId: request.query.parentId } : {}),
          ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
        }));
      } catch (error) {
        const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,99}$/.test(error.message)
          ? error.message
          : 'BUSINESS_READ_FAILED';
        return reply.code(code.includes('FORBIDDEN') ? 403 : 503).send({ code });
      }
    }
  );

  app.post<{ Params: { consumerId: string }; Body: Omit<BusinessWriteRequest, 'consumerId'> }>(
    '/v1/business/:consumerId/commands',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const binding = registered.get(request.params.consumerId as BusinessConsumerBinding['id']);
      const supplied = request.headers.authorization ?? '';
      const authorized = timingSafeEqual(
        hash(supplied),
        hash(binding ? `Bearer ${binding.token}` : 'unregistered-business-consumer')
      );
      const body = request.body as Omit<BusinessWriteRequest, 'consumerId'>;
      const context = {
        actor: { id: `consumer:${binding?.id ?? 'unregistered'}`, kind: 'SERVICE' as const },
        clientId: binding?.id ?? 'unregistered',
        purpose: 'write business data through FreePass Data exclusive Firebase authority',
        requestId: request.id,
        correlationId: String(body?.commandId ?? ''),
      };
      const resource = {
        kind: 'COMMAND' as const,
        name: 'BUSINESS_TRANSACTION',
      };

      if (!binding || !authorized) {
        await access.deny('WRITE', { context, operation: 'WRITE_BUSINESS_RESOURCE', resource }, 'UNAUTHORIZED');
        return reply.code(401).send({ code: 'UNAUTHORIZED' });
      }
      if (!binding.write) {
        await access.deny('WRITE', { context, operation: 'WRITE_BUSINESS_RESOURCE', resource }, 'FORBIDDEN');
        return reply.code(403).send({ code: 'FORBIDDEN' });
      }

      if (
        !body ||
        typeof body.commandId !== 'string' ||
        typeof body.idempotencyKey !== 'string' ||
        typeof body.reason !== 'string' ||
        !Array.isArray(body.operations)
      ) {
        await access.deny('WRITE', { context, operation: 'WRITE_BUSINESS_RESOURCE', resource }, 'INVALID_COMMAND');
        return reply.code(400).send({ code: 'INVALID_COMMAND' });
      }

      try {
        const input: BusinessWriteRequest = { ...body, consumerId: binding.id };
        return await access.write({
          context,
          operation: 'WRITE_BUSINESS_RESOURCE',
          resource,
          requestDigest: stableDigest(input),
          summarize: (receipt) => ({
            count: receipt.operationCount,
            digest: stableDigest(receipt),
          }),
        }, () => store.write(input));
      } catch (error) {
        const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,99}$/.test(error.message)
          ? error.message
          : 'BUSINESS_WRITE_FAILED';
        const status = code.includes('FORBIDDEN') ? 403
          : code.includes('INVALID') ? 400
          : code.includes('CONFLICT') || code.includes('IN_PROGRESS') ? 409
          : 503;
        return reply.code(status).send({ code });
      }
    }
  );

  return app;
}
