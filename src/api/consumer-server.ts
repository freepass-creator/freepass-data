import { createConsumerGateway, parseConsumerBindings } from './consumer-gateway.js';
import { createFirestoreProjectionReader } from '../infra/firestore-projection-reader.js';
import { assertConsumerRuntime } from './runtime-policy.js';

// Dedicated read service: no demo seed, worker, command route, or release publication.
assertConsumerRuntime();
const bindings = parseConsumerBindings(process.env.FREEPASS_DATA_CONSUMERS_JSON);
const store = createFirestoreProjectionReader();
const app = createConsumerGateway(store, bindings);
await app.listen({ port: Number(process.env.PORT ?? 8787), host: process.env.HOST ?? '127.0.0.1' });
