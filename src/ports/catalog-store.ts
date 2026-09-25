import type {
  AuditEvent, CommandReceipt, Offer, OutboxEvent, Policy,
  Product, ProjectionProduct, ProjectionRelease, VehicleAsset, VehicleModel
} from '../domain/catalog.js';
import type {
  CanonicalSourceBinding,
  CanonicalizationReceipt
} from '../domain/canonicalization.js';
import type {
  NormalizedCandidateRecord,
  RawRecord,
  SourceDefinition,
  SourceHead,
  SourceRun
} from '../domain/source.js';
import type { FieldLineageRecord, SourceLineageStage } from '../domain/lineage.js';
import type {
  CatalogEntityType,
  EntityRevisionRecord
} from '../domain/history.js';
import type { ManualCatalogEntryReceipt } from '../domain/manual-entry.js';
import type {
  ActiveProjectionEvidenceSnapshot,
  ProjectionDeliveryReceipt,
  ProjectionFieldLineageRecord,
  ProjectionReleaseManifest
} from '../domain/projection-evidence.js';
import type { ReviewedSourceChangeReceipt } from '../domain/source-change.js';
import type {
  CatalogWriterOwnership,
  WriterOwnershipTransferReceipt
} from '../domain/writer-ownership.js';

export interface CatalogTransaction {
  getVehicleModel(id: string): Promise<VehicleModel | null>;
  putVehicleModel(model: VehicleModel): Promise<void>;
  getVehicleAsset(id: string): Promise<VehicleAsset | null>;
  putVehicleAsset(asset: VehicleAsset): Promise<void>;
  updateVehicleAsset(asset: VehicleAsset): Promise<void>;
  getProduct(id: string): Promise<Product | null>;
  putProduct(product: Product): Promise<void>;
  getOffer(id: string): Promise<Offer | null>;
  putOffer(offer: Offer): Promise<void>;

  getSourceDefinition(sourceId: string): Promise<SourceDefinition | null>;
  putSourceDefinition(source: SourceDefinition): Promise<void>;
  getSourceRun(runId: string): Promise<SourceRun | null>;
  putSourceRun(run: SourceRun): Promise<void>;
  getSourceHead(sourceId: string): Promise<SourceHead | null>;
  putSourceHead(head: SourceHead): Promise<void>;
  getRawRecord(rawRecordId: string): Promise<RawRecord | null>;
  putRawRecord(record: RawRecord): Promise<void>;
  getCandidate(candidateId: string): Promise<NormalizedCandidateRecord | null>;
  putCandidate(record: NormalizedCandidateRecord): Promise<void>;
  listLineageForCandidate(candidateId: string): Promise<FieldLineageRecord[]>;
  appendLineage(record: FieldLineageRecord): Promise<void>;

