import type { VehicleAsset, VehicleExternalId } from '../domain/catalog.js';

export type VehicleUidMigrationProductDoc = Record<string, unknown>;

export type VehicleUidMigrationUpdateTime = {
  seconds: number;
  nanoseconds: number;
};

export type VehicleUidMigrationDocumentSnapshot<T> = {
  data: T;
  updateTime?: VehicleUidMigrationUpdateTime;
};

export type VehicleUidMigrationStoreMutation =
  | { kind: 'ASSET_EXTERNAL_IDS'; assetId: string; externalIds: VehicleExternalId[] | undefined; updateTime?: VehicleUidMigrationUpdateTime; expectedAfter?: VehicleExternalId[] | undefined; assetIdentifierDigest?: string; observedAt?: string }
  | { kind: 'PRODUCT_VEHICLE_UID'; productKey: string; vehicleUid: string | null; updateTime?: VehicleUidMigrationUpdateTime; expectedAfter?: string; expectedRegistryAfter?: unknown; hadVehicleUidRegistry?: boolean; registryValue?: unknown; vehicleUidRegistry?: 'PRODUCT_ONLY'; assetState?: 'LINKED_EXISTING' | 'PRODUCT_ONLY'; assetIdentifierDigest?: string; observedAt?: string }
  | { kind: 'PRODUCT_VERIFY_IDENTIFIERS'; productKey: string; vehicleUid: string; updateTime?: VehicleUidMigrationUpdateTime; identifierDigest: string; assetIdentifierDigest?: string; observedAt?: string }
  | { kind: 'PRODUCT_DELETE_VEHICLE_UID'; productKey: string; updateTime?: VehicleUidMigrationUpdateTime; expectedAfter?: unknown; registryValue?: unknown; hadVehicleUidRegistry?: boolean; expectedRegistryAfter?: unknown };

export type VehicleUidMigrationCommitResult = {
  applied: number;
  skipped: Array<{ target: string; reason: 'CONCURRENT_CHANGE' | 'ROLLBACK_SKIPPED_CHANGED' | 'NOT_APPLIED' | 'STALE_ASSET' | 'STALE_IDENTIFIER' | 'UID_ASSET_NOT_FOUND' | 'UID_ASSET_ALREADY_EXISTS' }>;
};

export type VehicleUidMigrationWriteStore = {
  getAsset(assetId: string): Promise<VehicleAsset | null>;
  getProduct(productKey: string): Promise<VehicleUidMigrationProductDoc | null>;
  getAssetSnapshot?(assetId: string): Promise<VehicleUidMigrationDocumentSnapshot<VehicleAsset> | null>;
  getProductSnapshot?(productKey: string): Promise<VehicleUidMigrationDocumentSnapshot<VehicleUidMigrationProductDoc> | null>;
  updateAssetExternalIds(assetId: string, externalIds: VehicleExternalId[]): Promise<void>;
  setProductVehicleUid(productKey: string, vehicleUid: string | null): Promise<void>;
  restoreAssetExternalIds(assetId: string, externalIds: VehicleExternalId[] | undefined): Promise<void>;
  deleteProductVehicleUid(productKey: string): Promise<void>;
  commitMutations?(mutations: VehicleUidMigrationStoreMutation[]): Promise<VehicleUidMigrationCommitResult | void>;
};
