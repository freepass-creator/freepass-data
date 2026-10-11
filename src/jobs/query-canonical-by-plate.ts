import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { CatalogStore } from '../ports/catalog-store.js';
import { plateIdentityKey } from '../domain/vehicle-plate.js';
import { parseLocalArgs, writePrivateArtifact } from './ingest-shared-sheet-canonical.js';
import { stableDigest } from '../shared/stable-digest.js';
import { toInternalFeeLookup } from '../domain/internal-fee-lookup-contract.js';

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
  const a = parseLocalArgs(args, ['--memory', '--firestore', '--direct'], ['--plate-file', '--local-output']);
  if (!a.has('--plate-file') || !a.has('--local-output')) throw new Error('LOCAL_INPUT_OUTPUT_REQUIRED');
  if (a.has('--direct') && (!a.has('--firestore') || a.has('--memory'))) throw new Error('DIRECT_FIRESTORE_REQUIRED');
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
