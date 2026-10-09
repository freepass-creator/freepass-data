import { summarizeEconomicsCoverage } from '../application/resolve-offer-commercial-terms.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify from 'fastify';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import catalogSchema from '../../contracts/catalog-v1.schema.json' with { type: 'json' };
import adminCatalogSchema from '../../contracts/admin-catalog-view-v1.schema.json' with { type: 'json' };
import commercialOfferSchema from '../../contracts/commercial-offer-view-v1.schema.json' with { type: 'json' };
import erpViewSchema from '../../contracts/erp-public-view-v1.schema.json' with { type: 'json' };
import healthSchema from '../../contracts/catalog-data-health-v1.schema.json' with { type: 'json' };
import estimateMasterSchema from '../../contracts/estimate-newcar-master-v1.schema.json' with { type: 'json' };
import estimateQuoteReadReceiptSchema from '../../contracts/estimate-quote-read-receipt-v1.schema.json' with { type: 'json' };
import estimateQuoteWriteReceiptSchema from '../../contracts/estimate-quote-write-receipt-v1.schema.json' with { type: 'json' };
import estimateShareEnvelopeReadReceiptSchema from '../../contracts/estimate-share-envelope-read-receipt-v1.schema.json' with { type: 'json' };
import estimateShareEnvelopeWriteReceiptSchema from '../../contracts/estimate-share-envelope-write-receipt-v1.schema.json' with { type: 'json' };
import settlementLedgerSchema from '../../contracts/settlement-ledger-view-v1.schema.json' with { type: 'json' };
import settlementLedgerSchemaV2 from '../../contracts/settlement-ledger-view-v2.schema.json' with { type: 'json' };
import kakaoCatalogReferenceSchema from '../../contracts/kakao-catalog-reference-v1.schema.json' with { type: 'json' };
import internalAiReferenceSchema from '../../contracts/internal-ai-reference-v1.schema.json' with { type: 'json' };
import type { ProjectionEvidenceSnapshotStore, ProjectionStore } from '../ports/catalog-store.js';
import type { AdminCatalogProduct, ErpPublicProduct, ProjectionRelease } from '../domain/catalog.js';
import {
  ESTIMATE_NEWCAR_MASTER_CONTRACT,
  ESTIMATE_NEWCAR_MASTER_PROJECTION_ID,
  type EstimateNewcarMasterRecord,
  uncoveredEstimateMasterIssues,
  validateEstimateMasterSemantics
} from '../domain/estimate-master.js';
import { readCatalogDataHealth } from '../application/catalog-health.js';
import { DataAccessGateway } from '../application/data-access-gateway.js';
import { DataAccessAuditUnavailableError } from '../domain/data-access.js';
import { stableDigest } from '../shared/stable-digest.js';
import { readActiveProjectionEvidence } from '../application/projection-evidence-reader.js';
import { verifyProjectionReleaseIntegrity } from '../shared/projection-integrity.js';
import type { CatalogCompatibilitySnapshot } from '../infra/erp5-compat-catalog-reader.js';
import {
  buildKakaoCatalogReference,
  buildInternalAiReference,
  type KakaoCatalogReference,
  type KakaoCatalogReferenceSource,
} from '../application/kakao-catalog-reference.js';
import type { AdminWorkflowStore } from '../ports/admin-workflow.js';
import type { EstimateArtifactStore } from '../ports/estimate-artifacts.js';
import {
  assertQuotePutCommand,
  assertShareEnvelopePutCommand,
  normalizedArtifactVersion,
} from '../domain/estimate-artifacts.js';
import {
  assertAdminWorkflowCommitRequest,
  assertAdminWorkflowReadSpec,
  type AdminWorkflowCommitRequest,
  type AdminWorkflowReadSpec,
} from '../domain/admin-workflow.js';
import { readSettlementLedgerView } from '../application/settlement-ledger-view.js';
import {
  assertSettlementLedgerReadRequest,
  type SettlementLedgerReadRequest,
} from '../domain/settlement-ledger-view.js';

export type ConsumerCapability =
  | 'catalog'
  | 'catalog-reference'
  | 'internal-ai-reference'
  | 'catalog-health'
  | 'estimate-newcar-master'
  | 'estimate-artifacts'
  | 'settlement-ledger-read'
  | 'admin-workflow';
