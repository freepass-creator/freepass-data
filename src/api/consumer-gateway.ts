import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import catalogSchema from '../../contracts/catalog-v1.schema.json' with { type: 'json' };
import erpViewSchema from '../../contracts/erp-public-view-v1.schema.json' with { type: 'json' };
import healthSchema from '../../contracts/catalog-data-health-v1.schema.json' with { type: 'json' };
import type { ProjectionStore } from '../ports/catalog-store.js';
import { readCatalogDataHealth } from '../application/catalog-health.js';
import { DataAccessGateway } from '../application/data-access-gateway.js';
import { DataAccessAuditUnavailableError } from '../domain/data-access.js';
import { stableDigest } from '../shared/stable-digest.js';

export type ConsumerCapability = 'catalog' | 'catalog-health';
export type ConsumerBinding = {
  id: string;
  projectionId: 'erp-public';
  token: string;
  capabilities?: ConsumerCapability[];
};
type RegisteredConsumerBinding = Omit<ConsumerBinding, 'capabilities'> & {
  capabilities: ConsumerCapability[];
};
type CatalogDataHealthStore =
  Parameters<typeof readCatalogDataHealth>[0] &
  Parameters<typeof readCatalogDataHealth>[1];

/** Server-owned registrations; a request can never select a collection or projection. */
export function parseConsumerBindings(raw: string | undefined): RegisteredConsumerBinding[] {
  if (!raw) throw new Error('FREEPASS_DATA_CONSUMERS_JSON is required');
  const entries: unknown = JSON.parse(raw);
  if (!Array.isArray(entries) || !entries.length) throw new Error('Consumer registrations must be a non-empty array');
  const ids = new Set<string>();
  const tokens = new Set<string>();
  return entries.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid consumer registration');
    const item = entry as Record<string, unknown>;
    // F01/F86/Admin need their own complete contracts; never silently map them to ERP.
    if (typeof item.id !== 'string' || !/^(erp-com|kakao-ops|whitelabel-[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(item.id)) {
      throw new Error('Consumer contract is not implemented for this registration');
    }
    if (item.projectionId !== 'erp-public') throw new Error('Unsupported consumer projection');
    if (typeof item.token !== 'string' || item.token.trim() !== item.token || item.token.length < 32) {
      throw new Error('Each consumer needs a distinct service token of at least 32 characters');
    }
    if (ids.has(item.id) || tokens.has(item.token)) throw new Error('Duplicate consumer ID or shared service token');
    const capabilities: ConsumerCapability[] = item.capabilities === undefined
      ? ['catalog']
      : (() => {
          if (!Array.isArray(item.capabilities) || item.capabilities.length === 0) {
            throw new Error('Consumer capabilities must be a non-empty array');
          }
          const allowed = new Set<ConsumerCapability>(['catalog', 'catalog-health']);
          const values = item.capabilities.map((value) => {
            if (typeof value !== 'string' || !allowed.has(value as ConsumerCapability)) {
              throw new Error('Unsupported consumer capability');
            }
            return value as ConsumerCapability;
          });
          if (new Set(values).size !== values.length) {
            throw new Error('Duplicate consumer capability');
          }
          return values;
        })();
    ids.add(item.id);
    tokens.add(item.token);
    return {
      id: item.id,
      projectionId: item.projectionId,
      token: item.token,
      capabilities
    };
  });
}

const hash = (value: string) => createHash('sha256').update(value).digest();
const addFormats = (
  typeof addFormatsModule === 'function'
    ? addFormatsModule
    : (addFormatsModule as unknown as { default: FormatsPlugin }).default
) as FormatsPlugin;
class ConsumerReadError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number
  ) {
    super(code);
  }
}

const consumerContext = (
  consumerId: string,
  purpose: string,
  requestId: string
) => ({
  actor: { id: `consumer:${consumerId}`, kind: 'SERVICE' as const },
  clientId: consumerId,
  purpose,
  requestId
});