  getSourceBinding(bindingId: string): Promise<CanonicalSourceBinding | null>;
  putSourceBinding(binding: CanonicalSourceBinding): Promise<void>;
  updateSourceBinding(binding: CanonicalSourceBinding): Promise<void>;
  getCanonicalizationReceipt(idempotencyKey: string): Promise<CanonicalizationReceipt | null>;
  putCanonicalizationReceipt(receipt: CanonicalizationReceipt): Promise<void>;
  getCommandReceipt(idempotencyKey: string): Promise<CommandReceipt | null>;
  putCommandReceipt(receipt: CommandReceipt): Promise<void>;
  getManualCatalogEntryReceipt(idempotencyKey: string): Promise<ManualCatalogEntryReceipt | null>;
  putManualCatalogEntryReceipt(receipt: ManualCatalogEntryReceipt): Promise<void>;
  getReviewedSourceChangeReceipt(idempotencyKey: string): Promise<ReviewedSourceChangeReceipt | null>;
  putReviewedSourceChangeReceipt(receipt: ReviewedSourceChangeReceipt): Promise<void>;
  getCatalogWriterOwnership(): Promise<CatalogWriterOwnership | null>;
  putCatalogWriterOwnership(ownership: CatalogWriterOwnership): Promise<void>;
  updateCatalogWriterOwnership(ownership: CatalogWriterOwnership): Promise<void>;
  getWriterOwnershipTransferReceipt(
    idempotencyKey: string
  ): Promise<WriterOwnershipTransferReceipt | null>;
  putWriterOwnershipTransferReceipt(
    receipt: WriterOwnershipTransferReceipt
  ): Promise<void>;
  appendAudit(event: AuditEvent): Promise<void>;
  appendRevision(record: EntityRevisionRecord): Promise<void>;
  appendOutbox(event: OutboxEvent): Promise<void>;
}
export interface CatalogStore {
  transact<T>(fn: (tx: CatalogTransaction) => Promise<T>): Promise<T>;
  getVehicleModel(id: string): Promise<VehicleModel | null>;
  getVehicleAsset(id: string): Promise<VehicleAsset | null>;
  getProduct(id: string): Promise<Product | null>;
  getOffer(id: string): Promise<Offer | null>;
  getSourceDefinition(sourceId: string): Promise<SourceDefinition | null>;
  getSourceRun(runId: string): Promise<SourceRun | null>;
  getSourceHead(sourceId: string): Promise<SourceHead | null>;
  getRawRecord(rawRecordId: string): Promise<RawRecord | null>;
  listRawRecordsByRun(runId: string): Promise<RawRecord[]>;
  getCandidate(candidateId: string): Promise<NormalizedCandidateRecord | null>;
  listCandidatesByRun(runId: string): Promise<NormalizedCandidateRecord[]>;
  getSourceBinding(bindingId: string): Promise<CanonicalSourceBinding | null>;
  getCanonicalizationReceipt(idempotencyKey: string): Promise<CanonicalizationReceipt | null>;
  getManualCatalogEntryReceipt(idempotencyKey: string): Promise<ManualCatalogEntryReceipt | null>;
  getReviewedSourceChangeReceipt(idempotencyKey: string): Promise<ReviewedSourceChangeReceipt | null>;
  getCatalogWriterOwnership(): Promise<CatalogWriterOwnership | null>;
  getWriterOwnershipTransferReceipt(
    idempotencyKey: string
  ): Promise<WriterOwnershipTransferReceipt | null>;
  listLineageByStage(stage: SourceLineageStage): Promise<FieldLineageRecord[]>;
  listEntityHistory(
    entityType: CatalogEntityType,
    entityId: string
  ): Promise<EntityRevisionRecord[]>;
  listRevisionHistory(): Promise<EntityRevisionRecord[]>;
  listVehicleModels(): Promise<VehicleModel[]>;
  listVehicleAssets(): Promise<VehicleAsset[]>;
  listProducts(): Promise<Product[]>;
  listOffers(): Promise<Offer[]>;
  listPolicies(): Promise<Policy[]>;
  seed?(input: {
    vehicleModels?: VehicleModel[]; vehicleAssets?: VehicleAsset[];
    products?: Product[]; offers?: Offer[]; policies?: Policy[];
    sourceRuns?: SourceRun[]; sourceHeads?: SourceHead[];
    candidates?: NormalizedCandidateRecord[]; lineage?: FieldLineageRecord[];
    sourceBindings?: CanonicalSourceBinding[];
    canonicalizationReceipts?: CanonicalizationReceipt[];
    revisionHistory?: EntityRevisionRecord[];
    sourceDefinitions?: SourceDefinition[];
    rawRecords?: RawRecord[];
    manualCatalogEntryReceipts?: ManualCatalogEntryReceipt[];
    reviewedSourceChangeReceipts?: ReviewedSourceChangeReceipt[];
    catalogWriterOwnership?: CatalogWriterOwnership | null;
    writerOwnershipTransferReceipts?: WriterOwnershipTransferReceipt[];
  }): Promise<void>;
}
export interface ProjectionStore {
  stage(release: ProjectionRelease<ProjectionProduct>): Promise<void>;
  stageEvidence(input: {
    manifest: ProjectionReleaseManifest;
    lineage: ProjectionFieldLineageRecord[];
  }): Promise<void>;
  markReady(releaseId: string): Promise<void>;
  activate(releaseId: string): Promise<void>;
  getActive(projectionId: string): Promise<ProjectionRelease<ProjectionProduct> | null>;
  getManifest(releaseId: string): Promise<ProjectionReleaseManifest | null>;
  listProjectionLineage(releaseId: string): Promise<ProjectionFieldLineageRecord[]>;
  getDeliveryReceipt(eventId: string): Promise<ProjectionDeliveryReceipt | null>;
  putDeliveryReceipt(receipt: ProjectionDeliveryReceipt): Promise<void>;
}
export interface ProjectionEvidenceSnapshotStore {
  getActiveEvidenceSnapshot(
    projectionId: string
  ): Promise<ActiveProjectionEvidenceSnapshot<ProjectionProduct>>;
}

export interface OutboxStore {
  claimNext(input: { workerId: string; now: string; leaseUntil: string }): Promise<OutboxEvent | null>;
  markDone(eventId: string): Promise<void>;
  markRetry(input: { eventId: string; attempts: number; nextAttemptAt: string; error: string }): Promise<void>;
  moveToDeadLetter(input: { eventId: string; attempts: number; error: string }): Promise<void>;
}
