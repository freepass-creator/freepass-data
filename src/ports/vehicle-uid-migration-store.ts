import type { VehicleAsset, VehicleExternalId } from '../domain/catalog.js';

export type VehicleUidMigrationProductDoc = Record<string, unknown>;

export type VehicleUidMigrationDocumentSnapshot<T> = {
  data: T;
  updateTime?: string;
};

export type VehicleUidMigrationStoreMutation =
  | { kind: 'ASSET_EXTERNAL_IDS'; assetId: string; externalIds: VehicleExternalId[] | undefined; updateTime?: string; expectedAfter?: VehicleExternalId[] | undefined }
  | { kind: 'PRODUCT_VEHICLE_UID'; productKey: string; vehicleUid: string; updateTime?: string; expectedAfter?: string }
  | { kind: 'PRODUCT_DELETE_VEHICLE_UID'; productKey: string; updateTime?: string; expectedAfter?: unknown };

export type VehicleUidMigrationCommitResult = {
  applied: number;
  skipped: Array<{ target: string; reason: 'CONCURRENT_CHANGE' | 'ROLLBACK_SKIPPED_CHANGED' }>;
};

export type VehicleUidMigrationWriteStore = {
  getAsset(assetId: string): Promise<VehicleAsset | null>;
  getProduct(productKey: string): Promise<VehicleUidMigrationProductDoc | null>;
  getAssetSnapshot?(assetId: string): Promise<VehicleUidMigrationDocumentSnapshot<VehicleAsset> | null>;
  getProductSnapshot?(productKey: string): Promise<VehicleUidMigrationDocumentSnapshot<VehicleUidMigrationProductDoc> | null>;
  updateAssetExternalIds(assetId: string, externalIds: VehicleExternalId[]): Promise<void>;
  setProductVehicleUid(productKey: string, vehicleUid: string): Promise<void>;
  restoreAssetExternalIds(assetId: string, externalIds: VehicleExternalId[] | undefined): Promise<void>;
  deleteProductVehicleUid(productKey: string): Promise<void>;
  commitMutations?(mutations: VehicleUidMigrationStoreMutation[]): Promise<VehicleUidMigrationCommitResult | void>;
};
