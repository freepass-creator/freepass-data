import type { CatalogStore, OutboxStore, ProjectionStore } from './ports/catalog-store.js';
import { MemoryDataStore } from './infra/memory-store.js';
import { seedDemoCatalog } from './demo-seed.js';

export type RuntimeStores = {
  catalog: CatalogStore;
  projections: ProjectionStore;
  outbox: OutboxStore;
};

export async function createRuntimeStores(): Promise<RuntimeStores> {
  const driver = process.env.FREEPASS_DATA_DRIVER ?? 'memory';

  if (driver === 'memory') {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    return { catalog: store, projections: store, outbox: store };
  }
  if (driver === 'firestore') {
    const { createFirestoreDataStore } = await import('./infra/firestore-store.js');
    const store = await createFirestoreDataStore();
    return { catalog: store, projections: store, outbox: store };
  }
  throw new Error(`Unsupported FREEPASS_DATA_DRIVER: ${driver}`);
}
