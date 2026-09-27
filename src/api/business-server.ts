import { createBusinessGateway, parseBusinessBindings } from './business-gateway.js';
import { createBusinessDataAccessRuntime } from './business-data-access-runtime.js';
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
const runtime = createBusinessDataAccessRuntime();
const app = createBusinessGateway(runtime.store, bindings, runtime.access);

await app.listen({
  port: Number(process.env.PORT ?? 8788),
  host: process.env.HOST ?? '127.0.0.1',
});
