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

assertDevelopmentApi();
const app = Fastify({ logger: true });
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validateUpdateOfferPrice = ajv.compile(updateOfferPriceSchema);
const stores = await createRuntimeStores();
const driver = process.env.FREEPASS_DATA_DRIVER ?? 'memory';
const isLocalMemory = driver === 'memory';

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

app.get('/health', async () => ({
  service: 'freepass-data',
  status: 'ok',
  driver
}));

app.get('/v1/views/erp-public/products', async (_request, reply) => {
  const release = await stores.projections.getActive('erp-public');
  if (!release) return reply.code(503).send({ code: 'NO_ACTIVE_RELEASE' });
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

app.post('/v1/commands/offers/:offerId/price', async (request, reply) => {
  if (!isLocalMemory) {
    return reply.code(503).send({ code: 'COMMAND_IDENTITY_NOT_CONFIGURED' });
  }
  const params = request.params as { offerId: string };
  const body = request.body as Record<string, unknown>;
  if (!validateUpdateOfferPrice(body)) {
    return reply.code(400).send({ code: 'INVALID_COMMAND', errors: validateUpdateOfferPrice.errors });
  }

  try {
    const receipt = await updateOfferPrice(stores.catalog, {
      ...(body as any),
      offerId: params.offerId,
      writer: {
        id: 'service:freepass-data',
        kind: 'SERVICE'
      }
    });
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
