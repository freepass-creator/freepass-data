import Fastify from 'fastify';
import { assertDevelopmentApi } from './runtime-policy.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import updateOfferPriceSchema from '../../contracts/update-offer-price.schema.json' with { type: 'json' };
import { createRuntimeStores } from '../bootstrap.js';
import { AuthorityDeniedError } from '../domain/authority.js';
import { WriterOwnershipDeniedError } from '../domain/writer-ownership.js';
import {
  EntityNotFoundError,
  IdempotencyConflictError,
  InvalidCommandError,
  RevisionConflictError,
  buildErpPublicProjection,
  processOneOutboxEvent,
  updateOfferPrice
} from '../application/catalog.js';
import { buildCatalogProductTrace } from '../application/catalog-trace.js';
import { isLocalConsoleDriver } from './console-access.js';
import { stableDigest } from '../shared/stable-digest.js';

assertDevelopmentApi();
const app = Fastify({ logger: true });
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validateUpdateOfferPrice = ajv.compile(updateOfferPriceSchema);
const stores = await createRuntimeStores();
const driver = process.env.FREEPASS_DATA_DRIVER ?? 'memory';
const isLocalMemory = isLocalConsoleDriver(driver);

// Booting a reader must never publish an empty or unreviewed operational release.
if (isLocalMemory) await buildErpPublicProjection(stores.catalog, stores.projections);

app.get('/', async (_request, reply) => {
  if (!isLocalMemory) return reply.code(404).send({ code: 'NOT_FOUND' });
  return reply.redirect('/console');
});

app.get('/console', async (_request, reply) => {
  if (!isLocalMemory) return reply.code(404).send({ code: 'NOT_FOUND' });
  const html = await readFile(path.join(process.cwd(), 'preview', 'index.html'), 'utf8');
  return reply.type('text/html; charset=utf-8').send(html);
});

app.get('/console/vehicle-finder', async (_request, reply) => {
  if (!isLocalMemory) return reply.code(404).send({ code: 'NOT_FOUND' });
  const html = await readFile(
    path.join(process.cwd(), 'preview', 'vehicle-finder', 'index.html'),
    'utf8'
  );
  return reply.type('text/html; charset=utf-8').send(html);
});

app.get('/console/vehicle-finder/finder.css', async (_request, reply) => {
  if (!isLocalMemory) return reply.code(404).send({ code: 'NOT_FOUND' });
  const css = await readFile(
    path.join(process.cwd(), 'preview', 'vehicle-finder', 'finder.css'),
    'utf8'
  );
  return reply.type('text/css; charset=utf-8').send(css);
});

app.get('/console/vehicle-finder/view.mjs', async (_request, reply) => {
  if (!isLocalMemory) return reply.code(404).send({ code: 'NOT_FOUND' });
  const moduleSource = await readFile(
    path.join(process.cwd(), 'preview', 'vehicle-finder', 'view.mjs'),
    'utf8'
  );
  return reply.type('text/javascript; charset=utf-8').send(moduleSource);
});

app.get('/console/data-health', async (_request, reply) => {
  if (!isLocalMemory) return reply.code(404).send({ code: 'NOT_FOUND' });
  const html = await readFile(
    path.join(process.cwd(), 'preview', 'data-health', 'index.html'),
    'utf8'
  );
  return reply.type('text/html; charset=utf-8').send(html);
});

app.get('/console/data-health/health.css', async (_request, reply) => {
  if (!isLocalMemory) return reply.code(404).send({ code: 'NOT_FOUND' });
  const css = await readFile(
    path.join(process.cwd(), 'preview', 'data-health', 'health.css'),
    'utf8'
  );
  return reply.type('text/css; charset=utf-8').send(css);
});

app.get('/console/data-health/view.mjs', async (_request, reply) => {
  if (!isLocalMemory) return reply.code(404).send({ code: 'NOT_FOUND' });
  const moduleSource = await readFile(
    path.join(process.cwd(), 'preview', 'data-health', 'view.mjs'),
    'utf8'
  );
  return reply.type('text/javascript; charset=utf-8').send(moduleSource);
});

app.get('/console/review-queue', async (_request, reply) => {
  if (!isLocalMemory) return reply.code(404).send({ code: 'NOT_FOUND' });
  const html = await readFile(
    path.join(process.cwd(), 'preview', 'review-queue', 'index.html'),
    'utf8'
  );
  return reply.type('text/html; charset=utf-8').send(html);
});

app.get('/console/review-queue/review.css', async (_request, reply) => {
  if (!isLocalMemory) return reply.code(404).send({ code: 'NOT_FOUND' });
  const css = await readFile(
    path.join(process.cwd(), 'preview', 'review-queue', 'review.css'),
    'utf8'
  );
  return reply.type('text/css; charset=utf-8').send(css);
});

app.get('/console/review-queue/view.mjs', async (_request, reply) => {
  if (!isLocalMemory) return reply.code(404).send({ code: 'NOT_FOUND' });
  const moduleSource = await readFile(
    path.join(process.cwd(), 'preview', 'review-queue', 'view.mjs'),
    'utf8'
  );
  return reply.type('text/javascript; charset=utf-8').send(moduleSource);
});

app.get('/health', async () => ({
  service: 'freepass-data',
  status: 'ok',
  driver
}));

