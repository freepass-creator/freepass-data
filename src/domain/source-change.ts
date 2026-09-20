import type { ActorRef } from './catalog.js';

export type SourceChangeClassification = 'REVIEWABLE' | 'BLOCKED';

export type SourceChangeEntityType =
  | 'vehicle_model'
  | 'vehicle_asset'
  | 'product'
  | 'offer';

export type SourceChangeDiff = {
  changeId: string;
  classification: SourceChangeClassification;
  entityType: SourceChangeEntityType;
  entityId: string;
  fieldPath: string;
  before: unknown;
  after: unknown;
  reasonCode: string;
  authorityRuleId?: string | null;
};

export type SourceChangeReview = {
  bindingId: string;
  bindingRevision: number;
  candidateId: string;
  sourceId: string;
  sourceRecordId: string;
  previousFingerprint: string;
  candidateFingerprint: string;
  sourceRunId: string;
  diffs: SourceChangeDiff[];
  reviewableChangeIds: string[];
  blockedChangeIds: string[];
};

export type ApplyReviewedSourceChangeInput = {
  commandId: string;
  idempotencyKey: string;
  bindingId: string;
  candidateId: string;
  expectedHeadRunId: string;
  expectedBindingRevision: number;
  expectedVehicleModelRevision: number;
  expectedProductRevision: number;
  expectedOfferRevision: number;
  expectedVehicleAssetRevision?: number | null;
  approvedChangeIds: string[];
  approvedIssues?: string[];
  actor: ActorRef;
  reason: string;
};

export type ReviewedSourceChangeReceipt = {
  idempotencyKey: string;
  commandId: string;
  status: 'CANONICAL_COMMITTED' | 'NO_CHANGE';
  requestDigest: string;
  bindingId: string;
  bindingRevision: number;
  sourceRunId: string;
  sourceFingerprint: string;
  appliedChangeIds: string[];
  offerId: string;
  offerRevision: number;
  vehicleAssetId?: string | null;
  vehicleAssetRevision?: number | null;
  committedAt: string;
};
