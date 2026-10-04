import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { CatalogStore } from '../ports/catalog-store.js';
import { plateIdentityKey } from '../domain/vehicle-plate.js';
import { parseLocalArgs, writePrivateArtifact } from './ingest-shared-sheet-canonical.js';
import { stableDigest } from '../shared/stable-digest.js';

/** Operator-local view only; no transaction, recomputation, audit or serving projection. */
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
        results.push({ supplierId: offer.supplierId, assetRevision: asset.revision, offerRevision: offer.revision,
          vehicle: { maker: model?.maker ?? null, model: model?.model ?? null, subModel: model?.subModel ?? null,
            trim: model?.trim ?? null, odometerKm: asset.odometerKm ?? null, facts: asset.sourceVehicleFacts ?? null,
            sourceFirstObservedAt: asset.sourceFirstObservedAt ?? null, sourceFirstRunId: asset.sourceFirstRunId ?? null },
          terms: offer.priceTerms.map(term => {
            const stored = offer.internalEconomicsTerms?.find(x => x.termKey === term.termKey);
            return { ...term, supplierBillingFee: stored?.supplierBillingFee ?? { state: 'UNKNOWN', amount: null },
              channelPayoutFee: stored?.channelPayoutFee ?? { state: 'UNKNOWN', amount: null } };
          }) });
      }
    }
  }
  return { matchedAssets: assets.length, results };
}
export async function main(args = process.argv.slice(2)) {
  const a = parseLocalArgs(args, ['--memory', '--firestore'], ['--plate-file', '--local-output']);
  if (!a.has('--plate-file') || !a.has('--local-output')) throw new Error('LOCAL_INPUT_OUTPUT_REQUIRED');
  const plate = (await readFile(a.get('--plate-file')!, 'utf8')).trim();
  let result: Awaited<ReturnType<typeof queryCanonicalByPlate>>;
  if (a.has('--memory')) {
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
