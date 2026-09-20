import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type {
  AuditEvent, CommandReceipt, ErpPublicProduct, Offer, OutboxEvent, Policy,
  Product, ProjectionRelease, VehicleAsset, VehicleModel
} from '../domain/catalog.js';
import type {
  CatalogStore, CatalogTransaction, OutboxStore, ProjectionStore
} from '../ports/catalog-store.js';

const C = {
  vehicleModels: 'catalog_vehicle_models',
  vehicleAssets: 'catalog_vehicle_assets',
  products: 'catalog_products',
  offers: 'catalog_offers',
  policies: 'catalog_policies',
  receipts: 'command_receipts',
  audits: 'audit_events',
  outbox: 'outbox_events',
  releases: 'projection_releases',
  activeReleases: 'projection_active'
} as const;

const data = <T>(snap: FirebaseFirestore.DocumentSnapshot) =>
  snap.exists ? ({ id: snap.id, ...snap.data() } as T) : null;

export class FirestoreDataStore implements CatalogStore, ProjectionStore, OutboxStore {
  constructor(private readonly db: Firestore) {}

  async transact<T>(fn: (tx: CatalogTransaction) => Promise<T>): Promise<T> {
    return this.db.runTransaction(async (native: Transaction) => {
      const tx: CatalogTransaction = {
        getOffer: async (id) => data<Offer>(await native.get(this.db.collection(C.offers).doc(id))),
        putOffer: async (offer) => { native.set(this.db.collection(C.offers).doc(offer.id), offer); },
        getCommandReceipt: async (key) =>
          data<CommandReceipt>(await native.get(this.db.collection(C.receipts).doc(key))),
        putCommandReceipt: async (receipt) => {
          native.create(this.db.collection(C.receipts).doc(receipt.idempotencyKey), receipt);
        },
        appendAudit: async (event: AuditEvent) => {
          native.create(this.db.collection(C.audits).doc(event.eventId), event);
        },
        appendOutbox: async (event: OutboxEvent) => {
          native.create(this.db.collection(C.outbox).doc(event.eventId), event);
        }
      };
      return fn(tx);
    });
  }

  async getOffer(id: string) { return data<Offer>(await this.db.collection(C.offers).doc(id).get()); }

  private async all<T>(collection: string): Promise<T[]> {
    const snap = await this.db.collection(collection).get();
    return snap.docs.map((x) => ({ id: x.id, ...x.data() }) as T);
  }
  async listVehicleModels() { return this.all<VehicleModel>(C.vehicleModels); }
  async listVehicleAssets() { return this.all<VehicleAsset>(C.vehicleAssets); }
  async listProducts() { return this.all<Product>(C.products); }
  async listOffers() { return this.all<Offer>(C.offers); }
  async listPolicies() { return this.all<Policy>(C.policies); }

  async stage(release: ProjectionRelease<ErpPublicProduct>) {
    await this.db.collection(C.releases).doc(release.releaseId).set(release);
  }
  async markReady(releaseId: string) {
    await this.db.collection(C.releases).doc(releaseId).update({ status: 'READY' });
  }
  async activate(releaseId: string) {
    await this.db.runTransaction(async (tx) => {
      const ref = this.db.collection(C.releases).doc(releaseId);
      const snap = await tx.get(ref);
      if (!snap.exists || snap.get('status') !== 'READY') throw new Error('Only READY release can activate');
      const projectionId = snap.get('projectionId') as string;
      const activeRef = this.db.collection(C.activeReleases).doc(projectionId);
      const activeSnap = await tx.get(activeRef);
      const previousId = activeSnap.exists ? activeSnap.get('releaseId') as string : null;
      if (previousId && previousId !== releaseId) {
        tx.update(this.db.collection(C.releases).doc(previousId), { status: 'READY' });
      }
      tx.update(ref, { status: 'ACTIVE', activatedAt: new Date().toISOString() });
      tx.set(activeRef, { releaseId, projectionId });
    });
  }
  async getActive(projectionId: string) {
    const active = await this.db.collection(C.activeReleases).doc(projectionId).get();
    if (!active.exists) return null;
    return data<ProjectionRelease<ErpPublicProduct>>(
      await this.db.collection(C.releases).doc(active.get('releaseId') as string).get()
    );
  }

  async claimNext(input: { workerId: string; now: string; leaseUntil: string }) {
    const snap = await this.db.collection(C.outbox)
      .where('status', 'in', ['PENDING', 'PROCESSING'])
      .orderBy('occurredAt', 'asc')
      .limit(20)
      .get();

    for (const candidate of snap.docs) {
      const claimed = await this.db.runTransaction(async (tx) => {
        const fresh = await tx.get(candidate.ref);
        if (!fresh.exists) return null;
        const event = { id: fresh.id, ...fresh.data() } as unknown as OutboxEvent;
        const leaseExpired = event.status === 'PROCESSING' && Boolean(event.leaseUntil) && event.leaseUntil! <= input.now;
        const due = !event.nextAttemptAt || event.nextAttemptAt <= input.now;
        if (!due || (event.status !== 'PENDING' && !leaseExpired)) return null;
        tx.update(candidate.ref, {
          status: 'PROCESSING',
          leaseOwner: input.workerId,
          leaseUntil: input.leaseUntil
        });
        return { ...event, status: 'PROCESSING' as const, leaseOwner: input.workerId, leaseUntil: input.leaseUntil };
      });
      if (claimed) return claimed;
    }
    return null;
  }
  async markDone(eventId: string) {
    await this.db.collection(C.outbox).doc(eventId).update({
      status: 'DONE', leaseOwner: null, leaseUntil: null
    });
  }
  async markRetry(input: { eventId: string; attempts: number; nextAttemptAt: string; error: string }) {
    await this.db.collection(C.outbox).doc(input.eventId).update({
      status: 'PENDING', attempts: input.attempts, nextAttemptAt: input.nextAttemptAt,
      lastError: input.error, leaseOwner: null, leaseUntil: null
    });
  }
  async moveToDeadLetter(input: { eventId: string; attempts: number; error: string }) {
    await this.db.collection(C.outbox).doc(input.eventId).update({
      status: 'DEAD_LETTER', attempts: input.attempts, lastError: input.error,
      leaseOwner: null, leaseUntil: null
    });
  }
}

export async function createFirestoreDataStore() {
  if (!getApps().length) {
    initializeApp({
      credential: applicationDefault(),
      projectId: process.env.FIREBASE_PROJECT_ID
    });
  }
  return new FirestoreDataStore(getFirestore());
}
