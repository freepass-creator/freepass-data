import type { CatalogStore, OutboxStore, ProjectionStore } from './ports/catalog-store.js';
import { MemoryDataStore } from './infra/memory-store.js';
import { seedDemoCatalog } from './demo-seed.js';
import { DataAccessGateway } from './application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from './infra/memory-data-access-log.js';

export type RuntimeStores = {
  catalog: CatalogStore;
  projections: ProjectionStore;
  outbox: OutboxStore;
  access: DataAccessGateway;
};

export async function createRuntimeStores(): Promise<RuntimeStores> {
  const driver = process.env.FREEPASS_DATA_DRIVER ?? 'memory';

  if (process.env.NODE_ENV === 'production' && driver !== 'firestore') {
    throw new Error('Production FreePass Data requires the firestore driver; demo data is prohibited');
  }

  if (driver === 'memory') {
    const store = new MemoryDataStore();
    await seedDemoCatalog(store);
    return {
      catalog: store,
      projections: store,
      outbox: store,
      access: new DataAccessGateway(new MemoryDataAccessLogStore())
    };
  }
  if (driver === 'firestore') {
    const { createFirestoreDataStore } = await import('./infra/firestore-store.js');
    const { createFirestoreDataAccessLogStore } = await import('./infra/firestore-data-access-log.js');
    const store = await createFirestoreDataStore();
    return {
      catalog: store,
      projections: store,
      outbox: store,
      access: new DataAccessGateway(createFirestoreDataAccessLogStore())
    };
  }
  throw new Error(`Unsupported FREEPASS_DATA_DRIVER: ${driver}`);
}
