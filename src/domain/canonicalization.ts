import type { ActorRef, VehicleAssetStatus } from './catalog.js';

export type IdentityResolution =
  | { action: 'CREATE'; id: string }
  | { action: 'LINK'; id: string };

export type CanonicalizationDecision = {
  vehicleModel: IdentityResolution;
  vehicleAsset?: (IdentityResolution & { status?: VehicleAssetStatus }) | null;
  supplierId: string;
  approvedIssues?: string[];
  /** Sale exposure of the created Product. Absent = ACTIVE (previous behavior). HOLD keeps the car stored but unpublished. */
  productStatus?: 'ACTIVE' | 'HOLD';
};

export type CanonicalSourceBinding = {
  bindingId: string;
  sourceId: string;
  sourceRecordId: string;
  sourceFingerprint: string;
  sourceRunId: string;
  sourceObservedAt: string;
  sourceCheckpointRevision?: string | null;
  sourceCheckpointChecksum?: string | null;
  sourceSupplierCode?: string | null;

  vehicleModelId: string;
  vehicleAssetId?: string | null;
  productId: string;
  offerId: string;

  revision: number;
  createdAt: string;
  updatedAt: string;
  createdBy: ActorRef;
  updatedBy: ActorRef;
};

export type CanonicalizationReceipt = {
  idempotencyKey: string;
  commandId: string;
  status: 'CANONICAL_COMMITTED' | 'NO_CHANGE';
  bindingId: string;
  sourceId: string;
  sourceRecordId: string;
  sourceFingerprint: string;
  sourceRunId: string;
  productId: string;
  offerId: string;
  committedAt: string;
  requestDigest: string;
  writerId?: string;
};
