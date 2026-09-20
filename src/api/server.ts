import Fastify from 'fastify';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import updateOfferPriceSchema from '../../contracts/update-offer-price.schema.json' with { type: 'json' };
import { createRuntimeStores } from '../bootstrap.js';
import {
  EntityNotFoundError,
  InvalidCommandError,
  RevisionConflictError,
  buildErpPublicProjection,
  updateOfferPrice
} from '../application/catalog.js';

const app = Fastify({ logger: true });
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateUpdateOfferPrice = ajv.compile(updateOfferPriceSchema);
const stores = await createRuntimeStores();

await buildErpPublicProjection(stores.catalog, stores.projections);

app.get('/health', async () => ({
  service: 'freepass-data',
  status: 'ok',
  driver: process.env.FREEPASS_DATA_DRIVER ?? 'memory'
}));

app.get('/v1/views/erp-public/products', async (_request, reply) => {
  const release = await stores.projections.getActive('erp-public');
  if (!release) return reply.code(503).send({ code: 'NO_ACTIVE_RELEASE' });
  return {
    data: release.data,
    meta: {
      schemaVersion: release.schemaVersion,
      releaseId: release.releaseId,
      revision: release.canonicalRevision,
      generatedAt: release.generatedAt,
      activatedAt: release.activatedAt ?? null
    }
  };
});

app.post('/v1/commands/offers/:offerId/price', async (request, reply) => {
  const params = request.params as { offerId: string };
  const body = request.body as Record<string, unknown>;
  if (!validateUpdateOfferPrice(body)) {
    return reply.code(400).send({ code: 'INVALID_COMMAND', errors: validateUpdateOfferPrice.errors });
  }

  try {
    const receipt = await updateOfferPrice(stores.catalog, {
      ...(body as any),
      offerId: params.offerId
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
await app.listen({ port, host: '0.0.0.0' });
