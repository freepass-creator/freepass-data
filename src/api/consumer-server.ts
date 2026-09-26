import { createConsumerGateway, parseConsumerBindings } from './consumer-gateway.js';
import { createConsumerDataAccessRuntime } from './data-access-runtime.js';
import { assertConsumerRuntime } from './runtime-policy.js';

// Dedicated read service: no demo seed, worker, command route, or release publication.
assertConsumerRuntime();
const bindings = parseConsumerBindings(process.env.FREEPASS_DATA_CONSUMERS_JSON);
const runtime = createConsumerDataAccessRuntime();
const app = createConsumerGateway(
  runtime.projection,
  bindings,
  runtime.access,
  runtime.health
);
await app.listen({ port: Number(process.env.PORT ?? 8787), host: process.env.HOST ?? '127.0.0.1' });
