import type { ActorRef } from './domain/catalog.js';
import type { CatalogStore } from './ports/catalog-store.js';

const actor: ActorRef = { id: 'service:demo-seed', kind: 'SERVICE' };

export async function seedDemoCatalog(store: CatalogStore) {
  if (!store.seed) return;
  const now = '2026-09-20T00:00:00.000Z';
  const meta = (lineageId: string) => ({
    schemaVersion: '1.0.0', revision: 1, validationStatus: 'VALID' as const,
    createdAt: now, updatedAt: now, createdBy: actor, updatedBy: actor, lineageId
  });
  await store.seed({
    vehicleModels: [{
      id: 'vm_gv70_demo', maker: '제네시스', model: 'GV70', generation: 'JK1',
      trim: '2.5T AWD', fuel: '가솔린', drive: 'AWD', seats: 5,
      displayName: '제네시스 GV70 2.5T AWD', ...meta('lin_vm_gv70')
    }],
    vehicleAssets: [{
      id: 'va_gv70_demo', vehicleModelId: 'vm_gv70_demo', plateNumber: '00가0000',
      odometerKm: 31200, status: 'AVAILABLE', ...meta('lin_va_gv70')
    }],
    products: [{
      id: 'prod_gv70_demo', vehicleModelId: 'vm_gv70_demo', vehicleAssetId: 'va_gv70_demo',
      productType: 'USED', status: 'ACTIVE', displayName: '제네시스 GV70',
      ...meta('lin_prod_gv70')
    }],
    offers: [{
      id: 'offer_gv70_demo', productId: 'prod_gv70_demo', supplierId: 'supplier_demo',
      status: 'ACTIVE', priceTerms: [{
        termMonths: 36,
        monthlyRent: { amount: 690000, currency: 'KRW' },
        deposit: { amount: 3000000, currency: 'KRW' },
        depositState: 'KNOWN',
        mileageLimitKmPerYear: 20000
      }], ...meta('lin_offer_gv70')
    }]
  });
}
