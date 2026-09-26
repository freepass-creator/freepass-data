export const FIRESTORE_COLLECTIONS = Object.freeze({
  catalog: Object.freeze({
    vehicleModels: 'catalog_vehicle_models',
    vehicleAssets: 'catalog_vehicle_assets',
    products: 'catalog_products',
    offers: 'catalog_offers',
    policies: 'catalog_policies',
    sourceBindings: 'canonical_source_bindings',
    revisions: 'catalog_entity_revisions'
  }),
  source: Object.freeze({
    definitions: 'sources',
    runs: 'source_runs',
    heads: 'source_heads',
    raw: 'raw_records',
    candidates: 'normalized_candidates',
    lineage: 'field_lineage'
  }),
  commands: Object.freeze({
    receipts: 'command_receipts',
    canonicalizationReceipts: 'canonicalization_receipts',
    manualCatalogEntryReceipts: 'manual_catalog_entry_receipts',
    reviewedSourceChangeReceipts: 'reviewed_source_change_receipts'
  }),
  ownership: Object.freeze({
    writer: 'writer_ownership',
    transferReceipts: 'writer_ownership_transfer_receipts'
  }),
  evidence: Object.freeze({
    audits: 'audit_events',
    outbox: 'outbox_events',
    dataAccessEvents: 'data_access_events'
  }),
  projection: Object.freeze({
    releases: 'projection_releases',
    manifests: 'projection_release_manifests',
    lineage: 'projection_field_lineage',
    deliveryReceipts: 'projection_delivery_receipts',
    sheetDeliveryEvidence: 'sheet_delivery_evidence',
    active: 'projection_active'
  })
} as const);

export const sourceFirestoreDocumentId = (value: string) =>
  value.replaceAll('/', '__');
