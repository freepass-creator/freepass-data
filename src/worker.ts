import { createRuntimeStores } from './bootstrap.js';
import { buildErpPublicProjection, processOneOutboxEvent } from './application/catalog.js';
import { MemoryDataStore } from './infra/memory-store.js';

const viaMemoryWrapper = /(?:^|[\\/])run-memory\.mjs$/.test(process.argv[1] ?? '');
const args = process.argv.slice(viaMemoryWrapper ? 3 : 2);
if (args.some(arg => arg !== '--prepare') || args.length > 1) {
  throw new Error('Unknown worker argument; use --prepare for a read-only release rehearsal');
}

const stores = await createRuntimeStores();
const workerId = process.env.WORKER_ID ?? `worker:${process.pid}`;
const requireFreshSources = process.env.FREEPASS_DATA_DRIVER === 'firestore';

if (args.includes('--prepare')) {
  // Read the configured Canonical store, but never stage, claim, or activate in Firestore.
  const memory = new MemoryDataStore();
  const ready = await buildErpPublicProjection(stores.catalog, memory, new Date().toISOString(), {
    activate: false, requireFreshSources
  });
  const manifest = await memory.getManifest(ready.releaseId);
  const report = { mode: 'PREPARE', status: ready.status, persistentWrites: 0,
    projectionStore: 'memory', products: ready.data.length, offers: manifest?.offerCount,
    fieldEvidenceCount: manifest?.fieldEvidenceCount, inputDigest: ready.inputDigest,
    dataDigest: ready.dataDigest, generatedAt: ready.generatedAt };
  await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify(report) + '\n',
    error => error ? reject(error) : resolve()));
  // The Firebase gRPC channel otherwise keeps a one-shot rehearsal alive.
  process.exit(0);
} else for (;;) {
  const result = await processOneOutboxEvent(
    stores.catalog,
    stores.outbox,
    stores.projections,
    { workerId, requireFreshSources }
  );
  if (result === 'IDLE' || result === 'HOLD') {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
