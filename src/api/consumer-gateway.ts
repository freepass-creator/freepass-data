import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import catalogSchema from '../../contracts/catalog-v1.schema.json' with { type: 'json' };
import erpViewSchema from '../../contracts/erp-public-view-v1.schema.json' with { type: 'json' };
import adminCatalogSchema from '../../contracts/admin-catalog-view-v1.schema.json' with { type: 'json' };
import healthSchema from '../../contracts/catalog-data-health-v1.schema.json' with { type: 'json' };
import type { ProjectionStore } from '../ports/catalog-store.js';
import type { AdminCatalogProduct, ProjectionProduct } from '../domain/catalog.js';
import { readCatalogDataHealth } from '../application/catalog-health.js';
import { stableDigest } from '../shared/stable-digest.js';

export type ConsumerCapability = 'catalog' | 'catalog-health';
export type ConsumerProjectionId = 'erp-public' | 'admin-catalog';
export type ConsumerBinding = {
  id: string;
  projectionId: ConsumerProjectionId;
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
    // Consumer identity determines projection; callers cannot select another product contract.
    const expectedProjection: ConsumerProjectionId | null =
      item.id === 'freepass-admin-catalog'
        ? 'admin-catalog'
        : typeof item.id === 'string' && /^(erp-com|kakao-ops|whitelabel-[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(item.id)
          ? 'erp-public'
          : null;
    if (!expectedProjection) {
      throw new Error('Consumer contract is not implemented for this registration');
    }
    if (item.projectionId !== expectedProjection) {
      throw new Error('Consumer projection does not match the registered contract');
    }
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
export function createConsumerGateway(
  store: Pick<ProjectionStore, 'getActive' | 'getManifest'>,
  bindings: ConsumerBinding[],
  healthStore?: CatalogDataHealthStore,
) {
  // Validate again for callers constructing registrations without the environment parser.
  const registered = new Map(parseConsumerBindings(JSON.stringify(bindings)).map((item) => [item.id, item]));
  const app = Fastify({ logger: false });
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  ajv.addSchema(catalogSchema);
  const validateErpData = ajv.compile(erpViewSchema);
  const validateAdminResponse = ajv.compile(adminCatalogSchema);
  const validateHealth = ajv.compile(healthSchema);
  app.get('/health', async () => ({ service: 'freepass-data-consumer-gateway', status: 'SERVING', readiness: 'NOT_ASSERTED' }));
  app.get<{ Params: { consumerId: string } }>('/v1/consumers/:consumerId/catalog', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const binding = registered.get(request.params.consumerId);
    const supplied = request.headers.authorization ?? '';
    const matches = timingSafeEqual(hash(supplied), hash(binding ? `Bearer ${binding.token}` : 'unregistered-consumer'));
    if (!binding || !matches) {
      return reply.code(401).send({ code: 'UNAUTHORIZED' });
    }
    if (!binding.capabilities.includes('catalog')) {
      return reply.code(403).send({ code: 'FORBIDDEN' });
    }
    const release = await store.getActive<ProjectionProduct>(binding.projectionId);
    if (!release) return reply.code(503).send({ code: 'NO_ACTIVE_RELEASE' });
    const manifest = await store.getManifest(release.releaseId);
    if (release.status !== 'ACTIVE' || release.projectionId !== binding.projectionId ||
      release.schemaVersion !== '1.0.0' ||
      !manifest || manifest.releaseId !== release.releaseId || manifest.projectionId !== release.projectionId ||
      manifest.manifestId !== release.manifestId || manifest.schemaVersion !== release.schemaVersion ||
      manifest.productCount !== release.data.length || manifest.offerCount !== release.data.reduce((count, row) => count + row.offers.length, 0) ||
      manifest.inputDigest !== release.inputDigest || manifest.dataDigest !== release.dataDigest ||
      stableDigest(manifest.canonicalInputs) !== release.inputDigest || stableDigest(release.data) !== release.dataDigest ||
      !release.activatedAt || !Number.isFinite(Date.parse(release.activatedAt))) {
      return reply.code(503).send({ code: 'RELEASE_EVIDENCE_MISMATCH' });
    }

    const commonMeta = {
      consumerId: binding.id,
      projectionId: release.projectionId,
      authority: 'CANONICAL_ACTIVE' as const,
      schemaVersion: release.schemaVersion,
      releaseId: release.releaseId,
      manifestId: release.manifestId,
      inputDigest: release.inputDigest,
      dataDigest: release.dataDigest,
      revision: release.canonicalRevision,
      generatedAt: release.generatedAt,
      activatedAt: release.activatedAt,
    };

    if (binding.projectionId === 'admin-catalog') {
      const data = release.data as AdminCatalogProduct[];
      const missingPolicyOfferIds = [...new Set(
        data.flatMap((product) => product.offers)
          .filter((offer) => offer.policyState === 'MISSING')
          .map((offer) => offer.offerId)
      )].sort();
      const invalidPolicyFactRefs = [...new Set(
        data.flatMap((product) => product.offers)
          .flatMap((offer) => offer.invalidPolicyFactRefs)
      )].sort();
      const response = {
        schema: 'freepass-data.admin-catalog/v1',
        data,
        meta: {
          ...commonMeta,
          projectionId: 'admin-catalog' as const,
          policyParity: missingPolicyOfferIds.length || invalidPolicyFactRefs.length
            ? 'INCOMPLETE' as const
            : 'COMPLETE' as const,
          missingPolicyOfferIds,
          invalidPolicyFactRefs,
        },
      };
      if (!validateAdminResponse(response)) {
        return reply.code(503).send({ code: 'UNSUPPORTED_OR_INCOMPLETE_RELEASE' });
      }
      return response;
    }

    if (!validateErpData(release.data)) {
      return reply.code(503).send({ code: 'UNSUPPORTED_OR_INCOMPLETE_RELEASE' });
    }
    return { data: release.data, meta: commonMeta };
  });
  app.get<{ Params: { consumerId: string } }>('/v1/consumers/:consumerId/catalog-health', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const binding = registered.get(request.params.consumerId);
    const supplied = request.headers.authorization ?? '';
    const matches = timingSafeEqual(
      hash(supplied),
      hash(binding ? `Bearer ${binding.token}` : 'unregistered-consumer')
    );
    if (!binding || !matches) {
      return reply.code(401).send({ code: 'UNAUTHORIZED' });
    }
    if (!binding.capabilities.includes('catalog-health')) {
      return reply.code(403).send({ code: 'FORBIDDEN' });
    }
    if (!healthStore) {
      return reply.code(503).send({ code: 'HEALTH_READER_UNAVAILABLE' });
    }

    try {
      const report = await readCatalogDataHealth(
        healthStore,
        healthStore
      );
      if (!validateHealth(report)) {
        return reply.code(503).send({ code: 'HEALTH_CONTRACT_INVALID' });
      }
      return reply
        .code(report.status === 'BLOCKED' ? 503 : 200)
        .send(report);
    } catch {
      return reply.code(503).send({ code: 'HEALTH_READ_FAILED' });
    }
  });
  return app;
}
