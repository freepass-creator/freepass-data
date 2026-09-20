import type {
  AuditEvent, CommandReceipt, ErpPublicProduct, Offer, OutboxEvent, Policy,
  Product, ProjectionRelease, VehicleAsset, VehicleModel
} from '../domain/catalog.js';
import type {
  CatalogStore, CatalogTransaction, OutboxStore, ProjectionStore
} from '../ports/catalog-store.js';

const copy = <T>(value: T): T => structuredClone(value);

export class MemoryDataStore implements CatalogStore, ProjectionStore, OutboxStore {
  private models = new Map<string, VehicleModel>();
  private assets = new Map<string, VehicleAsset>();
  private products = new Map<string, Product>();
  private offers = new Map<string, Offer>();
  private policies = new Map<string, Policy>();
  private receipts = new Map<string, CommandReceipt>();
  readonly audits: AuditEvent[] = [];
  readonly outbox = new Map<string, OutboxEvent>();
  private releases = new Map<string, ProjectionRelease<ErpPublicProduct>>();
  private active = new Map<string, string>();

  async seed(input: {
    vehicleModels?: VehicleModel[]; vehicleAssets?: VehicleAsset[];
    products?: Product[]; offers?: Offer[]; policies?: Policy[];
  }) {
    for (const x of input.vehicleModels ?? []) this.models.set(x.id, copy(x));
    for (const x of input.vehicleAssets ?? []) this.assets.set(x.id, copy(x));
    for (const x of input.products ?? []) this.products.set(x.id, copy(x));
    for (const x of input.offers ?? []) this.offers.set(x.id, copy(x));
    for (const x of input.policies ?? []) this.policies.set(x.id, copy(x));
  }

  async transact<T>(fn: (tx: CatalogTransaction) => Promise<T>): Promise<T> {
    const snapshot = {
      offers: copy([...this.offers.entries()]),
      receipts: copy([...this.receipts.entries()]),
      audits: copy(this.audits),
      outbox: copy([...this.outbox.entries()])
    };
    const tx: CatalogTransaction = {
      getOffer: async (id) => copy(this.offers.get(id) ?? null),
      putOffer: async (offer) => { this.offers.set(offer.id, copy(offer)); },
      getCommandReceipt: async (key) => copy(this.receipts.get(key) ?? null),
      putCommandReceipt: async (receipt) => { this.receipts.set(receipt.idempotencyKey, copy(receipt)); },
      appendAudit: async (event) => { this.audits.push(copy(event)); },
      appendOutbox: async (event) => { this.outbox.set(event.eventId, copy(event)); }
    };
    try { return await fn(tx); }
    catch (error) {
      this.offers = new Map(snapshot.offers);
      this.receipts = new Map(snapshot.receipts);
      this.audits.splice(0, this.audits.length, ...snapshot.audits);
      this.outbox.clear();
      for (const [key, value] of snapshot.outbox) this.outbox.set(key, value);
      throw error;
    }
  }

  async getOffer(id: string) { return copy(this.offers.get(id) ?? null); }
  async listVehicleModels() { return copy([...this.models.values()]); }
  async listVehicleAssets() { return copy([...this.assets.values()]); }
  async listProducts() { return copy([...this.products.values()]); }
  async listOffers() { return copy([...this.offers.values()]); }
  async listPolicies() { return copy([...this.policies.values()]); }

  async stage(release: ProjectionRelease<ErpPublicProduct>) {
    this.releases.set(release.releaseId, copy(release));
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
  async getActive(projectionId: string) {
    const id = this.active.get(projectionId);
    return id ? copy(this.releases.get(id) ?? null) : null;
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
