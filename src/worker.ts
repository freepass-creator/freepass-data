import { readFile } from 'node:fs/promises';
import { stableDigest } from './shared/stable-digest.js';
import { createRuntimeStores } from './bootstrap.js';
import { buildErpPublicProjection, processOneOutboxEvent, updateOfferPrice } from './application/catalog.js';
import { MemoryDataStore } from './infra/memory-store.js';

const viaMemoryWrapper = /(?:^|[\\/])run-memory\.mjs$/.test(process.argv[1] ?? '');
const args = process.argv.slice(viaMemoryWrapper ? 3 : 2);
const prepare = args.length === 0 || (args.length === 1 && args[0] === '--prepare');
const execute = args.length === 1 && args[0] === '--execute';
const single = args.length === 4 && args[0] === '--event-id' && args[2] === '--expires-at';
const eventId = single ? args[1] : undefined;
const expiresAt = single ? args[3] : undefined;
if ((!prepare && !execute && !single) ||
    (single && (!eventId || !/^[A-Za-z0-9:_-]{1,200}$/.test(eventId) || !expiresAt ||
      !Number.isFinite(Date.parse(expiresAt))))) {
  throw new Error('Use --prepare, --execute, or --event-id <id> --expires-at <ISO timestamp>');
}
if (single && Date.parse(expiresAt!) <= Date.now()) throw new Error('Execution approval expired');

const stores = await createRuntimeStores();
const workerId = process.env.WORKER_ID ?? `worker:${process.pid}`;
const requireFreshSources = process.env.FREEPASS_DATA_DRIVER === 'firestore';
if (execute && process.env.NODE_ENV === 'test' && process.env.FREEPASS_DATA_WORKER_TEST_REPRICE === '1') {
  await buildErpPublicProjection(stores.catalog, stores.projections);
  await updateOfferPrice(stores.catalog, {
    commandId: 'cmd_worker_execute_loop_test',
    idempotencyKey: 'idem_worker_execute_loop_test',
    offerId: 'offer_gv70_demo',
    expectedRevision: 1,
    termKey: '36@20000',
    monthlyRent: { amount: 734000, currency: 'KRW' },
    reason: 'worker execute loop regression',
    actor: { id: 'user:test', kind: 'USER' }
  }, '2026-09-20T10:00:00.000Z');
}

if (prepare) {
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
} else if (single) {
  let expectedEventDigest: string | undefined;
  if (requireFreshSources && !(await stores.projections.getActive('erp-public'))) {
    const path = process.env.FREEPASS_DATA_FIRST_ACTIVE_BACKUP_PATH;
    const approvedDigest = process.env.FREEPASS_DATA_FIRST_ACTIVE_BACKUP_DIGEST;
    if (!stores.outbox.captureFirstActivationPreimage || !path || !approvedDigest) throw new Error('FIRST_ACTIVE_APPROVED_BACKUP_REQUIRED');
    const backup = JSON.parse(await readFile(path, 'utf8'));
    const { digest, ...body } = backup;
    if (digest !== approvedDigest || stableDigest(body) !== digest || backup.eventId !== eventId ||
        (await stores.outbox.captureFirstActivationPreimage(eventId!)).digest !== approvedDigest)
      throw new Error('FIRST_ACTIVE_APPROVED_BACKUP_CHANGED');
    expectedEventDigest = stableDigest(backup.event);
  }
  const result = await processOneOutboxEvent(stores.catalog, stores.outbox, stores.projections,
    { workerId, requireFreshSources, eventId: eventId!, expiresAt: expiresAt!, ...(expectedEventDigest ? { expectedEventDigest, expectedActiveReleaseId: null } : {}) });
  await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify({ mode: 'SINGLE_EVENT', eventId, result }) + '\n',
    error => error ? reject(error) : resolve()));
  process.exit(result === 'DONE' ? 0 : 2);
} else if (execute) {
  const maxEvents = process.env.NODE_ENV === 'test' && process.env.FREEPASS_DATA_WORKER_MAX_EVENTS
    ? Number.parseInt(process.env.FREEPASS_DATA_WORKER_MAX_EVENTS, 10)
    : null;
  let processedEvents = 0;
  for (;;) {
    const currentActive = await stores.projections.getActive('erp-public');
    if (requireFreshSources && !currentActive) throw new Error('FIRST_ACTIVE_REQUIRES_APPROVED_SINGLE_EVENT');
    const result = await processOneOutboxEvent(
      stores.catalog,
      stores.outbox,
      stores.projections,
      { workerId, requireFreshSources, ...(currentActive ? { expectedActiveReleaseId: currentActive.releaseId } : {}) }
    );
    if (maxEvents !== null && result === 'DONE' && ++processedEvents >= maxEvents) {
      const active = await stores.projections.getActive('erp-public');
      await new Promise<void>((resolve, reject) => process.stdout.write(JSON.stringify({
        mode: 'EXECUTE',
        result,
        processedEvents,
        activeReleaseId: active?.releaseId,
        monthlyRent: active?.data[0]?.offers[0]?.priceTerms[0]?.monthlyRent.amount
      }) + '\n', error => error ? reject(error) : resolve()));
      process.exit(0);
    }
    if (result === 'IDLE' || result === 'HOLD') {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
