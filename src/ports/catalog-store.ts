import type {
  AuditEvent, CommandReceipt, ErpPublicProduct, Offer, OutboxEvent, Policy,
  Product, ProjectionRelease, VehicleAsset, VehicleModel
} from '../domain/catalog.js';

export interface CatalogTransaction {
  getOffer(id: string): Promise<Offer | null>;
  putOffer(offer: Offer): Promise<void>;
  getCommandReceipt(idempotencyKey: string): Promise<CommandReceipt | null>;
  putCommandReceipt(receipt: CommandReceipt): Promise<void>;
  appendAudit(event: AuditEvent): Promise<void>;
  appendOutbox(event: OutboxEvent): Promise<void>;
}
export interface CatalogStore {
  transact<T>(fn: (tx: CatalogTransaction) => Promise<T>): Promise<T>;
  getOffer(id: string): Promise<Offer | null>;
  listVehicleModels(): Promise<VehicleModel[]>;
  listVehicleAssets(): Promise<VehicleAsset[]>;
  listProducts(): Promise<Product[]>;
  listOffers(): Promise<Offer[]>;
  listPolicies(): Promise<Policy[]>;
  seed?(input: {
    vehicleModels?: VehicleModel[]; vehicleAssets?: VehicleAsset[];
    products?: Product[]; offers?: Offer[]; policies?: Policy[];
  }): Promise<void>;
}
export interface ProjectionStore {
  stage(release: ProjectionRelease<ErpPublicProduct>): Promise<void>;
  markReady(releaseId: string): Promise<void>;
  activate(releaseId: string): Promise<void>;
  getActive(projectionId: string): Promise<ProjectionRelease<ErpPublicProduct> | null>;
}
export interface OutboxStore {
  claimNext(input: { workerId: string; now: string; leaseUntil: string }): Promise<OutboxEvent | null>;
  markDone(eventId: string): Promise<void>;
  markRetry(input: { eventId: string; attempts: number; nextAttemptAt: string; error: string }): Promise<void>;
  moveToDeadLetter(input: { eventId: string; attempts: number; error: string }): Promise<void>;
}
