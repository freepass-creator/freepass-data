import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { CatalogStore } from '../ports/catalog-store.js';
import { plateIdentityKey } from '../domain/vehicle-plate.js';
import { parseLocalArgs, writePrivateArtifact } from './ingest-shared-sheet-canonical.js';
import { stableDigest } from '../shared/stable-digest.js';
import { toInternalFeeLookup } from '../domain/internal-fee-lookup-contract.js';
import { sharedSheetRegisteredChannels } from '../adapters/shared-sheet-source.js';
import { joinStoredProductEconomics } from '../application/resolve-offer-commercial-terms.js';
import type { PeriodFeeLedgerRow } from '../application/period-fee-ledger-plan.js';

export type ProductSearch = { productId?: string; supplierId?: string; supplierName?: string; vehicleName?: string; plate?: string };
const searchText = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase('ko');

/** Internal stored-fact reader, not a new API or persistence path. Missing joins remain visible.
 * Supplier names use the existing registered supplier mapping; no fuzzy identity inference.
 */
export async function queryCanonicalProducts(store: CatalogStore, search: ProductSearch = {}, ledgerRows: readonly PeriodFeeLedgerRow[] = []) {
  const allowed = ['productId', 'supplierId', 'supplierName', 'vehicleName', 'plate'];
  for (const [key, value] of Object.entries(search))
    if (!allowed.includes(key) || typeof value !== 'string' || !value.trim()) throw new Error('INVALID_PRODUCT_SEARCH');
  const identity = search.plate === undefined ? null : plateIdentityKey(search.plate);
  if (search.plate !== undefined && !identity) throw new Error('PLATE_REQUIRED');
  const [products, offers, assets, models, policies] = await Promise.all([
    store.listProducts(), store.listOffers(), store.listVehicleAssets(), store.listVehicleModels(), store.listPolicies(),
  ]);
  const results = [];
  const unresolvedSupplierProducts = new Set<string>();
  const supplierTermResolved = search.supplierName === undefined ? null
    : sharedSheetRegisteredChannels.some(x => searchText(x.companyName) === searchText(search.supplierName!));
  for (const product of products) {
    if (search.productId && product.id !== search.productId.trim()) continue;
    const asset = assets.find(x => x.id === product.vehicleAssetId) ?? null;
    const model = models.find(x => x.id === product.vehicleModelId) ?? null;
    if (identity && (!asset || plateIdentityKey(asset.plateNumber) !== identity)) continue;
    if (search.vehicleName && !searchText([product.displayName, model?.maker, model?.model, model?.subModel, model?.trim].filter(Boolean).join(' '))
      .includes(searchText(search.vehicleName))) continue;
    const linked = offers.filter(x => x.productId === product.id);
    if (!linked.length || linked.some(x => !x.supplierId)) unresolvedSupplierProducts.add(product.id);
    for (const offer of linked.length ? linked : [null]) {
      const supplierName = sharedSheetRegisteredChannels.find(x => x.code === offer?.supplierId)?.companyName ?? null;
      if (search.supplierId && offer?.supplierId !== search.supplierId.trim()) continue;
      if (search.supplierName && (supplierName === null || searchText(supplierName) !== searchText(search.supplierName))) continue;
      const policy = policies.find(x => x.id === offer?.policyId) ?? null;
      const fees = offer ? toInternalFeeLookup(offer.id, offer.priceTerms, offer.internalEconomicsTerms) : null;
      const unknownFields = ['photos']; // Catalog currently has no registered media fact. Never report zero.
      if (asset?.sourceVehicleFacts?.fields.options?.state !== 'KNOWN') unknownFields.push('options');
      if (!model) unknownFields.push('vehicleModel');
      if (!asset) unknownFields.push('vehicleAsset');
      if (!offer) unknownFields.push('offer', 'supplier', 'priceTerms');
      if (!supplierName) unknownFields.push('supplierName');
      if (!policy) unknownFields.push('policy');
      for (const key of ['maker', 'model', 'subModel', 'trim', 'fuel', 'drive', 'seats'] as const)
        if (model?.[key] == null || model[key] === '') unknownFields.push(`vehicle.${key}`);
      for (const [key, fact] of Object.entries(asset?.sourceVehicleFacts?.fields ?? {}))
        if (fact.state !== 'KNOWN') unknownFields.push(`vehicle.facts.${key}`);
      const terms = (offer?.priceTerms ?? []).map((term, index) => {
        const fee = fees!.terms[index]!;
        if (term.depositState === 'UNKNOWN') unknownFields.push(`terms.${term.termKey}.deposit`);
        for (const side of ['supplierBillingFee', 'channelPayoutFee'] as const)
          if (fee[side].state === 'UNKNOWN') unknownFields.push(`terms.${term.termKey}.${side}`);
        return { ...structuredClone(term), supplierBillingFee: fee.supplierBillingFee, channelPayoutFee: fee.channelPayoutFee };
      });
      results.push({ productId: product.id, offerId: offer?.id ?? null, assetId: asset?.id ?? null,
        supplierId: offer?.supplierId ?? null, supplierName, displayName: product.displayName,
        commercialType: product.commercialType, productStatus: product.status,
        product: structuredClone(product), offer: offer ? structuredClone(offer) : null,
        vehicleModel: model ? structuredClone(model) : null, vehicleAsset: asset ? structuredClone(asset) : null,
        policy: policy ? structuredClone(policy) : null, terms,
        storedEconomics: joinStoredProductEconomics(product.id, offer ? [offer] : [], ledgerRows),
        priceTermsState: terms.length ? 'KNOWN' as const : 'UNKNOWN' as const,
        photos: { state: 'UNKNOWN' as const, count: null, references: null, reasonCode: 'CATALOG_MEDIA_NOT_CONNECTED' },
        unknownFields: [...new Set(unknownFields)].sort(),
        feeContract: fees?.contract ?? null, orphanFeeTermKeys: fees?.orphanTermKeys ?? [],
      });
    }
  }
  return { schema: 'freepass-data.internal-product-query/v1', authority: 'STORED_CANONICAL',
    observedAt: new Date().toISOString(), matchedProducts: new Set(results.map(x => x.productId)).size,
    supplierTermResolved, unresolvedSupplierProducts: unresolvedSupplierProducts.size, results };
}

