import type { VehicleAsset, VehicleExternalId } from '../domain/catalog.js';
import { stableDigest } from './stable-digest.js';

const active = (id: VehicleExternalId, at: string) => id.validFrom <= at && (id.validTo === undefined || id.validTo === null || id.validTo > at);

function externalIdsForAsset(asset: VehicleAsset): VehicleExternalId[] {
  const out: VehicleExternalId[] = [];
  if (asset.plateNumber) {
    out.push({ kind: 'PLATE', value: asset.plateNumber, validFrom: asset.createdAt, source: 'vehicle-uid-migration-plan' });
  }
  if (asset.vin) {
    out.push({ kind: 'VIN', value: asset.vin.toUpperCase(), validFrom: asset.createdAt, source: 'vehicle-uid-migration-plan' });
  }
  return out;
}

export function normalizedVehicleUidMigrationAssetIdentifiers(asset: VehicleAsset, observedAt: string): VehicleExternalId[] {
  return [...(asset.externalIds ?? []), ...externalIdsForAsset(asset)]
    .map(id => ({
      ...id,
      value: id.kind === 'VIN' ? id.value.trim().toUpperCase() : id.value.trim(),
      ...(id.supplierCode ? { supplierCode: id.supplierCode.trim().toUpperCase() } : {}),
    }))
    .filter(id => id.value && active(id, observedAt));
}

export function summarizeVehicleUidMigrationAssetIdentifiers(asset: VehicleAsset, observedAt: string) {
  return stableDigest(normalizedVehicleUidMigrationAssetIdentifiers(asset, observedAt));
}