export type ConsumerBinding = {
  id: string;
  projectionId: 'erp-public' | 'admin-catalog' | 'estimate-newcar-master';
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
    if (typeof item.id !== 'string' || !/^(erp-com|kakao-ops|freepass-estimate|freepass-admin-catalog|(?:whitelabel|internal-ai)-[a-z0-9]+(?:-[a-z0-9]+)*)$/.test(item.id)) {
      throw new Error('Consumer contract is not implemented for this registration');
    }
    const expectedProjection = item.id === 'freepass-estimate'
      ? ESTIMATE_NEWCAR_MASTER_PROJECTION_ID
      : item.id === 'freepass-admin-catalog'
        ? 'admin-catalog'
        : 'erp-public';
    if (item.projectionId !== expectedProjection) throw new Error('Unsupported consumer projection');
    if (typeof item.token !== 'string' || item.token.trim() !== item.token || item.token.length < 32) {
      throw new Error('Each consumer needs a distinct service token of at least 32 characters');
    }
    if (ids.has(item.id) || tokens.has(item.token)) throw new Error('Duplicate consumer ID or shared service token');
    const internalAi = item.id.startsWith('internal-ai-');
    if (internalAi && item.capabilities === undefined) throw new Error('Internal AI capability must be explicit');
    const capabilities: ConsumerCapability[] = item.capabilities === undefined
      ? (item.id === 'freepass-estimate' ? ['estimate-newcar-master', 'estimate-artifacts'] : ['catalog'])
      : (() => {
          if (!Array.isArray(item.capabilities) || item.capabilities.length === 0) {
            throw new Error('Consumer capabilities must be a non-empty array');
          }
          const allowed = new Set<ConsumerCapability>(['catalog', 'catalog-reference', 'internal-ai-reference', 'catalog-health', 'estimate-newcar-master', 'estimate-artifacts', 'settlement-ledger-read', 'admin-workflow']);
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
      if (capabilities.some((value) => !['estimate-newcar-master', 'estimate-artifacts'].includes(value))) {
        throw new Error('FreePass Estimate registration may only use Estimate capabilities');
      }
    } else if (capabilities.includes('estimate-newcar-master')) {
      throw new Error('Estimate master capability requires freepass-estimate registration');
    } else if (capabilities.includes('estimate-artifacts')) {
      throw new Error('Estimate artifact capability requires freepass-estimate registration');
    }
    if (capabilities.includes('admin-workflow') && item.id !== 'freepass-admin-catalog') {
      throw new Error('Admin workflow capability requires freepass-admin-catalog registration');
    }
    if (capabilities.includes('catalog-reference') && item.id !== 'kakao-ops') {
      throw new Error('Catalog reference capability requires kakao-ops registration');
    }
    if ((internalAi && capabilities.some(value => value !== 'internal-ai-reference')) ||
        (!internalAi && capabilities.includes('internal-ai-reference'))) {
      throw new Error('Internal AI registration may only use its dedicated read capability');
    }
    ids.add(item.id);
    tokens.add(item.token);
    return {
      id: item.id,
      projectionId: expectedProjection,
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
    readonly statusCode: number,
    readonly details?: Record<string, unknown>
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
  store: Pick<ProjectionStore, 'getActive' | 'getManifest' | 'listProjectionLineage'> &
    Partial<ProjectionEvidenceSnapshotStore>,
  bindings: ConsumerBinding[],
  access: DataAccessGateway,
  healthStore?: CatalogDataHealthStore,
  compatReader?: {
    read(consumerId: string): Promise<CatalogCompatibilitySnapshot>;
    readKakaoReferenceSource?(consumerId: string): Promise<KakaoCatalogReferenceSource>;
    readInternalAiReferenceSource?(consumerId: string): Promise<KakaoCatalogReferenceSource>;
    readIancarPhoto?(consumerId: string, productId: string, index?: number): Promise<{ count: number; bytes: Buffer | null; contentType: string }>;
  },
  workflowStore?: AdminWorkflowStore,
  estimateArtifactStore?: EstimateArtifactStore,
) {
  // Validate again for callers constructing registrations without the environment parser.
  const registered = new Map(parseConsumerBindings(JSON.stringify(bindings)).map((item) => [item.id, item]));
  const app = Fastify({ logger: false });
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  ajv.addSchema(catalogSchema);
  ajv.addSchema(commercialOfferSchema);
  const validateErpData = ajv.compile(erpViewSchema);
  const validateAdminResponse = ajv.compile(adminCatalogSchema);
  const validateHealth = ajv.compile(healthSchema);
  const validateEstimateMaster = ajv.compile(estimateMasterSchema);
  const validateEstimateQuoteReadReceipt = ajv.compile(estimateQuoteReadReceiptSchema);
  const validateEstimateQuoteWriteReceipt = ajv.compile(estimateQuoteWriteReceiptSchema);
  const validateEstimateShareEnvelopeReadReceipt = ajv.compile(estimateShareEnvelopeReadReceiptSchema);
  const validateEstimateShareEnvelopeWriteReceipt = ajv.compile(estimateShareEnvelopeWriteReceiptSchema);
  const validateSettlementLedger = ajv.compile(settlementLedgerSchema);
  const validateSettlementLedgerV2 = ajv.compile(settlementLedgerSchemaV2);
  const validateKakaoReference = ajv.compile(kakaoCatalogReferenceSchema);
  const validateInternalAiReference = ajv.compile(internalAiReferenceSchema);
  app.get('/health', async () => ({ service: 'freepass-data-consumer-gateway', status: 'SERVING', readiness: 'NOT_ASSERTED' }));
  const photoHandler = async (request: { params: { consumerId: string; productId: string; index?: string }; headers: { authorization?: string | undefined }; id: string }, reply: import('fastify').FastifyReply) => {
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    const binding = registered.get(request.params.consumerId);
    const matches = timingSafeEqual(hash(request.headers.authorization ?? ''), hash(binding ? `Bearer ${binding.token}` : 'unregistered-consumer'));
    const spec = { context: consumerContext(binding?.id ?? 'unregistered-consumer', 'read bound Iancar vehicle photo through FreePass Data', request.id),
      operation: 'READ_IANCAR_PRODUCT_PHOTO', resource: { kind: 'CATALOG' as const, name: 'iancar-product-photo' } };
    try {
      if (!binding || !matches) { await access.deny('READ', spec, 'UNAUTHORIZED'); return reply.code(401).send({ code: 'UNAUTHORIZED' }); }
      if (!binding.capabilities.includes('catalog') || !(binding.id === 'erp-com' || binding.id.startsWith('whitelabel-'))) {
        await access.deny('READ', spec, 'FORBIDDEN'); return reply.code(403).send({ code: 'FORBIDDEN' });
      }
      const index = request.params.index === undefined ? undefined : Number(request.params.index);
      if ((request.params.index !== undefined && !/^(0|[1-9]\d{0,2})$/.test(request.params.index)) || (index !== undefined && index >= 200)
        || !request.params.productId || request.params.productId.length > 200 || /[\/\u0000-\u001f\u007f]/.test(request.params.productId)) {
        await access.deny('READ', spec, 'INVALID_REQUEST'); return reply.code(400).send({ code: 'INVALID_REQUEST' });
      }
      spec.resource = { ...spec.resource, ...{ entityId: request.params.productId } };
      if (!compatReader?.readIancarPhoto) {
        await access.deny('READ', spec, 'IANCAR_PHOTO_READER_UNAVAILABLE');
        return reply.code(503).send({ code: 'IANCAR_PHOTO_READER_UNAVAILABLE' });
      }
      const read = compatReader.readIancarPhoto.bind(compatReader);
      const result = await access.read({ ...spec, requestDigest: stableDigest({ productId: request.params.productId, index: index ?? null }),
        summarize: value => ({ count: value.count }) }, () => read(binding.id, request.params.productId, index));
      if (!Number.isSafeInteger(result.count) || result.count < 0 || result.count > 200)
        return reply.code(503).send({ code: 'IANCAR_PHOTO_RESPONSE_INVALID' });
      if (index === undefined) return reply.send({ schema: 'freepass-data.product-photos/v1', productId: request.params.productId, count: result.count });
      if (!Buffer.isBuffer(result.bytes) || !result.bytes.length || result.bytes.length > 8 * 1024 * 1024
        || !['image/jpeg', 'image/png', 'image/webp'].includes(result.contentType)) return reply.code(503).send({ code: 'IANCAR_PHOTO_RESPONSE_INVALID' });
      return reply.type(result.contentType).send(result.bytes);
    } catch (error) {
      if (error instanceof DataAccessAuditUnavailableError) return reply.code(503).send({ code: error.code });
      const code = error instanceof Error ? error.message : '';
      if (code === 'IANCAR_PHOTO_BUSY') return reply.header('Retry-After', '2').code(429).send({ code });
      return reply.code(code === 'IANCAR_PHOTO_NOT_FOUND' ? 404 : 503).send({ code: code === 'IANCAR_PHOTO_NOT_FOUND' ? code : 'IANCAR_PHOTO_READ_FAILED' });
    }
  };
  app.get<{ Params: { consumerId: string; productId: string } }>('/v1/consumers/:consumerId/catalog-compat/products/:productId/photos', photoHandler);
  app.get<{ Params: { consumerId: string; productId: string; index: string } }>('/v1/consumers/:consumerId/catalog-compat/products/:productId/photos/:index', photoHandler);
  app.get<{ Params: { consumerId: string } }>('/v1/consumers/:consumerId/catalog', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const binding = registered.get(request.params.consumerId);
    const supplied = request.headers.authorization ?? '';
    const matches = timingSafeEqual(hash(supplied), hash(binding ? `Bearer ${binding.token}` : 'unregistered-consumer'));
    const context = consumerContext(
      binding?.id ?? 'unregistered-consumer',
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
          meta: { inputDigest: string; dataDigest: string; releaseId: string; manifestId: string; revision: number };
        }) => ({
          count: value.data.length,
          digest: value.meta.dataDigest,
          inputDigest: value.meta.inputDigest,
          releaseId: value.meta.releaseId,
          manifestId: value.meta.manifestId,
          revision: value.meta.revision
        })
      }, async () => {
        const evidence = await readActiveProjectionEvidence<ErpPublicProduct | AdminCatalogProduct>(
          store,
          binding.projectionId
        );
        const release = evidence.release;
        if (!release) throw new ConsumerReadError('NO_ACTIVE_RELEASE', 503);
        if (release.schemaVersion !== '1.0.0') {
          throw new ConsumerReadError('UNSUPPORTED_OR_INCOMPLETE_RELEASE', 503);
        }
        if (
          evidence.consistency !== 'ATOMIC' ||
          evidence.projectionId !== binding.projectionId ||
          release.status !== 'ACTIVE' ||
          release.projectionId !== binding.projectionId ||
          !evidence.manifest ||
          !release.activatedAt ||
          !Number.isFinite(Date.parse(release.activatedAt))
        ) {
          throw new ConsumerReadError('RELEASE_EVIDENCE_MISMATCH', 503);
        }
        const integrity = verifyProjectionReleaseIntegrity(
          release,
          evidence.manifest,
          evidence.lineage
        );
        if (!integrity.valid) {
          throw new ConsumerReadError('RELEASE_EVIDENCE_MISMATCH', 503, {
            failures: integrity.failures
          });
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
          const data = release.data as unknown as AdminCatalogProduct[];
          const missingPolicyOfferIds = [...new Set(
            data.flatMap((product) => product.offers)
              .filter((offer) => offer.policyState === 'MISSING')
              .map((offer) => offer.offerId)
          )].sort();
          const invalidPolicyFactRefs = [...new Set(
            data.flatMap((product) => product.offers)
              .flatMap((offer) => offer.invalidPolicyFactRefs)
          )].sort();
          const commercialMissingOfferIds = [...new Set(
            data.flatMap((product) => product.offers)
              .filter((offer) => !offer.commercial)
              .map((offer) => offer.offerId)
          )].sort();
          const response = {
            schema: 'freepass-data.admin-catalog/v1',
            data,
            meta: {
              ...commonMeta,
              projectionId: 'admin-catalog' as const,
              ...summarizeEconomicsCoverage(data.flatMap(product => product.offers.flatMap(offer => offer.priceTerms))),
              policyParity: missingPolicyOfferIds.length || invalidPolicyFactRefs.length
                ? 'INCOMPLETE' as const
                : 'COMPLETE' as const,
              missingPolicyOfferIds,
              invalidPolicyFactRefs,
              commercialCoverage: commercialMissingOfferIds.length
                ? 'INCOMPLETE' as const
                : 'COMPLETE' as const,
              commercialMissingOfferIds,
            },
          };
          if (!validateAdminResponse(response)) {
            throw new ConsumerReadError('UNSUPPORTED_OR_INCOMPLETE_RELEASE', 503);
          }
          return response;
        }

        if (!validateErpData(release.data)) {
          throw new ConsumerReadError('UNSUPPORTED_OR_INCOMPLETE_RELEASE', 503);
        }
        const data = release.data as ErpPublicProduct[];
        const commercialMissingOfferIds = [...new Set(
          data.flatMap((product) => product.offers)
            .filter((offer) => !offer.commercial)
            .map((offer) => offer.offerId)
        )].sort();
        return {
          data,
          meta: {
            ...commonMeta,
            commercialCoverage: commercialMissingOfferIds.length
              ? 'INCOMPLETE' as const
              : 'COMPLETE' as const,
            commercialMissingOfferIds,
          },
        };
      });
      return result;
    } catch (error) {
      if (error instanceof ConsumerReadError) {
        return reply.code(error.statusCode).send({ code: error.code, ...(error.details ?? {}) });
      }
      if (error instanceof DataAccessAuditUnavailableError) {
        return reply.code(503).send({ code: error.code });
      }
      return reply.code(503).send({ code: 'CATALOG_READ_FAILED' });
    }
  });
  app.get<{ Params: { consumerId: string } }>('/v1/consumers/:consumerId/catalog-compat', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const binding = registered.get(request.params.consumerId);
    const supplied = request.headers.authorization ?? '';
    const matches = timingSafeEqual(
      hash(supplied),
      hash(binding ? `Bearer ${binding.token}` : 'unregistered-consumer')
    );
    const context = consumerContext(
      binding?.id ?? 'unregistered-consumer',
      'read legacy-compatible catalog through FreePass Data',
      request.id
    );
    const resource = {
      kind: 'CATALOG' as const,
      name: 'erp5-catalog-compat'
    };

    try {
      if (!binding || !matches) {
        await access.deny('READ', {
          context,
          operation: 'READ_CONSUMER_CATALOG_COMPAT',
          resource
        }, 'UNAUTHORIZED');
        return reply.code(401).send({ code: 'UNAUTHORIZED' });
      }
      if (!binding.capabilities.includes('catalog')) {
        await access.deny('READ', {
          context,
          operation: 'READ_CONSUMER_CATALOG_COMPAT',
          resource
        }, 'FORBIDDEN');
        return reply.code(403).send({ code: 'FORBIDDEN' });
      }
      if (!compatReader) {
        await access.deny('READ', {
          context,
          operation: 'READ_CONSUMER_CATALOG_COMPAT',
          resource
        }, 'COMPATIBILITY_READER_UNAVAILABLE');
        return reply.code(503).send({ code: 'COMPATIBILITY_READER_UNAVAILABLE' });
      }

      const result = await access.read({
        context,
        operation: 'READ_CONSUMER_CATALOG_COMPAT',
        resource,
        summarize: (value: CatalogCompatibilitySnapshot) => ({
          count: value.meta.collectionCounts.products ?? 0,
          digest: stableDigest({
            schema: value.schema,
            consumerId: value.meta.consumerId,
            observedAt: value.meta.observedAt,
            collectionCounts: value.meta.collectionCounts
          })
        })
      }, () => compatReader.read(binding.id));

      if (
        result.schema !== 'freepass-data.catalog-compat/v1' ||
        result.meta.consumerId !== binding.id ||
        result.meta.authority !== 'FREEPASS_DATA_COMPATIBILITY_BRIDGE' ||
        result.meta.sourceProject !== 'freepasserp5' ||
        !result.data.products ||
        !result.data.policies
      ) {
        return reply.code(503).send({ code: 'CATALOG_COMPAT_RESPONSE_INVALID' });
      }
      return result;
    } catch (error) {
      if (error instanceof DataAccessAuditUnavailableError) {
        return reply.code(503).send({ code: error.code });
      }
      return reply.code(503).send({ code: 'CATALOG_COMPAT_READ_FAILED' });
    }
  });
  for (const internalAi of [false, true]) {
  app.get<{ Params: { consumerId: string } }>(`/v1/consumers/:consumerId/${internalAi ? 'internal-ai-reference' : 'catalog-reference'}`, async (request, reply) => {
    const operation = internalAi ? 'READ_INTERNAL_AI_REFERENCE' : 'READ_KAKAO_CATALOG_REFERENCE';
    const projectionId = internalAi ? 'internal-ai-reference' : 'kakao-catalog-reference';
    const errorPrefix = internalAi ? 'INTERNAL_AI_REFERENCE' : 'KAKAO_REFERENCE';
    const readSource = internalAi ? compatReader?.readInternalAiReferenceSource?.bind(compatReader)
      : compatReader?.readKakaoReferenceSource?.bind(compatReader);
    reply.header('Cache-Control', 'no-store');
    const binding = registered.get(request.params.consumerId);
    const supplied = request.headers.authorization ?? '';
    const matches = timingSafeEqual(
      hash(supplied),
      hash(binding ? `Bearer ${binding.token}` : 'unregistered-consumer')
    );
    const context = consumerContext(
      binding?.id ?? 'unregistered-consumer',
      `read ${projectionId} REFERENCE_ONLY facts through FreePass Data`,
      request.id
    );
    const resource = {
      kind: 'PROJECTION' as const,
      name: projectionId,
      projectionId
    };

    try {
      if (!binding || !matches) {
        await access.deny('READ', {
          context,
          operation,
          resource
        }, 'UNAUTHORIZED');
        return reply.code(401).send({ code: 'UNAUTHORIZED' });
      }
      if (internalAi ? !binding.id.startsWith('internal-ai-') || !binding.capabilities.includes('internal-ai-reference')
        : binding.id !== 'kakao-ops' || !binding.capabilities.includes('catalog-reference')) {
        await access.deny('READ', {
          context,
          operation,
          resource
        }, 'FORBIDDEN');
        return reply.code(403).send({ code: 'FORBIDDEN' });
      }
      if (!readSource) {
        await access.deny('READ', {
          context,
          operation,
          resource
        }, `${errorPrefix}_READER_UNAVAILABLE`);
        return reply.code(503).send({ code: `${errorPrefix}_READER_UNAVAILABLE` });
      }

      const result = await access.read({
        context,
        operation,
        resource,
        summarize: (value: KakaoCatalogReference | ReturnType<typeof buildInternalAiReference>) => ({
          count: value.meta.projectedCount,
          digest: value.meta.dataDigest,
        })
      }, async () => {
        const source = await readSource(binding.id);
        if (source.consumerId !== binding.id) throw new Error('REFERENCE_SOURCE_CONSUMER_MISMATCH');
        return internalAi ? buildInternalAiReference(source) : buildKakaoCatalogReference(source);
      });

      if (
        !(internalAi ? validateInternalAiReference(result) : validateKakaoReference(result)) ||
        result.schema !== (internalAi ? 'freepass-data.internal-ai-reference/v1' : 'freepass-data.kakao-catalog-reference/v1') ||
        result.meta.consumerId !== binding.id ||
        result.meta.authority !== 'REFERENCE_ONLY' ||
        result.meta.publicationDecision !== 'HOLD' ||
        result.meta.sourceProject !== 'freepasserp5' ||
        !result.data.length ||
        !result.commissionPolicy.digest
      ) {
        return reply.code(503).send({ code: `${errorPrefix}_RESPONSE_INVALID` });
      }
      return result;
    } catch (error) {
      if (error instanceof DataAccessAuditUnavailableError) {
        return reply.code(503).send({ code: error.code });
      }
      return reply.code(503).send({ code: `${errorPrefix}_READ_FAILED` });
    }
  });
  }

  app.get<{ Params: { consumerId: string } }>('/v1/consumers/:consumerId/estimate-newcar-master', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const binding = registered.get(request.params.consumerId);
    const supplied = request.headers.authorization ?? '';
    const matches = timingSafeEqual(
      hash(supplied),
      hash(binding ? `Bearer ${binding.token}` : 'unregistered-consumer')
    );
    const context = consumerContext(
      binding?.id ?? 'unregistered-consumer',
      'read Estimate new-car master through FreePass Data',
      request.id
    );
    const resource = {
      kind: 'PROJECTION' as const,
      name: binding?.projectionId ?? 'unregistered',
      ...(binding ? { projectionId: binding.projectionId } : {})
    };

    try {
      if (!binding || !matches) {
        await access.deny('READ', { context, operation: 'READ_ESTIMATE_NEWCAR_MASTER', resource }, 'UNAUTHORIZED');
        return reply.code(401).send({ code: 'UNAUTHORIZED' });
      }
      if (!binding.capabilities.includes('estimate-newcar-master') ||
          binding.projectionId !== ESTIMATE_NEWCAR_MASTER_PROJECTION_ID) {
        await access.deny('READ', { context, operation: 'READ_ESTIMATE_NEWCAR_MASTER', resource }, 'FORBIDDEN');
        return reply.code(403).send({ code: 'FORBIDDEN' });
      }

      const result = await access.read({
        context,
        operation: 'READ_ESTIMATE_NEWCAR_MASTER',
        resource,
        summarize: (value: {
          data: EstimateNewcarMasterRecord[];
          meta: { inputDigest: string; dataDigest: string; releaseId: string; manifestId: string; revision: number };
        }) => ({
          count: value.data.length,
          digest: value.meta.dataDigest,
          inputDigest: value.meta.inputDigest,
          releaseId: value.meta.releaseId,
          manifestId: value.meta.manifestId,
          revision: value.meta.revision
        })
      }, async () => {
        const evidence = await readActiveProjectionEvidence(
          store,
          binding.projectionId
        );
        const release = evidence.release as unknown as ProjectionRelease<EstimateNewcarMasterRecord> | null;
        if (!release) throw new ConsumerReadError('NO_ACTIVE_RELEASE', 503);
        const records = release.data;
        if (release.schemaVersion !== '1.0.0' || !validateEstimateMaster(records)) {
          throw new ConsumerReadError('UNSUPPORTED_OR_INCOMPLETE_RELEASE', 503);
        }
        const semanticIssues = validateEstimateMasterSemantics(records);
        const uncoveredIssues = uncoveredEstimateMasterIssues(records, semanticIssues);
        if (uncoveredIssues.length) {
          throw new ConsumerReadError('ESTIMATE_MASTER_SEMANTIC_INVALID', 503, {
            issueCount: uncoveredIssues.length,
            issues: uncoveredIssues.slice(0, 20)
          });
        }
        if (
          evidence.consistency !== 'ATOMIC' ||
          evidence.projectionId !== binding.projectionId ||
          release.status !== 'ACTIVE' ||
          release.projectionId !== binding.projectionId ||
          !evidence.manifest ||
          !release.activatedAt ||
          !Number.isFinite(Date.parse(release.activatedAt))
        ) {
          throw new ConsumerReadError('RELEASE_EVIDENCE_MISMATCH', 503);
        }
        const integrity = verifyProjectionReleaseIntegrity(
          release,
          evidence.manifest,
          evidence.lineage
        );
        if (!integrity.valid) {
          throw new ConsumerReadError('RELEASE_EVIDENCE_MISMATCH', 503, {
            failures: integrity.failures
          });
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
            activatedAt: release.activatedAt
          }
        };
      });
      return result;
    } catch (error) {
      if (error instanceof ConsumerReadError) {
        return reply.code(error.statusCode).send({ code: error.code, ...(error.details ?? {}) });
      }
      if (error instanceof DataAccessAuditUnavailableError) {
        return reply.code(503).send({ code: error.code });
      }
      return reply.code(503).send({ code: 'ESTIMATE_MASTER_READ_FAILED' });
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
      binding?.id ?? 'unregistered-consumer',
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
        return reply.code(error.statusCode).send({ code: error.code, ...(error.details ?? {}) });
      }
      if (error instanceof DataAccessAuditUnavailableError) {
        return reply.code(503).send({ code: error.code });
      }
      return reply.code(503).send({ code: 'HEALTH_READ_FAILED' });
    }
  });

  app.post<{ Params: { consumerId: string }; Body: SettlementLedgerReadRequest }>(
    '/v1/consumers/:consumerId/settlement-ledger/read',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const binding = registered.get(request.params.consumerId);
      const supplied = request.headers.authorization ?? '';
      const matches = timingSafeEqual(
        hash(supplied),
        hash(binding ? `Bearer ${binding.token}` : 'unregistered-consumer')
      );
      const context = consumerContext(
        binding?.id ?? 'unregistered-consumer',
        'read FreePass Data settlement ledger facts',
        request.id
      );
      const resource = { kind: 'PROJECTION' as const, name: 'settlement-ledger' };

      try {
        if (!binding || !matches) {
          await access.deny('READ', { context, operation: 'READ_SETTLEMENT_LEDGER', resource }, 'UNAUTHORIZED');
          return reply.code(401).send({ code: 'UNAUTHORIZED' });
        }
        if (!binding.capabilities.includes('settlement-ledger-read')) {
          await access.deny('READ', { context, operation: 'READ_SETTLEMENT_LEDGER', resource }, 'FORBIDDEN');
          return reply.code(403).send({ code: 'FORBIDDEN' });
        }
        if (!workflowStore) {
          await access.deny('READ', { context, operation: 'READ_SETTLEMENT_LEDGER', resource }, 'SETTLEMENT_LEDGER_UNAVAILABLE');
          return reply.code(503).send({ code: 'SETTLEMENT_LEDGER_UNAVAILABLE' });
        }
        assertSettlementLedgerReadRequest(request.body);
        const result = await access.read({
          context,
          operation: 'READ_SETTLEMENT_LEDGER',
          resource,
          requestDigest: stableDigest(request.body),
          summarize: (value) => ({ count: value.meta.count, digest: value.meta.dataDigest })
        }, () => readSettlementLedgerView(workflowStore, binding.id, request.body));
        if (!(request.body.viewVersion === 2 ? validateSettlementLedgerV2(result) : validateSettlementLedger(result))) {
          return reply.code(503).send({ code: 'SETTLEMENT_LEDGER_RESPONSE_INVALID' });
        }
        return result;
      } catch (error) {
        if (error instanceof DataAccessAuditUnavailableError) return reply.code(503).send({ code: error.code });
        const code = error instanceof Error ? error.message : 'SETTLEMENT_LEDGER_READ_FAILED';
        if (
          code.startsWith('INVALID_SETTLEMENT_LEDGER_')
          || code === 'SETTLEMENT_LEDGER_QUERY_REQUIRES_FILTER'
          || code === 'SETTLEMENT_LEDGER_PERSON_LOOKUP_REQUIRES_AGENT_AND_CUSTOMER'
        ) {
          return reply.code(400).send({ code });
        }
        return reply.code(503).send({ code: 'SETTLEMENT_LEDGER_READ_FAILED' });
      }
    }
  );

  app.post<{ Params: { consumerId: string }; Body: AdminWorkflowReadSpec }>(
    '/v1/consumers/:consumerId/admin-workflow/read',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const binding = registered.get(request.params.consumerId);
      const supplied = request.headers.authorization ?? '';
      const matches = timingSafeEqual(
        hash(supplied),
        hash(binding ? `Bearer ${binding.token}` : 'unregistered-consumer')
      );
      const context = consumerContext(
        binding?.id ?? 'unregistered-consumer',
        'read Admin workflow data through FreePass Data',
        request.id
      );
      const resource = { kind: 'SYSTEM' as const, name: 'admin-workflow' };

      try {
        if (!binding || !matches) {
          await access.deny('READ', { context, operation: 'READ_ADMIN_WORKFLOW', resource }, 'UNAUTHORIZED');
          return reply.code(401).send({ code: 'UNAUTHORIZED' });
        }
        if (!binding.capabilities.includes('admin-workflow')) {
          await access.deny('READ', { context, operation: 'READ_ADMIN_WORKFLOW', resource }, 'FORBIDDEN');
          return reply.code(403).send({ code: 'FORBIDDEN' });
        }
        if (!workflowStore) {
          await access.deny('READ', { context, operation: 'READ_ADMIN_WORKFLOW', resource }, 'ADMIN_WORKFLOW_UNAVAILABLE');
          return reply.code(503).send({ code: 'ADMIN_WORKFLOW_UNAVAILABLE' });
        }
        assertAdminWorkflowReadSpec(request.body);
        const result = await access.read({
          context,
          operation: 'READ_ADMIN_WORKFLOW',
          resource,
          requestDigest: stableDigest(request.body),
          summarize: (value) => ({ count: value.docs.length, digest: value.digest })
        }, () => workflowStore.read(request.body));
        return result;
      } catch (error) {
        if (error instanceof DataAccessAuditUnavailableError) return reply.code(503).send({ code: error.code });
        const code = error instanceof Error ? error.message : 'ADMIN_WORKFLOW_READ_FAILED';
        if (code.startsWith('INVALID_ADMIN_WORKFLOW_')) return reply.code(400).send({ code });
        return reply.code(503).send({ code: 'ADMIN_WORKFLOW_READ_FAILED' });
      }
    }
  );

  app.post<{ Params: { consumerId: string }; Body: AdminWorkflowCommitRequest }>(
    '/v1/consumers/:consumerId/admin-workflow/commit',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const binding = registered.get(request.params.consumerId);
      const supplied = request.headers.authorization ?? '';
      const matches = timingSafeEqual(
        hash(supplied),
        hash(binding ? `Bearer ${binding.token}` : 'unregistered-consumer')
      );
      const context = consumerContext(
        binding?.id ?? 'unregistered-consumer',
        'commit Admin workflow data through FreePass Data',
        request.id
      );
      const resource = { kind: 'COMMAND' as const, name: 'admin-workflow' };

      try {
        if (!binding || !matches) {
          await access.deny('WRITE', { context, operation: 'WRITE_ADMIN_WORKFLOW', resource }, 'UNAUTHORIZED');
          return reply.code(401).send({ code: 'UNAUTHORIZED' });
        }
        if (!binding.capabilities.includes('admin-workflow')) {
          await access.deny('WRITE', { context, operation: 'WRITE_ADMIN_WORKFLOW', resource }, 'FORBIDDEN');
          return reply.code(403).send({ code: 'FORBIDDEN' });
        }
        if (!workflowStore) {
          await access.deny('WRITE', { context, operation: 'WRITE_ADMIN_WORKFLOW', resource }, 'ADMIN_WORKFLOW_UNAVAILABLE');
          return reply.code(503).send({ code: 'ADMIN_WORKFLOW_UNAVAILABLE' });
        }
        if (process.env.NODE_ENV === 'production' && process.env.FREEPASS_DATA_ADMIN_WORKFLOW_WRITE?.trim() !== 'on') {
          await access.deny('WRITE', { context, operation: 'WRITE_ADMIN_WORKFLOW', resource }, 'ADMIN_WORKFLOW_WRITE_DISABLED');
          return reply.code(503).send({ code: 'ADMIN_WORKFLOW_WRITE_DISABLED' });
        }
        try {
          assertAdminWorkflowCommitRequest(request.body);
        } catch (error) {
          const code = error instanceof Error ? error.message : '';
          if (code === 'ADMIN_WORKFLOW_RESOURCE_READ_ONLY') {
            await access.deny('WRITE', { context, operation: 'WRITE_ADMIN_WORKFLOW', resource }, code);
            return reply.code(403).send({ code });
          }
          throw error;
        }
        const result = await access.write({
          context,
          operation: 'WRITE_ADMIN_WORKFLOW',
          resource,
          requestDigest: stableDigest(request.body),
          summarize: (value) => ({ count: value.mutationCount, digest: value.receiptDigest })
        }, () => workflowStore.commit(binding.id, request.body));
        return result;
      } catch (error) {
        if (error instanceof DataAccessAuditUnavailableError) return reply.code(503).send({ code: error.code });
        const code = error && typeof error === 'object' && 'code' in error
          ? String((error as { code?: unknown }).code ?? '')
          : error instanceof Error ? error.message : '';
        if (code === 'ADMIN_WORKFLOW_CONFLICT' || code === 'ADMIN_WORKFLOW_IDEMPOTENCY_CONFLICT') {
          return reply.code(409).send({ code });
        }
        if (code === 'ADMIN_WORKFLOW_REPLACEMENT_DROPS_FIELDS') {
          const { resource: target, droppedFields } = error as { resource?: unknown; droppedFields?: unknown };
          return reply.code(409).send({ code, resource: target, droppedFields });
        }
        if (code.startsWith('INVALID_ADMIN_WORKFLOW_')) return reply.code(400).send({ code });
        return reply.code(503).send({ code: 'ADMIN_WORKFLOW_COMMIT_FAILED' });
      }
    }
  );

  const artifactErrorCode = (error: unknown, fallback: string) => {
    if (error && typeof error === 'object' && 'code' in error) {
      const value = String((error as { code?: unknown }).code ?? '');
      if (value) return value;
    }
    return error instanceof Error && error.message ? error.message : fallback;
  };
  const validatedArtifactReceipt = <T>(validate: (value: unknown) => boolean, value: T, code: string): T => {
    if (!validate(value)) throw Object.assign(new Error(code), { code });
    return value;
  };
  const validArtifactId = (value: string) => /^[A-Za-z0-9._:-]{1,200}$/.test(value);

  app.post<{ Body: unknown }>(
    '/v1/commands/freepass-estimate/issued-quotes',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const binding = registered.get('freepass-estimate');
      const supplied = request.headers.authorization ?? '';
      const matches = timingSafeEqual(
        hash(supplied),
        hash(binding ? `Bearer ${binding.token}` : 'unregistered-consumer')
      );
      const context = consumerContext(
        binding?.id ?? 'unregistered-consumer',
        'persist immutable issued Quote v2 through FreePass Data',
        request.id
      );
      const resource = { kind: 'COMMAND' as const, name: 'estimate-issued-quote' };

      try {
        if (!binding || !matches) {
          await access.deny('WRITE', { context, operation: 'WRITE_ESTIMATE_ISSUED_QUOTE', resource }, 'UNAUTHORIZED');
          return reply.code(401).send({ code: 'UNAUTHORIZED' });
        }
        if (!binding.capabilities.includes('estimate-artifacts')) {
          await access.deny('WRITE', { context, operation: 'WRITE_ESTIMATE_ISSUED_QUOTE', resource }, 'FORBIDDEN');
          return reply.code(403).send({ code: 'FORBIDDEN' });
        }
        if (!estimateArtifactStore) {
          await access.deny('WRITE', { context, operation: 'WRITE_ESTIMATE_ISSUED_QUOTE', resource }, 'ESTIMATE_ARTIFACT_STORE_UNAVAILABLE');
          return reply.code(503).send({ code: 'ESTIMATE_ARTIFACT_STORE_UNAVAILABLE' });
        }
        if (process.env.NODE_ENV === 'production' && process.env.FREEPASS_DATA_ESTIMATE_ARTIFACT_WRITE?.trim() !== 'on') {
          await access.deny('WRITE', { context, operation: 'WRITE_ESTIMATE_ISSUED_QUOTE', resource }, 'ESTIMATE_ARTIFACT_WRITE_DISABLED');
          return reply.code(503).send({ code: 'ESTIMATE_ARTIFACT_WRITE_DISABLED' });
        }

        assertQuotePutCommand(request.body, request.headers['idempotency-key']);
        const command = request.body;
        return await access.write({
          context,
          operation: 'WRITE_ESTIMATE_ISSUED_QUOTE',
          resource: {
            ...resource,
            entityType: 'issued-quote',
            entityId: command.quote.quoteId,
          },
          requestDigest: stableDigest(command),
          summarize: (value) => ({
            count: 1,
            digest: value.snapshotHash,
            revision: value.quoteVersion,
          }),
        }, async () => validatedArtifactReceipt(
          validateEstimateQuoteWriteReceipt,
          await estimateArtifactStore.putIssuedQuote(command.quote, command.idempotencyKey),
          'QUOTE_REPOSITORY_RECEIPT_INVALID',
        ));
      } catch (error) {
        if (error instanceof DataAccessAuditUnavailableError) return reply.code(503).send({ code: error.code });
        const code = artifactErrorCode(error, 'QUOTE_REPOSITORY_WRITE_FAILED');
        if (code.includes('CONFLICT')) return reply.code(409).send({ code });
        if (
          code === 'QUOTE_REPOSITORY_COMMAND_INVALID' ||
          code === 'QUOTE_REPOSITORY_QUOTE_INVALID' ||
          code === 'QUOTE_V2_INTEGRITY_MISMATCH' ||
          code === 'QUOTE_PRICING_ENGINE_UNVERIFIED' ||
          code === 'QUOTE_REVISION_INVALID'
        ) return reply.code(400).send({ code });
        return reply.code(503).send({ code: 'QUOTE_REPOSITORY_WRITE_FAILED' });
      }
    }
  );

  app.get<{ Params: { consumerId: string; quoteId: string }; Querystring: { quoteVersion?: string } }>(
    '/v1/consumers/:consumerId/issued-quotes/:quoteId',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const binding = registered.get(request.params.consumerId);
      const supplied = request.headers.authorization ?? '';
      const matches = timingSafeEqual(
        hash(supplied),
        hash(binding ? `Bearer ${binding.token}` : 'unregistered-consumer')
      );
      const context = consumerContext(
        binding?.id ?? 'unregistered-consumer',
        'read immutable issued Quote v2 through FreePass Data',
        request.id
      );
      const resource = {
        kind: 'SYSTEM' as const,
        name: 'estimate-issued-quote',
        entityType: 'issued-quote',
        entityId: request.params.quoteId,
      };

      try {
        if (!binding || !matches) {
          await access.deny('READ', { context, operation: 'READ_ESTIMATE_ISSUED_QUOTE', resource }, 'UNAUTHORIZED');
          return reply.code(401).send({ code: 'UNAUTHORIZED' });
        }
        if (binding.id !== 'freepass-estimate' || !binding.capabilities.includes('estimate-artifacts')) {
          await access.deny('READ', { context, operation: 'READ_ESTIMATE_ISSUED_QUOTE', resource }, 'FORBIDDEN');
          return reply.code(403).send({ code: 'FORBIDDEN' });
        }
        if (!estimateArtifactStore) {
          await access.deny('READ', { context, operation: 'READ_ESTIMATE_ISSUED_QUOTE', resource }, 'ESTIMATE_ARTIFACT_STORE_UNAVAILABLE');
          return reply.code(503).send({ code: 'ESTIMATE_ARTIFACT_STORE_UNAVAILABLE' });
        }
        if (!validArtifactId(request.params.quoteId)) return reply.code(400).send({ code: 'QUOTE_REPOSITORY_QUERY_INVALID' });
        const version = normalizedArtifactVersion(request.query.quoteVersion, 'QUOTE_REPOSITORY_QUERY_INVALID');
        return await access.read({
          context,
          operation: 'READ_ESTIMATE_ISSUED_QUOTE',
          resource,
          requestDigest: stableDigest({ quoteId: request.params.quoteId, quoteVersion: version }),
          summarize: (value) => ({
            count: value.status === 'FOUND' ? 1 : 0,
            ...(value.status === 'FOUND' ? { digest: value.snapshotHash, revision: value.quoteVersion } : {}),
          }),
        }, async () => validatedArtifactReceipt(
          validateEstimateQuoteReadReceipt,
          await estimateArtifactStore.getIssuedQuote(request.params.quoteId, version),
          'QUOTE_REPOSITORY_RECEIPT_INVALID',
        ));
      } catch (error) {
        if (error instanceof DataAccessAuditUnavailableError) return reply.code(503).send({ code: error.code });
        const code = artifactErrorCode(error, 'QUOTE_REPOSITORY_READ_FAILED');
        if (code === 'QUOTE_REPOSITORY_QUERY_INVALID') return reply.code(400).send({ code });
        if (code.includes('CONFLICT')) return reply.code(409).send({ code });
        return reply.code(503).send({ code: 'QUOTE_REPOSITORY_READ_FAILED' });
      }
    }
  );

  app.post<{ Body: unknown }>(
    '/v1/commands/freepass-estimate/share-envelopes',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const binding = registered.get('freepass-estimate');
      const supplied = request.headers.authorization ?? '';
      const matches = timingSafeEqual(
        hash(supplied),
        hash(binding ? `Bearer ${binding.token}` : 'unregistered-consumer')
      );
      const context = consumerContext(
        binding?.id ?? 'unregistered-consumer',
        'persist immutable Share Envelope through FreePass Data',
        request.id
      );
      const resource = { kind: 'COMMAND' as const, name: 'estimate-share-envelope' };

      try {
        if (!binding || !matches) {
          await access.deny('WRITE', { context, operation: 'WRITE_ESTIMATE_SHARE_ENVELOPE', resource }, 'UNAUTHORIZED');
          return reply.code(401).send({ code: 'UNAUTHORIZED' });
        }
        if (!binding.capabilities.includes('estimate-artifacts')) {
          await access.deny('WRITE', { context, operation: 'WRITE_ESTIMATE_SHARE_ENVELOPE', resource }, 'FORBIDDEN');
          return reply.code(403).send({ code: 'FORBIDDEN' });
        }
        if (!estimateArtifactStore) {
          await access.deny('WRITE', { context, operation: 'WRITE_ESTIMATE_SHARE_ENVELOPE', resource }, 'ESTIMATE_ARTIFACT_STORE_UNAVAILABLE');
          return reply.code(503).send({ code: 'ESTIMATE_ARTIFACT_STORE_UNAVAILABLE' });
        }
        if (process.env.NODE_ENV === 'production' && process.env.FREEPASS_DATA_ESTIMATE_ARTIFACT_WRITE?.trim() !== 'on') {
          await access.deny('WRITE', { context, operation: 'WRITE_ESTIMATE_SHARE_ENVELOPE', resource }, 'ESTIMATE_ARTIFACT_WRITE_DISABLED');
          return reply.code(503).send({ code: 'ESTIMATE_ARTIFACT_WRITE_DISABLED' });
        }

        assertShareEnvelopePutCommand(request.body, request.headers['idempotency-key']);
        const command = request.body;
        return await access.write({
          context,
          operation: 'WRITE_ESTIMATE_SHARE_ENVELOPE',
          resource: {
            ...resource,
            entityType: 'share-envelope',
            entityId: command.envelope.envelopeId,
          },
          requestDigest: stableDigest(command),
          summarize: (value) => ({
            count: 1,
            digest: value.snapshotHash,
            revision: value.envelopeVersion,
          }),
        }, async () => validatedArtifactReceipt(
          validateEstimateShareEnvelopeWriteReceipt,
          await estimateArtifactStore.putShareEnvelope(command.envelope, command.idempotencyKey),
          'SHARE_ENVELOPE_RECEIPT_INVALID',
        ));
      } catch (error) {
        if (error instanceof DataAccessAuditUnavailableError) return reply.code(503).send({ code: error.code });
        const code = artifactErrorCode(error, 'SHARE_ENVELOPE_WRITE_FAILED');
        if (code.includes('CONFLICT') || code.includes('QUOTE_NOT_PERSISTED') || code.includes('QUOTE_RECEIPT_MISMATCH')) {
          return reply.code(409).send({ code });
        }
        if (
          code === 'SHARE_ENVELOPE_COMMAND_INVALID' ||
          code === 'SHARE_ENVELOPE_INVALID' ||
          code === 'SHARE_ENVELOPE_INTEGRITY_MISMATCH' ||
          code === 'SHARE_ENVELOPE_VERSION_UNSUPPORTED'
        ) return reply.code(400).send({ code });
        return reply.code(503).send({ code: 'SHARE_ENVELOPE_WRITE_FAILED' });
      }
    }
  );

  app.get<{ Params: { consumerId: string; envelopeId: string }; Querystring: { envelopeVersion?: string } }>(
    '/v1/consumers/:consumerId/share-envelopes/:envelopeId',
    async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const binding = registered.get(request.params.consumerId);
      const supplied = request.headers.authorization ?? '';
      const matches = timingSafeEqual(
        hash(supplied),
        hash(binding ? `Bearer ${binding.token}` : 'unregistered-consumer')
      );
      const context = consumerContext(
        binding?.id ?? 'unregistered-consumer',
        'read immutable Share Envelope through FreePass Data',
        request.id
      );
      const resource = {
        kind: 'SYSTEM' as const,
        name: 'estimate-share-envelope',
        entityType: 'share-envelope',
        entityId: request.params.envelopeId,
      };

      try {
        if (!binding || !matches) {
          await access.deny('READ', { context, operation: 'READ_ESTIMATE_SHARE_ENVELOPE', resource }, 'UNAUTHORIZED');
          return reply.code(401).send({ code: 'UNAUTHORIZED' });
        }
        if (binding.id !== 'freepass-estimate' || !binding.capabilities.includes('estimate-artifacts')) {
          await access.deny('READ', { context, operation: 'READ_ESTIMATE_SHARE_ENVELOPE', resource }, 'FORBIDDEN');
          return reply.code(403).send({ code: 'FORBIDDEN' });
        }
        if (!estimateArtifactStore) {
          await access.deny('READ', { context, operation: 'READ_ESTIMATE_SHARE_ENVELOPE', resource }, 'ESTIMATE_ARTIFACT_STORE_UNAVAILABLE');
          return reply.code(503).send({ code: 'ESTIMATE_ARTIFACT_STORE_UNAVAILABLE' });
        }
        if (!validArtifactId(request.params.envelopeId)) return reply.code(400).send({ code: 'SHARE_ENVELOPE_QUERY_INVALID' });
        const version = normalizedArtifactVersion(request.query.envelopeVersion, 'SHARE_ENVELOPE_QUERY_INVALID');
        return await access.read({
          context,
          operation: 'READ_ESTIMATE_SHARE_ENVELOPE',
          resource,
          requestDigest: stableDigest({ envelopeId: request.params.envelopeId, envelopeVersion: version }),
          summarize: (value) => ({
            count: value.status === 'FOUND' ? 1 : 0,
            ...(value.status === 'FOUND' ? { digest: value.snapshotHash, revision: value.envelopeVersion } : {}),
          }),
        }, async () => validatedArtifactReceipt(
          validateEstimateShareEnvelopeReadReceipt,
          await estimateArtifactStore.getShareEnvelope(request.params.envelopeId, version),
          'SHARE_ENVELOPE_RECEIPT_INVALID',
        ));
      } catch (error) {
        if (error instanceof DataAccessAuditUnavailableError) return reply.code(503).send({ code: error.code });
        const code = artifactErrorCode(error, 'SHARE_ENVELOPE_READ_FAILED');
        if (code === 'SHARE_ENVELOPE_QUERY_INVALID') return reply.code(400).send({ code });
        if (code.includes('CONFLICT')) return reply.code(409).send({ code });
        return reply.code(503).send({ code: 'SHARE_ENVELOPE_READ_FAILED' });
      }
    }
  );

  return app;
}