export async function queryFirestoreProducts(search: ProductSearch = {}, ledgerRows: readonly PeriodFeeLedgerRow[] = []) {
  const { withSharedSheetCatalogAccess } = await import('./data-access-runtime.js');
  return withSharedSheetCatalogAccess(false, stableDigest(['internal-direct-product-query']),
    store => queryCanonicalProducts(store, search, ledgerRows));
}

/** Internal server-only contract. Read saved facts; never recompute or publish them. */
export async function queryCanonicalByPlate(store: CatalogStore, plate: string) {
  const identity = plateIdentityKey(plate);
  if (!identity) throw new Error('PLATE_REQUIRED');
  const assets = (await store.listVehicleAssets()).filter(x => plateIdentityKey(x.plateNumber) === identity);
  const products = await store.listProducts(), offers = await store.listOffers();
  const results = [];
  for (const asset of assets) {
    const model = await store.getVehicleModel(asset.vehicleModelId);
    for (const product of products.filter(x => x.vehicleAssetId === asset.id)) {
      for (const offer of offers.filter(x => x.productId === product.id)) {
        const fees = toInternalFeeLookup(offer.id, offer.priceTerms, offer.internalEconomicsTerms);
        results.push({ productId: product.id, offerId: offer.id, assetId: asset.id,
          displayName: product.displayName, commercialType: product.commercialType,
          productStatus: product.status, offerStatus: offer.status, assetStatus: asset.status,
          supplierId: offer.supplierId, assetRevision: asset.revision, productRevision: product.revision, offerRevision: offer.revision,
          vehicle: { plateNumber: asset.plateNumber ?? null, fuel: model?.fuel ?? null,
            drive: model?.drive ?? null, seats: model?.seats ?? null,
            maker: model?.maker ?? null, model: model?.model ?? null, subModel: model?.subModel ?? null,
            trim: model?.trim ?? null, odometerKm: asset.odometerKm ?? null, facts: asset.sourceVehicleFacts ?? null,
            sourceFirstObservedAt: asset.sourceFirstObservedAt ?? null, sourceFirstRunId: asset.sourceFirstRunId ?? null },
          feeContract: fees.contract, orphanFeeTermKeys: fees.orphanTermKeys,
          terms: offer.priceTerms.map((term, index) => {
            return { ...term, supplierBillingFee: fees.terms[index]!.supplierBillingFee,
              channelPayoutFee: fees.terms[index]!.channelPayoutFee };
          }) });
      }
    }
  }
  return { schema: 'freepass-data.internal-canonical-query/v1', authority: 'STORED_CANONICAL',
    observedAt: new Date().toISOString(), matchedAssets: assets.length, results };
}
/** Uses the one central target resolver and ADC. Caller needs its own approved read identity.
 * No Cloud Run dependency, credential copying, writes or memory fallback.
 */
