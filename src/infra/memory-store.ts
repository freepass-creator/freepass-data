import type {
  AuditEvent, CommandReceipt, ErpPublicProduct, Offer, OutboxEvent, Policy,
  Product, ProjectionRelease, VehicleAsset, VehicleModel
} from '../domain/catalog.js';
import type {
  CatalogStore, CatalogTransaction, OutboxStore, ProjectionStore
} from '../ports/catalog-store.js';
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

const copy = <T>(value: T): T => structuredClone(value);

export class MemoryDataStore implements CatalogStore, ProjectionStore, OutboxStore {
  private models = new Map<string, VehicleModel>();
  private assets = new Map<string, VehicleAsset>();
  private products = new Map<string, Product>();
  private offers = new Map<string, Offer>();
  private policies = new Map<string, Policy>();
  private receipts = new Map<string, CommandReceipt>();
  private canonicalizationReceipts = new Map<string, CanonicalizationReceipt>();
  private sourceRuns = new Map<string, SourceRun>();
  private sourceHeads = new Map<string, SourceHead>();
  private candidates = new Map<string, NormalizedCandidateRecord>();
  private lineage = new Map<string, FieldLineageRecord>();
  private sourceBindings = new Map<string, CanonicalSourceBinding>();
  readonly audits: AuditEvent[] = [];
  readonly outbox = new Map<string, OutboxEvent>();
  private releases = new Map<string, ProjectionRelease<unknown>>();
  private active = new Map<string, string>();

  async seed(input: {
    vehicleModels?: VehicleModel[]; vehicleAssets?: VehicleAsset[];
    products?: Product[]; offers?: Offer[]; policies?: Policy[];
    sourceRuns?: SourceRun[]; sourceHeads?: SourceHead[];
    candidates?: NormalizedCandidateRecord[]; lineage?: FieldLineageRecord[];
    sourceBindings?: CanonicalSourceBinding[];
    canonicalizationReceipts?: CanonicalizationReceipt[];
  }) {
    for (const x of input.vehicleModels ?? []) this.models.set(x.id, copy(x));
    for (const x of input.vehicleAssets ?? []) this.assets.set(x.id, copy(x));
    for (const x of input.products ?? []) this.products.set(x.id, copy(x));
    for (const x of input.offers ?? []) this.offers.set(x.id, copy(x));
    for (const x of input.policies ?? []) this.policies.set(x.id, copy(x));
    for (const x of input.sourceRuns ?? []) this.sourceRuns.set(x.runId, copy(x));
    for (const x of input.sourceHeads ?? []) this.sourceHeads.set(x.sourceId, copy(x));
    for (const x of input.candidates ?? []) this.candidates.set(x.candidateId, copy(x));
    for (const x of input.lineage ?? []) this.lineage.set(x.lineageRecordId, copy(x));
    for (const x of input.sourceBindings ?? []) this.sourceBindings.set(x.bindingId, copy(x));
    for (const x of input.canonicalizationReceipts ?? []) {
      this.canonicalizationReceipts.set(x.idempotencyKey, copy(x));
    }
  }

  async transact<T>(fn: (tx: CatalogTransaction) => Promise<T>): Promise<T> {
    const snapshot = {
      models: copy([...this.models.entries()]),
      assets: copy([...this.assets.entries()]),
      products: copy([...this.products.entries()]),
      offers: copy([...this.offers.entries()]),
      receipts: copy([...this.receipts.entries()]),
      canonicalizationReceipts: copy([...this.canonicalizationReceipts.entries()]),
      lineage: copy([...this.lineage.entries()]),
      sourceBindings: copy([...this.sourceBindings.entries()]),
      audits: copy(this.audits),
      outbox: copy([...this.outbox.entries()])
    };
    const tx: CatalogTransaction = {
      getVehicleModel: async (id) => copy(this.models.get(id) ?? null),
      putVehicleModel: async (model) => { this.models.set(model.id, copy(model)); },
      getVehicleAsset: async (id) => copy(this.assets.get(id) ?? null),
      putVehicleAsset: async (asset) => { this.assets.set(asset.id, copy(asset)); },
      getProduct: async (id) => copy(this.products.get(id) ?? null),
      putProduct: async (product) => { this.products.set(product.id, copy(product)); },
      getOffer: async (id) => copy(this.offers.get(id) ?? null),
      putOffer: async (offer) => { this.offers.set(offer.id, copy(offer)); },

      getSourceRun: async (runId) => copy(this.sourceRuns.get(runId) ?? null),
      getSourceHead: async (sourceId) => copy(this.sourceHeads.get(sourceId) ?? null),
      getCandidate: async (candidateId) => copy(this.candidates.get(candidateId) ?? null),
      listLineageForCandidate: async (candidateId) => copy(
        [...this.lineage.values()].filter((item) => item.normalized?.candidateId === candidateId)
      ),
      appendLineage: async (record) => {
        if (this.lineage.has(record.lineageRecordId)) {
          throw new Error(`Lineage record already exists: ${record.lineageRecordId}`);
        }
        this.lineage.set(record.lineageRecordId, copy(record));
      },

      getSourceBinding: async (bindingId) => copy(this.sourceBindings.get(bindingId) ?? null),
      putSourceBinding: async (binding) => {
        if (this.sourceBindings.has(binding.bindingId)) {
          throw new Error(`Source binding already exists: ${binding.bindingId}`);
        }
        this.sourceBindings.set(binding.bindingId, copy(binding));
      },
      getCanonicalizationReceipt: async (key) =>
        copy(this.canonicalizationReceipts.get(key) ?? null),
      putCanonicalizationReceipt: async (receipt) => {
        if (this.canonicalizationReceipts.has(receipt.idempotencyKey)) {
          throw new Error(`Canonicalization receipt already exists: ${receipt.idempotencyKey}`);
        }
        this.canonicalizationReceipts.set(receipt.idempotencyKey, copy(receipt));
      },

      getCommandReceipt: async (key) => copy(this.receipts.get(key) ?? null),
      putCommandReceipt: async (receipt) => { this.receipts.set(receipt.idempotencyKey, copy(receipt)); },
      appendAudit: async (event) => { this.audits.push(copy(event)); },
      appendOutbox: async (event) => { this.outbox.set(event.eventId, copy(event)); }
    };
    try { return await fn(tx); }
    catch (error) {
      this.models = new Map(snapshot.models);
      this.assets = new Map(snapshot.assets);
      this.products = new Map(snapshot.products);
      this.offers = new Map(snapshot.offers);
      this.receipts = new Map(snapshot.receipts);
      this.canonicalizationReceipts = new Map(snapshot.canonicalizationReceipts);
      this.lineage = new Map(snapshot.lineage);
      this.sourceBindings = new Map(snapshot.sourceBindings);
      this.audits.splice(0, this.audits.length, ...snapshot.audits);
      this.outbox.clear();
      for (const [key, value] of snapshot.outbox) this.outbox.set(key, value);
      throw error;
    }
  }

