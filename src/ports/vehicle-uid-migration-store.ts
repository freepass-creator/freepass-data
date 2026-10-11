import type { VehicleAsset, VehicleExternalId } from '../domain/catalog.js';

export type VehicleUidMigrationProductDoc = Record<string, unknown>;

export type VehicleUidMigrationStoreMutation =
  | { kind: 'ASSET_EXTERNAL_IDS'; assetId: string; externalIds: VehicleExternalId[] | undefined }
  | { kind: 'PRODUCT_VEHICLE_UID'; productKey: string; vehicleUid: string }
  | { kind: 'PRODUCT_DELETE_VEHICLE_UID'; productKey: string };

export type VehicleUidMigrationWriteStore = {
  getAsset(assetId: string): Promise<VehicleAsset | null>;
  getProduct(productKey: string): Promise<VehicleUidMigrationProductDoc | null>;
  updateAssetExternalIds(assetId: string, externalIds: VehicleExternalId[]): Promise<void>;
  setProductVehicleUid(productKey: string, vehicleUid: string): Promise<void>;
  restoreAssetExternalIds(assetId: string, externalIds: VehicleExternalId[] | undefined): Promise<void>;
  deleteProductVehicleUid(productKey: string): Promise<void>;
  commitMutations?(mutations: VehicleUidMigrationStoreMutation[]): Promise<void>;
};
