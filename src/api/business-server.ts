import { createBusinessGateway, parseBusinessBindings } from './business-gateway.js';
import { DataAccessGateway } from '../application/data-access-gateway.js';
import { createFirestoreDataAccessLogStore } from '../infra/firestore-data-access-log.js';
import { createFirebaseBusinessStore } from '../infra/firebase-business-store.js';
import { assertBusinessRuntimeCredentialPolicy } from '../infra/firebase-target.js';
import { assertConsumerRuntime } from './runtime-policy.js';

/**
 * Dedicated business-data access runtime.
 *
 * The process identity, not consumer repositories, owns Firebase IAM.
 * Consumers receive only FreePass Data service tokens.
 */
assertConsumerRuntime();
assertBusinessRuntimeCredentialPolicy();

const bindings = parseBusinessBindings(process.env.FREEPASS_DATA_BUSINESS_CONSUMERS_JSON);
const access = new DataAccessGateway(createFirestoreDataAccessLogStore());
const store = createFirebaseBusinessStore();
const app = createBusinessGateway(store, bindings, access);

await app.listen({
  port: Number(process.env.PORT ?? 8788),
  host: process.env.HOST ?? '127.0.0.1',
});