export async function queryFirestoreByPlate(plate: string) {
  if (!plateIdentityKey(plate)) throw new Error('PLATE_REQUIRED');
  const { withSharedSheetCatalogAccess } = await import('./data-access-runtime.js');
  return withSharedSheetCatalogAccess(false, stableDigest(['internal-direct-plate-query']),
    store => queryCanonicalByPlate(store, plate));
}
export async function main(args = process.argv.slice(2)) {
  const a = parseLocalArgs(args, ['--memory', '--firestore', '--direct', '--stored-products'], ['--plate-file', '--search-file', '--local-output']);
  if (a.has('--plate-file') === a.has('--search-file') || !a.has('--local-output')) throw new Error('LOCAL_INPUT_OUTPUT_REQUIRED');
  if (a.has('--direct') && (!a.has('--firestore') || a.has('--memory'))) throw new Error('DIRECT_FIRESTORE_REQUIRED');
  if (a.has('--stored-products')) {
    if (!a.has('--firestore') || !a.has('--direct') || a.has('--memory')) throw new Error('DIRECT_FIRESTORE_REQUIRED');
    const search = a.has('--search-file') ? JSON.parse(await readFile(a.get('--search-file')!, 'utf8'))
      : { plate: (await readFile(a.get('--plate-file')!, 'utf8')).trim() };
    if (!search || typeof search !== 'object' || Array.isArray(search)) throw new Error('INVALID_PRODUCT_SEARCH');
    const { selectStoredProducts, createFirestoreCatalogCompatibilityReader } = await import('../infra/erp5-compat-catalog-reader.js');
    selectStoredProducts({}, {}, {}, search);
    const { readStoredConsumerProducts } = await import('../application/kakao-catalog-reference.js');
    const reader = createFirestoreCatalogCompatibilityReader();
    const result = await readStoredConsumerProducts({ readStoredProducts: reader.readStoredProducts.bind(reader),
      sourceStore: reader.sourceStore, readCanonicalProducts: (s, rows) => queryFirestoreProducts(s, rows as PeriodFeeLedgerRow[]) }, 'internal-ai-ops', search);
    await writePrivateArtifact(a.get('--local-output')!, result);
    console.log(JSON.stringify({ status: 'LOCAL_RESULT_WRITTEN', products: result.products.length, sourceRows: result.sourceRows.length,
      snapshotConsistency: result.meta.snapshotConsistency }));
    return;
  }
  if (a.has('--search-file')) {
    const search = JSON.parse(await readFile(a.get('--search-file')!, 'utf8')) as ProductSearch;
    if (!search || typeof search !== 'object' || Array.isArray(search)) throw new Error('INVALID_PRODUCT_SEARCH');
    // Validate user input before any Firebase access.
    for (const [key, value] of Object.entries(search))
      if (!['productId', 'supplierId', 'supplierName', 'vehicleName', 'plate'].includes(key) || typeof value !== 'string' || !value.trim())
        throw new Error('INVALID_PRODUCT_SEARCH');
    if (search.plate !== undefined && !plateIdentityKey(search.plate)) throw new Error('PLATE_REQUIRED');
    let result: Awaited<ReturnType<typeof queryCanonicalProducts>>;
    if (a.has('--memory')) {
      const { MemoryDataStore } = await import('../infra/memory-store.js');
      result = await queryCanonicalProducts(new MemoryDataStore(), search);
    } else result = await queryFirestoreProducts(search);
    await writePrivateArtifact(a.get('--local-output')!, result);
    console.log(JSON.stringify({ status: 'LOCAL_RESULT_WRITTEN', matchedProducts: result.matchedProducts }));
    return;
  }
  const plate = (await readFile(a.get('--plate-file')!, 'utf8')).trim();
  let result: Awaited<ReturnType<typeof queryCanonicalByPlate>>;
  if (a.has('--direct')) {
    result = await queryFirestoreByPlate(plate);
  } else if (a.has('--memory')) {
    const { MemoryDataStore } = await import('../infra/memory-store.js'); result = await queryCanonicalByPlate(new MemoryDataStore(), plate);
  } else {
    const { withSharedSheetCatalogAccess } = await import('./data-access-runtime.js');
    result = await withSharedSheetCatalogAccess(false, stableDigest(['local-plate-query']), store => queryCanonicalByPlate(store, plate));
  }
  await writePrivateArtifact(a.get('--local-output')!, result);
  console.log(JSON.stringify({ status: 'LOCAL_RESULT_WRITTEN', matchedAssets: result.matchedAssets }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('CANONICAL_QUERY_HOLD'); process.exitCode = 1; });
}
