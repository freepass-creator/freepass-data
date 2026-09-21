import type {
  ActorRef,
  Offer,
  Product,
  VehicleAsset,
  VehicleModel
} from './domain/catalog.js';
import type { EntityRevisionRecord } from './domain/history.js';
import type { CanonicalSourceBinding } from './domain/canonicalization.js';
import type { FieldLineageRecord } from './domain/lineage.js';
import type {
  NormalizedCandidateRecord,
  RawRecord,
  SourceDefinition,
  SourceHead,
  SourceRun
} from './domain/source.js';
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

  const sourceId = 'local-demo/catalog-file';
  const runId = 'run_demo_catalog_20260920';
  const sourceRecordId = 'gv70-demo-001';
  const sourceFingerprint = 'sha256:demo-gv70-v1';
  const rawRecordId = 'raw_demo_gv70_001';
  const candidateId = 'cand_demo_gv70_001';
  const bindingId = 'binding_demo_gv70';
  const source: SourceDefinition = {
    sourceId,
    kind: 'FILE',
    displayName: '로컬 데모 카탈로그 파일',
    authorityScope: ['catalog:demo'],
    expectedFreshnessSeconds: null,
    health: 'HEALTHY',
    enabled: true
  };
  const checkpoint = {
    sourceId,
    sourceRevision: 'demo-v1',
    checksum: sourceFingerprint,
    observedAt: now
  };
  const coverage = {
    mode: 'FULL' as const,
    completeness: 'COMPLETE' as const,
    scope: 'one local demo catalog record',
    note: 'Local-only evidence used to exercise the complete data path.'
  };
  const run: SourceRun = {
    runId,
    sourceId,
    status: 'COMPLETED',
    startedAt: now,
    completedAt: now,
    observedAt: now,
    checkpoint,
    coverage,
    headStatus: 'CURRENT',
    rawCount: 1,
    candidateCount: 1,
    warningCount: 0
  };
  const head: SourceHead = {
    sourceId,
    runId,
    observedAt: now,
    acceptedAt: now,
    checkpoint,
    coverage
  };
  const rawPayload = {
    product_code: 'DEMO-GV70-001',
    car_number: '00가0000',
    maker: '제네시스',
    model: 'GV70',
    sub_model: 'JK1',
    trim: '2.5T AWD',
    product_type: 'USED_RENT',
    provider_company_code: 'supplier_demo',
    vehicle_status: 'AVAILABLE',
    fuel_type: '가솔린',
    mileage_km: 31200,
    drive_type: 'AWD',
    seats: 5,
    price_terms: {
      '36@20000': {
        term_months: 36,
        monthly_rent: 690000,
        deposit: 3000000,
        mileage_limit_km_per_year: 20000
      }
    }
  };
  const raw: RawRecord = {
    rawRecordId,
    runId,
    sourceId,
    sourceRecordId,
    sourceFingerprint,
    observedAt: now,
    payload: rawPayload
  };
  const candidate: NormalizedCandidateRecord = {
    candidateId,
    runId,
    sourceId,
    sourceRecordId,
    sourceFingerprint,
    status: 'VALID',
    candidate: {
      sourceRecordId,
      sourceFingerprint,
      productCode: 'DEMO-GV70-001',
      carNumber: '00가0000',
      maker: '제네시스',
      model: 'GV70',
      subModel: 'JK1',
      trimName: '2.5T AWD',
      commercialType: 'USED_RENT',
      providerCompanyCode: 'supplier_demo',
      vehicleStatusRaw: 'AVAILABLE',
      fuelType: '가솔린',
      mileageKm: 31200,
      driveType: 'AWD',
      seats: 5,
      priceTerms: structuredClone(offer.priceTerms),
      issues: []
    }
  };
  const binding: CanonicalSourceBinding = {
    bindingId,
    sourceId,
    sourceRecordId,
    sourceFingerprint,
    sourceRunId: runId,
    sourceObservedAt: now,
    sourceCheckpointRevision: checkpoint.sourceRevision,
    sourceCheckpointChecksum: checkpoint.checksum,
    sourceSupplierCode: 'supplier_demo',
    vehicleModelId: model.id,
    vehicleAssetId: asset.id,
    productId: product.id,
    offerId: offer.id,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
    updatedBy: actor
  };

  const lineageFields: Array<{
    entityType: EntityRevisionRecord['entityType'];
    entityId: string;
    sourceFieldPath: string;
    sourceValue: unknown;
    normalizedFieldPath: string;
    normalizedValue: unknown;
    canonicalFieldPath: string;
    canonicalValue: unknown;
  }> = [
    { entityType: 'vehicle_model', entityId: model.id, sourceFieldPath: 'maker', sourceValue: '제네시스', normalizedFieldPath: 'maker', normalizedValue: '제네시스', canonicalFieldPath: 'maker', canonicalValue: '제네시스' },
    { entityType: 'vehicle_model', entityId: model.id, sourceFieldPath: 'model', sourceValue: 'GV70', normalizedFieldPath: 'model', normalizedValue: 'GV70', canonicalFieldPath: 'model', canonicalValue: 'GV70' },
    { entityType: 'vehicle_model', entityId: model.id, sourceFieldPath: 'sub_model', sourceValue: 'JK1', normalizedFieldPath: 'subModel', normalizedValue: 'JK1', canonicalFieldPath: 'generation', canonicalValue: 'JK1' },
    { entityType: 'vehicle_model', entityId: model.id, sourceFieldPath: 'trim', sourceValue: '2.5T AWD', normalizedFieldPath: 'trimName', normalizedValue: '2.5T AWD', canonicalFieldPath: 'trim', canonicalValue: '2.5T AWD' },
    { entityType: 'vehicle_model', entityId: model.id, sourceFieldPath: 'fuel_type', sourceValue: '가솔린', normalizedFieldPath: 'fuelType', normalizedValue: '가솔린', canonicalFieldPath: 'fuel', canonicalValue: '가솔린' },
    { entityType: 'vehicle_model', entityId: model.id, sourceFieldPath: 'drive_type', sourceValue: 'AWD', normalizedFieldPath: 'driveType', normalizedValue: 'AWD', canonicalFieldPath: 'drive', canonicalValue: 'AWD' },
    { entityType: 'vehicle_model', entityId: model.id, sourceFieldPath: 'seats', sourceValue: 5, normalizedFieldPath: 'seats', normalizedValue: 5, canonicalFieldPath: 'seats', canonicalValue: 5 },
    { entityType: 'vehicle_asset', entityId: asset.id, sourceFieldPath: 'car_number', sourceValue: '00가0000', normalizedFieldPath: 'carNumber', normalizedValue: '00가0000', canonicalFieldPath: 'plateNumber', canonicalValue: '00가0000' },
    { entityType: 'vehicle_asset', entityId: asset.id, sourceFieldPath: 'mileage_km', sourceValue: 31200, normalizedFieldPath: 'mileageKm', normalizedValue: 31200, canonicalFieldPath: 'odometerKm', canonicalValue: 31200 },
    { entityType: 'vehicle_asset', entityId: asset.id, sourceFieldPath: 'vehicle_status', sourceValue: 'AVAILABLE', normalizedFieldPath: 'vehicleStatusRaw', normalizedValue: 'AVAILABLE', canonicalFieldPath: 'status', canonicalValue: 'AVAILABLE' },
    { entityType: 'product', entityId: product.id, sourceFieldPath: 'product_type', sourceValue: 'USED_RENT', normalizedFieldPath: 'commercialType', normalizedValue: 'USED_RENT', canonicalFieldPath: 'commercialType', canonicalValue: 'USED_RENT' },
    { entityType: 'offer', entityId: offer.id, sourceFieldPath: 'provider_company_code', sourceValue: 'supplier_demo', normalizedFieldPath: 'providerCompanyCode', normalizedValue: 'supplier_demo', canonicalFieldPath: 'supplierId', canonicalValue: 'supplier_demo' },
    { entityType: 'offer', entityId: offer.id, sourceFieldPath: 'price_terms.36@20000.term_months', sourceValue: 36, normalizedFieldPath: 'priceTerms.36@20000.termMonths', normalizedValue: 36, canonicalFieldPath: 'priceTerms.36@20000.termMonths', canonicalValue: 36 },
    { entityType: 'offer', entityId: offer.id, sourceFieldPath: 'price_terms.36@20000.monthly_rent', sourceValue: 690000, normalizedFieldPath: 'priceTerms.36@20000.monthlyRent.amount', normalizedValue: 690000, canonicalFieldPath: 'priceTerms.36@20000.monthlyRent.amount', canonicalValue: 690000 },
    { entityType: 'offer', entityId: offer.id, sourceFieldPath: 'price_terms.36@20000.deposit', sourceValue: 3000000, normalizedFieldPath: 'priceTerms.36@20000.deposit.amount', normalizedValue: 3000000, canonicalFieldPath: 'priceTerms.36@20000.deposit.amount', canonicalValue: 3000000 },
    { entityType: 'offer', entityId: offer.id, sourceFieldPath: 'price_terms.36@20000.mileage_limit_km_per_year', sourceValue: 20000, normalizedFieldPath: 'priceTerms.36@20000.mileageLimitKmPerYear', normalizedValue: 20000, canonicalFieldPath: 'priceTerms.36@20000.mileageLimitKmPerYear', canonicalValue: 20000 }
  ];
  const lineage: FieldLineageRecord[] = lineageFields.flatMap((field, index) => {
    const rawLineageId = `lin_demo_raw_${index + 1}`;
    return [{
      lineageRecordId: rawLineageId,
      lineageId: `lineage_demo_${index + 1}`,
      stage: 'RAW_TO_NORMALIZED',
      runId,
      sourceId,
      sourceRecordId,
      sourceFingerprint,
      observedAt: now,
      source: { fieldPath: field.sourceFieldPath, value: field.sourceValue },
      normalized: { candidateId, fieldPath: field.normalizedFieldPath, value: field.normalizedValue },
      transformId: 'demo-catalog-normalizer',
      transformVersion: '1.0.0'
    }, {
      lineageRecordId: `lin_demo_canonical_${index + 1}`,
      lineageId: `lineage_demo_${index + 1}`,
      stage: 'NORMALIZED_TO_CANONICAL',
      parentLineageRecordId: rawLineageId,
      runId,
      sourceId,
      sourceRecordId,
      sourceFingerprint,
      observedAt: now,
      source: { fieldPath: field.sourceFieldPath, value: field.sourceValue },
      normalized: { candidateId, fieldPath: field.normalizedFieldPath, value: field.normalizedValue },
      canonical: {
        entityType: field.entityType,
        entityId: field.entityId,
        revision: 1,
        fieldPath: field.canonicalFieldPath,
        value: field.canonicalValue
      },
      transformId: 'demo-catalog-canonicalizer',
      transformVersion: '1.0.0'
    } satisfies FieldLineageRecord];
  });
  run.lineageCount = lineage.length;

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
    occurredAt: now,
    sourceBindingId: bindingId,
    sourceRunId: runId
  });

  await store.seed({
    vehicleModels: [model],
    vehicleAssets: [asset],
    products: [product],
    offers: [offer],
    sourceDefinitions: [source],
    sourceRuns: [run],
    sourceHeads: [head],
    rawRecords: [raw],
    candidates: [candidate],
    lineage,
    sourceBindings: [binding],
    revisionHistory: [
      revision('vehicle_model', model.id, model),
      revision('vehicle_asset', asset.id, asset),
      revision('product', product.id, product),
      revision('offer', offer.id, offer)
    ]
  });
}
