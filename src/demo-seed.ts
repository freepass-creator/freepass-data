import type {
  ActorRef,
  Offer,
  Product,
  VehicleAsset,
  VehicleModel
} from './domain/catalog.js';
import type { EntityRevisionRecord } from './domain/history.js';
import type { CatalogStore } from './ports/catalog-store.js';

const actor: ActorRef = { id: 'service:demo-seed', kind: 'SERVICE' };

export async function seedDemoCatalog(store: CatalogStore) {
  if (!store.seed) return;

  const now = '2026-09-20T00:00:00.000Z';
  const meta = (lineageId: string) => ({
    schemaVersion: '1.0.0',
    revision: 1,
    validationStatus: 'VALID' as const,
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
    updatedBy: actor,
    lineageId
  });

  const model: VehicleModel = {
    id: 'vm_gv70_demo',
    maker: '제네시스',
    model: 'GV70',
    generation: 'JK1',
    trim: '2.5T AWD',
    fuel: '가솔린',
    drive: 'AWD',
    seats: 5,
    displayName: '제네시스 GV70 2.5T AWD',
    ...meta('lin_vm_gv70')
  };

  const asset: VehicleAsset = {
    id: 'va_gv70_demo',
    vehicleModelId: model.id,
    plateNumber: '00가0000',
    odometerKm: 31200,
    status: 'AVAILABLE',
    ...meta('lin_va_gv70')
  };

  const product: Product = {
    id: 'prod_gv70_demo',
    vehicleModelId: model.id,
    vehicleAssetId: asset.id,
    commercialType: 'USED_RENT',
    status: 'ACTIVE',
    displayName: '제네시스 GV70',
    ...meta('lin_prod_gv70')
  };

  const offer: Offer = {
    id: 'offer_gv70_demo',
    productId: product.id,
    supplierId: 'supplier_demo',
    status: 'ACTIVE',
    priceTerms: [{
      termKey: '36@20000',
      termMonths: 36,
      monthlyRent: { amount: 690000, currency: 'KRW' },
      deposit: { amount: 3000000, currency: 'KRW' },
      depositState: 'KNOWN',
      mileageLimitKmPerYear: 20000
    }],
    ...meta('lin_offer_gv70')
  };

  const revision = (
    entityType: EntityRevisionRecord['entityType'],
    entityId: string,
    snapshot: unknown
  ): EntityRevisionRecord => ({
    revisionRecordId: `rev_demo_${entityType}_${entityId}_1`,
    entityType,
    entityId,
    revision: 1,
    previousRevision: null,
    snapshot,
    actor,
    reason: 'demo catalog baseline',
    origin: 'MIGRATION',
    commandId: 'cmd_demo_seed',
    occurredAt: now
  });

  await store.seed({
    vehicleModels: [model],
    vehicleAssets: [asset],
    products: [product],
    offers: [offer],
    revisionHistory: [
      revision('vehicle_model', model.id, model),
      revision('vehicle_asset', asset.id, asset),
      revision('product', product.id, product),
      revision('offer', offer.id, offer)
    ]
  });
}