export function createConsumerGateway(
  store: Pick<ProjectionStore, 'getActive' | 'getManifest'>,
  bindings: ConsumerBinding[],
  access: DataAccessGateway,
  healthStore?: CatalogDataHealthStore,
) {
  // Validate again for callers constructing registrations without the environment parser.
  const registered = new Map(parseConsumerBindings(JSON.stringify(bindings)).map((item) => [item.id, item]));
  const app = Fastify({ logger: false });
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  ajv.addSchema(catalogSchema);
  const validateData = ajv.compile(erpViewSchema);
  const validateHealth = ajv.compile(healthSchema);
  app.get('/health', async () => ({ service: 'freepass-data-consumer-gateway', status: 'SERVING', readiness: 'NOT_ASSERTED' }));
  app.get<{ Params: { consumerId: string } }>('/v1/consumers/:consumerId/catalog', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const binding = registered.get(request.params.consumerId);
    const supplied = request.headers.authorization ?? '';
    const matches = timingSafeEqual(hash(supplied), hash(binding ? `Bearer ${binding.token}` : 'unregistered-consumer'));
    const context = consumerContext(
      binding?.id ?? request.params.consumerId,
      'read approved catalog projection through FreePass Data',
      request.id
    );
    const resource = {
      kind: 'PROJECTION' as const,
      name: binding?.projectionId ?? 'unregistered',
      ...(binding ? { projectionId: binding.projectionId } : {})
    };

    try {
      if (!binding || !matches) {
        await access.deny('READ', {
          context,
          operation: 'READ_CONSUMER_CATALOG',
          resource
        }, 'UNAUTHORIZED');
        return reply.code(401).send({ code: 'UNAUTHORIZED' });
      }
      if (!binding.capabilities.includes('catalog')) {
        await access.deny('READ', {
          context,
          operation: 'READ_CONSUMER_CATALOG',
          resource
        }, 'FORBIDDEN');
        return reply.code(403).send({ code: 'FORBIDDEN' });
      }

      const result = await access.read({
        context,
        operation: 'READ_CONSUMER_CATALOG',
        resource,
        summarize: (value: {
          data: unknown[];
          meta: { dataDigest: string; releaseId: string; manifestId: string; revision: number };
        }) => ({
          count: value.data.length,
          digest: value.meta.dataDigest,
          releaseId: value.meta.releaseId,
          manifestId: value.meta.manifestId,
          revision: value.meta.revision
        })
      }, async () => {
        const release = await store.getActive(binding.projectionId);
        if (!release) throw new ConsumerReadError('NO_ACTIVE_RELEASE', 503);
        if (release.schemaVersion !== '1.0.0' || !validateData(release.data)) {
          throw new ConsumerReadError('UNSUPPORTED_OR_INCOMPLETE_RELEASE', 503);
        }
        const manifest = await store.getManifest(release.releaseId);
        if (release.status !== 'ACTIVE' || release.projectionId !== binding.projectionId ||
          !manifest || manifest.releaseId !== release.releaseId || manifest.projectionId !== release.projectionId ||
          manifest.manifestId !== release.manifestId || manifest.schemaVersion !== release.schemaVersion ||
          manifest.productCount !== release.data.length || manifest.offerCount !== release.data.reduce((count, row) => count + row.offers.length, 0) ||
          manifest.inputDigest !== release.inputDigest || manifest.dataDigest !== release.dataDigest ||
          stableDigest(manifest.canonicalInputs) !== release.inputDigest || stableDigest(release.data) !== release.dataDigest ||
          !release.activatedAt || !Number.isFinite(Date.parse(release.activatedAt))) {
          throw new ConsumerReadError('RELEASE_EVIDENCE_MISMATCH', 503);
        }
        return {
          data: release.data,
          meta: {
            consumerId: binding.id, projectionId: release.projectionId,
            authority: 'CANONICAL_ACTIVE' as const,
            schemaVersion: release.schemaVersion, releaseId: release.releaseId,
            manifestId: release.manifestId, inputDigest: release.inputDigest, dataDigest: release.dataDigest,
            revision: release.canonicalRevision, generatedAt: release.generatedAt, activatedAt: release.activatedAt,
          },
        };
      });
      return result;
    } catch (error) {
      if (error instanceof ConsumerReadError) {
        return reply.code(error.statusCode).send({ code: error.code });
      }
      if (error instanceof DataAccessAuditUnavailableError) {
        return reply.code(503).send({ code: error.code });
      }
      return reply.code(503).send({ code: 'CATALOG_READ_FAILED' });
    }
  });
  app.get<{ Params: { consumerId: string } }>('/v1/consumers/:consumerId/catalog-health', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const binding = registered.get(request.params.consumerId);
    const supplied = request.headers.authorization ?? '';
    const matches = timingSafeEqual(
      hash(supplied),
      hash(binding ? `Bearer ${binding.token}` : 'unregistered-consumer')
    );
    const context = consumerContext(
      binding?.id ?? request.params.consumerId,
      'read catalog health through FreePass Data',
      request.id
    );
    const resource = {
      kind: 'HEALTH' as const,
      name: 'catalog-data-health',
      ...(binding ? { projectionId: binding.projectionId } : {})
    };

    try {
      if (!binding || !matches) {
        await access.deny('READ', {
          context,
          operation: 'READ_CATALOG_HEALTH',
          resource
        }, 'UNAUTHORIZED');
        return reply.code(401).send({ code: 'UNAUTHORIZED' });
      }
      if (!binding.capabilities.includes('catalog-health')) {
        await access.deny('READ', {
          context,
          operation: 'READ_CATALOG_HEALTH',
          resource
        }, 'FORBIDDEN');
        return reply.code(403).send({ code: 'FORBIDDEN' });
      }
      if (!healthStore) {
        await access.deny('READ', {
          context,
          operation: 'READ_CATALOG_HEALTH',
          resource
        }, 'HEALTH_READER_UNAVAILABLE');
        return reply.code(503).send({ code: 'HEALTH_READER_UNAVAILABLE' });
      }

      const report = await access.read({
        context,
        operation: 'READ_CATALOG_HEALTH',
        resource,
        summarize: (value: { issues: unknown[] }) => ({
          count: value.issues.length,
          digest: stableDigest(value)
        })
      }, async () => {
        const value = await readCatalogDataHealth(healthStore, healthStore);
        if (!validateHealth(value)) {
          throw new ConsumerReadError('HEALTH_CONTRACT_INVALID', 503);
        }
        return value;
      });

      return reply
        .code(report.status === 'BLOCKED' ? 503 : 200)
        .send(report);
    } catch (error) {
      if (error instanceof ConsumerReadError) {
        return reply.code(error.statusCode).send({ code: error.code });
      }
      if (error instanceof DataAccessAuditUnavailableError) {
        return reply.code(503).send({ code: error.code });
      }
      return reply.code(503).send({ code: 'HEALTH_READ_FAILED' });
    }
  });
  return app;
}
