import { createRuntimeStores } from './bootstrap.js';
import { processOneOutboxEvent } from './application/catalog.js';

const stores = await createRuntimeStores();
const workerId = process.env.WORKER_ID ?? `worker:${process.pid}`;

for (;;) {
  const result = await processOneOutboxEvent(
    stores.catalog,
    stores.outbox,
    stores.projections,
    { workerId }
  );
  if (result === 'IDLE') {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
