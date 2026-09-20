import type {
  AuditEvent, CommandReceipt, ErpPublicProduct, Offer, OutboxEvent, Policy,
  Product, ProjectionRelease, VehicleAsset, VehicleModel
} from '../domain/catalog.js';
import type {
  CanonicalSourceBinding,
  CanonicalizationReceipt
} from '../domain/canonicalization.js';
import type {
  NormalizedCandidateRecord,
  SourceHead,
  SourceRun
} from '../domain/source.js';
import type { FieldLineageRecord, LineageStage } from '../domain/lineage.js';

export interface CatalogTransaction {
  getVehicleModel(id: string): Promise<VehicleModel | null>;
  putVehicleModel(model: VehicleModel): Promise<void>;
  getVehicleAsset(id: string): Promise<VehicleAsset | null>;
  putVehicleAsset(asset: VehicleAsset): Promise<void>;
  getProduct(id: string): Promise<Product | null>;
  putProduct(product: Product): Promise<void>;
  getOffer(id: string): Promise<Offer | null>;
  putOffer(offer: Offer): Promise<void>;

  getSourceRun(runId: string): Promise<SourceRun | null>;
  getSourceHead(sourceId: string): Promise<SourceHead | null>;
  getCandidate(candidateId: string): Promise<NormalizedCandidateRecord | null>;
  listLineageForCandidate(candidateId: string): Promise<FieldLineageRecord[]>;
  appendLineage(record: FieldLineageRecord): Promise<void>;

  getSourceBinding(bindingId: string): Promise<CanonicalSourceBinding | null>;
  putSourceBinding(binding: CanonicalSourceBinding): Promise<void>;
  getCanonicalizationReceipt(idempotencyKey: string): Promise<CanonicalizationReceipt | null>;
  putCanonicalizationReceipt(receipt: CanonicalizationReceipt): Promise<void>;
  getCommandReceipt(idempotencyKey: string): Promise<CommandReceipt | null>;
  putCommandReceipt(receipt: CommandReceipt): Promise<void>;
  appendAudit(event: AuditEvent): Promise<void>;
  appendOutbox(event: OutboxEvent): Promise<void>;
}
export interface CatalogStore {
  transact<T>(fn: (tx: CatalogTransaction) => Promise<T>): Promise<T>;
  getVehicleModel(id: string): Promise<VehicleModel | null>;
  getVehicleAsset(id: string): Promise<VehicleAsset | null>;
  getProduct(id: string): Promise<Product | null>;
  getOffer(id: string): Promise<Offer | null>;
  getSourceBinding(bindingId: string): Promise<CanonicalSourceBinding | null>;
  getCanonicalizationReceipt(idempotencyKey: string): Promise<CanonicalizationReceipt | null>;
  listLineageByStage(stage: LineageStage): Promise<FieldLineageRecord[]>;
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
  }): Promise<void>;
}
export interface ProjectionStore {
  stage<T>(release: ProjectionRelease<T>): Promise<void>;
  markReady(releaseId: string): Promise<void>;
  activate(releaseId: string): Promise<void>;
  getActive<T = ErpPublicProduct>(projectionId: string): Promise<ProjectionRelease<T> | null>;
}
export interface OutboxStore {
  claimNext(input: { workerId: string; now: string; leaseUntil: string }): Promise<OutboxEvent | null>;
  markDone(eventId: string): Promise<void>;
  markRetry(input: { eventId: string; attempts: number; nextAttemptAt: string; error: string }): Promise<void>;
  moveToDeadLetter(input: { eventId: string; attempts: number; error: string }): Promise<void>;
}
