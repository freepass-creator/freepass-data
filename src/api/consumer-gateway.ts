import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import catalogSchema from '../../contracts/catalog-v1.schema.json' with { type: 'json' };
import erpViewSchema from '../../contracts/erp-public-view-v1.schema.json' with { type: 'json' };
import healthSchema from '../../contracts/catalog-data-health-v1.schema.json' with { type: 'json' };
import estimateMasterSchema from '../../contracts/estimate-newcar-master-v1.schema.json' with { type: 'json' };
import type { ProjectionStore } from '../ports/catalog-store.js';
import {
  ESTIMATE_NEWCAR_MASTER_CONTRACT,
  ESTIMATE_NEWCAR_MASTER_PROJECTION_ID,
  type EstimateNewcarMasterRecord,
  validateEstimateMasterSemantics
} from '../domain/estimate-master.js';
import { readCatalogDataHealth } from '../application/catalog-health.js';
import { stableDigest } from '../shared/stable-digest.js';

export type ConsumerCapability = 'catalog' | 'catalog-health' | 'estimate-newcar-master';
export type ConsumerBinding = {
  id: string;
  projectionId: 'erp-public' | 'estimate-newcar-master';
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
    if (typeof item.id !== 'string' || !/^(erp-com|kakao-ops|freepass-estimate|whitelabel-[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(item.id)) {
      throw new Error('Consumer contract is not implemented for this registration');
    }
    const expectedProjection = item.id === 'freepass-estimate'
      ? ESTIMATE_NEWCAR_MASTER_PROJECTION_ID
      : 'erp-public';
    if (item.projectionId !== expectedProjection) throw new Error('Unsupported consumer projection');
    if (typeof item.token !== 'string' || item.token.trim() !== item.token || item.token.length < 32) {
      throw new Error('Each consumer needs a distinct service token of at least 32 characters');
    }
    if (ids.has(item.id) || tokens.has(item.token)) throw new Error('Duplicate consumer ID or shared service token');
    const capabilities: ConsumerCapability[] = item.capabilities === undefined
      ? (item.id === 'freepass-estimate' ? ['estimate-newcar-master'] : ['catalog'])
      : (() => {
          if (!Array.isArray(item.capabilities) || item.capabilities.length === 0) {
            throw new Error('Consumer capabilities must be a non-empty array');
          }
          const allowed = new Set<ConsumerCapability>(['catalog', 'catalog-health', 'estimate-newcar-master']);
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
    if (item.id === 'freepass-estimate') {
      if (capabilities.some((value) => value !== 'estimate-newcar-master')) {
        throw new Error('FreePass Estimate registration may only use estimate-newcar-master capability');
      }
    } else if (capabilities.includes('estimate-newcar-master')) {
      throw new Error('Estimate master capability requires freepass-estimate registration');
    }
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
  const validateData = ajv.compile(erpViewSchema);
  const validateHealth = ajv.compile(healthSchema);
  const validateEstimateMaster = ajv.compile(estimateMasterSchema);
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
    const release = await store.getActive(binding.projectionId);
    if (!release) return reply.code(503).send({ code: 'NO_ACTIVE_RELEASE' });
    if (release.schemaVersion !== '1.0.0' || !validateData(release.data)) {
      return reply.code(503).send({ code: 'UNSUPPORTED_OR_INCOMPLETE_RELEASE' });
    }
    const manifest = await store.getManifest(release.releaseId);
    if (release.status !== 'ACTIVE' || release.projectionId !== binding.projectionId ||
      !manifest || manifest.releaseId !== release.releaseId || manifest.projectionId !== release.projectionId ||
      manifest.manifestId !== release.manifestId || manifest.schemaVersion !== release.schemaVersion ||
      manifest.productCount !== release.data.length || manifest.offerCount !== release.data.reduce((count, row) => count + row.offers.length, 0) ||
      manifest.inputDigest !== release.inputDigest || manifest.dataDigest !== release.dataDigest ||
      stableDigest(manifest.canonicalInputs) !== release.inputDigest || stableDigest(release.data) !== release.dataDigest ||
      !release.activatedAt || !Number.isFinite(Date.parse(release.activatedAt))) {
      return reply.code(503).send({ code: 'RELEASE_EVIDENCE_MISMATCH' });
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

  app.get<{ Params: { consumerId: string } }>('/v1/consumers/:consumerId/estimate-newcar-master', async (request, reply) => {
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
    if (!binding.capabilities.includes('estimate-newcar-master') ||
        binding.projectionId !== ESTIMATE_NEWCAR_MASTER_PROJECTION_ID) {
      return reply.code(403).send({ code: 'FORBIDDEN' });
    }

    const release = await store.getActive(binding.projectionId);
    if (!release) return reply.code(503).send({ code: 'NO_ACTIVE_RELEASE' });

    const records = release.data as unknown as EstimateNewcarMasterRecord[];
    if (release.schemaVersion !== '1.0.0' || !validateEstimateMaster(records)) {
      return reply.code(503).send({ code: 'UNSUPPORTED_OR_INCOMPLETE_RELEASE' });
    }
    const semanticIssues = validateEstimateMasterSemantics(records);
    if (semanticIssues.length) {
      return reply.code(503).send({
        code: 'ESTIMATE_MASTER_SEMANTIC_INVALID',
        issueCount: semanticIssues.length,
        issues: semanticIssues.slice(0, 20)
      });
    }

    const manifest = await store.getManifest(release.releaseId);
    if (release.status !== 'ACTIVE' ||
        release.projectionId !== binding.projectionId ||
        !manifest ||
        manifest.releaseId !== release.releaseId ||
        manifest.projectionId !== release.projectionId ||
        manifest.manifestId !== release.manifestId ||
        manifest.schemaVersion !== release.schemaVersion ||
        manifest.productCount !== records.length ||
        manifest.offerCount !== 0 ||
        manifest.inputDigest !== release.inputDigest ||
        manifest.dataDigest !== release.dataDigest ||
        stableDigest(manifest.canonicalInputs) !== release.inputDigest ||
        stableDigest(records) !== release.dataDigest ||
        !release.activatedAt ||
        !Number.isFinite(Date.parse(release.activatedAt))) {
      return reply.code(503).send({ code: 'RELEASE_EVIDENCE_MISMATCH' });
    }

    return {
      data: records,
      meta: {
        contract: ESTIMATE_NEWCAR_MASTER_CONTRACT,
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
      },
    };
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