app.get('/v1/views/erp-public/products', async (request, reply) => {
  try {
    return await stores.access.read({
      context: {
        actor: { id: 'service:freepass-data-api', kind: 'SERVICE' },
        clientId: 'api:development',
        purpose: 'read ERP public projection through FreePass Data',
        requestId: request.id
      },
      operation: 'READ_ERP_PUBLIC_VIEW',
      resource: {
        kind: 'PROJECTION',
        name: 'erp-public',
        projectionId: 'erp-public'
      },
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
      const release = await stores.projections.getActive('erp-public');
      if (!release) {
        const error = new Error('NO_ACTIVE_RELEASE') as Error & { code: string };
        error.code = 'NO_ACTIVE_RELEASE';
        throw error;
      }
      return {
        data: release.data,
        meta: {
          schemaVersion: release.schemaVersion,
          releaseId: release.releaseId,
          manifestId: release.manifestId,
          revision: release.canonicalRevision,
          inputDigest: release.inputDigest,
          dataDigest: release.dataDigest,
          generatedAt: release.generatedAt,
          activatedAt: release.activatedAt ?? null
        }
      };
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'NO_ACTIVE_RELEASE') {
      return reply.code(503).send({ code: 'NO_ACTIVE_RELEASE' });
    }
    throw error;
  }
});

app.get('/v1/console/products/:productId/trace', async (request, reply) => {
  if (!isLocalMemory) return reply.code(404).send({ code: 'NOT_FOUND' });
  const params = request.params as { productId: string };
  const trace = await stores.access.read({
    context: {
      actor: { id: 'service:freepass-data-console', kind: 'SERVICE' },
      clientId: 'console:local',
      purpose: 'inspect product trace through FreePass Data',
      requestId: request.id
    },
    operation: 'READ_PRODUCT_TRACE',
    resource: {
      kind: 'CATALOG',
      name: 'product-trace',
      entityType: 'product',
      entityId: params.productId
    },
    summarize: (value) => value ? { count: 1 } : { count: 0 }
  }, () => buildCatalogProductTrace(
    stores.catalog,
    stores.projections,
    params.productId
  ));
  if (!trace) return reply.code(404).send({ code: 'PRODUCT_NOT_FOUND' });
  return trace;
});

app.post('/v1/commands/offers/:offerId/price', async (request, reply) => {
  if (!isLocalMemory) {
    await stores.access.deny('WRITE', {
      context: {
        actor: { id: 'service:freepass-data-api', kind: 'SERVICE' },
        clientId: 'api:development',
        purpose: 'update offer price through FreePass Data',
        requestId: request.id
      },
      operation: 'WRITE_UPDATE_OFFER_PRICE',
      resource: {
        kind: 'COMMAND',
        name: 'UPDATE_OFFER_PRICE'
      }
    }, 'COMMAND_IDENTITY_NOT_CONFIGURED');
    return reply.code(503).send({ code: 'COMMAND_IDENTITY_NOT_CONFIGURED' });
  }
  const params = request.params as { offerId: string };
  const body = request.body as Record<string, unknown>;
  if (!validateUpdateOfferPrice(body)) {
    await stores.access.deny('WRITE', {
      context: {
        actor: { id: 'service:freepass-data-console', kind: 'SERVICE' },
        clientId: 'console:local',
        purpose: 'update offer price through FreePass Data',
        requestId: request.id
      },
      operation: 'WRITE_UPDATE_OFFER_PRICE',
      resource: {
        kind: 'COMMAND',
        name: 'UPDATE_OFFER_PRICE',
        entityType: 'offer',
        entityId: params.offerId
      }
    }, 'INVALID_COMMAND');
    return reply.code(400).send({ code: 'INVALID_COMMAND', errors: validateUpdateOfferPrice.errors });
  }

  try {
    const command = {
      ...(body as any),
      offerId: params.offerId,
      writer: {
        id: 'service:freepass-data',
        kind: 'SERVICE'
      }
    };
    const receipt = await stores.access.write({
      context: {
        actor: command.actor,
        clientId: 'console:local',
        purpose: 'update offer price through FreePass Data',
        requestId: request.id,
        correlationId: command.commandId
      },
      operation: 'WRITE_UPDATE_OFFER_PRICE',
      resource: {
        kind: 'COMMAND',
        name: 'UPDATE_OFFER_PRICE',
        entityType: 'offer',
        entityId: params.offerId
      },
      requestDigest: stableDigest({
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        offerId: params.offerId,
        expectedRevision: command.expectedRevision,
        termKey: command.termKey
      }),
      summarize: (value: { revision: number }) => ({ revision: value.revision })
    }, async () => {
      const committed = await updateOfferPrice(stores.catalog, command);
      if (isLocalMemory) {
        const delivery = await processOneOutboxEvent(
          stores.catalog,
          stores.outbox,
          stores.projections,
          { workerId: 'worker:local-console' }
        );
        if (delivery !== 'DONE') {
          request.log.warn({ delivery }, 'Local projection refresh did not complete');
        }
      }
      return committed;
    });
    return reply.send(receipt);
  } catch (error) {
    if (error instanceof RevisionConflictError) {
      return reply.code(409).send({
        code: error.code,
        expectedRevision: error.expectedRevision,
        actualRevision: error.actualRevision
      });
    }
    if (error instanceof IdempotencyConflictError) {
      return reply.code(409).send({ code: error.code, idempotencyKey: error.idempotencyKey });
    }
    if (error instanceof AuthorityDeniedError) {
      return reply.code(403).send({
        code: error.code,
        aggregate: error.aggregate,
        fieldPath: error.fieldPath,
        command: error.command,
        reason: error.reason
      });
    }
    if (error instanceof WriterOwnershipDeniedError) {
      return reply.code(403).send({
        code: error.code,
        writerId: error.writerId,
        ownershipRevision: error.ownershipRevision,
        primaryWriterId: error.primaryWriterId,
        mode: error.mode,
        reason: error.reason
      });
    }
    if (error instanceof EntityNotFoundError) {
      return reply.code(404).send({ code: error.code, message: error.message });
    }
    if (error instanceof InvalidCommandError) {
      return reply.code(400).send({ code: error.code, message: error.message });
    }
    throw error;
  }
});

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