  async getVehicleModel(id: string) { return copy(this.models.get(id) ?? null); }
  async getVehicleAsset(id: string) { return copy(this.assets.get(id) ?? null); }
  async getProduct(id: string) { return copy(this.products.get(id) ?? null); }
  async getOffer(id: string) { return copy(this.offers.get(id) ?? null); }
  async getSourceBinding(bindingId: string) {
    return copy(this.sourceBindings.get(bindingId) ?? null);
  }
  async getCanonicalizationReceipt(idempotencyKey: string) {
    return copy(this.canonicalizationReceipts.get(idempotencyKey) ?? null);
  }
  async listLineageByStage(stage: LineageStage) {
    return copy([...this.lineage.values()].filter((item) => item.stage === stage));
  }
  async listVehicleModels() { return copy([...this.models.values()]); }
  async listVehicleAssets() { return copy([...this.assets.values()]); }
  async listProducts() { return copy([...this.products.values()]); }
  async listOffers() { return copy([...this.offers.values()]); }
  async listPolicies() { return copy([...this.policies.values()]); }

  async stage<T>(release: ProjectionRelease<T>) {
    this.releases.set(release.releaseId, copy(release) as ProjectionRelease<unknown>);
  }
  async markReady(releaseId: string) {
    const release = this.releases.get(releaseId);
    if (!release) throw new Error('Release not found');
    release.status = 'READY';
  }
  async activate(releaseId: string) {
    const release = this.releases.get(releaseId);
    if (!release || release.status !== 'READY') throw new Error('Only READY release can activate');
    const previousId = this.active.get(release.projectionId);
    const previous = previousId ? this.releases.get(previousId) : undefined;
    if (previous) previous.status = 'READY';
    release.status = 'ACTIVE';
    release.activatedAt = new Date().toISOString();
    this.active.set(release.projectionId, releaseId);
  }
  async getActive<T = ErpPublicProduct>(projectionId: string): Promise<ProjectionRelease<T> | null> {
    const id = this.active.get(projectionId);
    return id ? copy(this.releases.get(id) ?? null) as ProjectionRelease<T> | null : null;
  }

  async claimNext(input: { workerId: string; now: string; leaseUntil: string }) {
    const item = [...this.outbox.values()]
      .filter((x) =>
        (x.status === 'PENDING' || (x.status === 'PROCESSING' && Boolean(x.leaseUntil) && x.leaseUntil! <= input.now)) &&
        (!x.nextAttemptAt || x.nextAttemptAt <= input.now)
      )
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))[0];
    if (!item) return null;
    item.status = 'PROCESSING';
    item.leaseOwner = input.workerId;
    item.leaseUntil = input.leaseUntil;
    return copy(item);
  }
  async markDone(eventId: string) {
    const item = this.outbox.get(eventId);
    if (!item) throw new Error('Outbox event not found');
    item.status = 'DONE'; item.leaseOwner = null; item.leaseUntil = null;
  }
  async markRetry(input: { eventId: string; attempts: number; nextAttemptAt: string; error: string }) {
    const item = this.outbox.get(input.eventId);
    if (!item) throw new Error('Outbox event not found');
    item.status = 'PENDING'; item.attempts = input.attempts;
    item.nextAttemptAt = input.nextAttemptAt; item.lastError = input.error;
    item.leaseOwner = null; item.leaseUntil = null;
  }
  async moveToDeadLetter(input: { eventId: string; attempts: number; error: string }) {
    const item = this.outbox.get(input.eventId);
    if (!item) throw new Error('Outbox event not found');
    item.status = 'DEAD_LETTER'; item.attempts = input.attempts; item.lastError = input.error;
    item.leaseOwner = null; item.leaseUntil = null;
  }
}
