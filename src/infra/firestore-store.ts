import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore, type Transaction } from 'firebase-admin/firestore';
import type {
  AuditEvent, CommandReceipt, Offer, OutboxEvent, Policy,
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

const C = {
  vehicleModels: 'catalog_vehicle_models',
  vehicleAssets: 'catalog_vehicle_assets',
  products: 'catalog_products',
  offers: 'catalog_offers',
  policies: 'catalog_policies',
  receipts: 'command_receipts',
  canonicalizationReceipts: 'canonicalization_receipts',
  sourceRuns: 'source_runs',
  sourceHeads: 'source_heads',
  candidates: 'normalized_candidates',
  lineage: 'field_lineage',
  sourceBindings: 'canonical_source_bindings',
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
        getVehicleModel: async (id) =>
          data<VehicleModel>(await native.get(this.db.collection(C.vehicleModels).doc(id))),
        putVehicleModel: async (model) => {
          native.create(this.db.collection(C.vehicleModels).doc(model.id), model);
        },
        getVehicleAsset: async (id) =>
          data<VehicleAsset>(await native.get(this.db.collection(C.vehicleAssets).doc(id))),
        putVehicleAsset: async (asset) => {
          native.create(this.db.collection(C.vehicleAssets).doc(asset.id), asset);
        },
        getProduct: async (id) =>
          data<Product>(await native.get(this.db.collection(C.products).doc(id))),
        putProduct: async (product) => {
          native.create(this.db.collection(C.products).doc(product.id), product);
        },
        getOffer: async (id) => data<Offer>(await native.get(this.db.collection(C.offers).doc(id))),
        putOffer: async (offer) => { native.set(this.db.collection(C.offers).doc(offer.id), offer); },

        getSourceRun: async (runId) =>
          data<SourceRun>(await native.get(this.db.collection(C.sourceRuns).doc(runId))),
        getSourceHead: async (sourceId) =>
          data<SourceHead>(
            await native.get(this.db.collection(C.sourceHeads).doc(sourceId.replaceAll('/', '__')))
          ),
        getCandidate: async (candidateId) =>
          data<NormalizedCandidateRecord>(
            await native.get(this.db.collection(C.candidates).doc(candidateId.replaceAll('/', '__')))
          ),
        listLineageForCandidate: async (candidateId) => {
          const snap = await native.get(
            this.db.collection(C.lineage).where('normalized.candidateId', '==', candidateId)
          );
          return snap.docs.map((doc) => doc.data() as FieldLineageRecord);
        },
        appendLineage: async (record) => {
          native.create(this.db.collection(C.lineage).doc(record.lineageRecordId), record);
        },

        getSourceBinding: async (bindingId) =>
          data<CanonicalSourceBinding>(
            await native.get(this.db.collection(C.sourceBindings).doc(bindingId))
          ),
        putSourceBinding: async (binding) => {
          native.create(this.db.collection(C.sourceBindings).doc(binding.bindingId), binding);
        },
        getCanonicalizationReceipt: async (key) =>
          data<CanonicalizationReceipt>(
            await native.get(this.db.collection(C.canonicalizationReceipts).doc(key))
          ),
        putCanonicalizationReceipt: async (receipt) => {
          native.create(
            this.db.collection(C.canonicalizationReceipts).doc(receipt.idempotencyKey),
            receipt
          );
        },
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

  async getVehicleModel(id: string) {
    return data<VehicleModel>(await this.db.collection(C.vehicleModels).doc(id).get());
  }
  async getVehicleAsset(id: string) {
    return data<VehicleAsset>(await this.db.collection(C.vehicleAssets).doc(id).get());
  }
  async getProduct(id: string) {
    return data<Product>(await this.db.collection(C.products).doc(id).get());
  }
  async getOffer(id: string) { return data<Offer>(await this.db.collection(C.offers).doc(id).get()); }
  async getSourceBinding(bindingId: string) {
    return data<CanonicalSourceBinding>(
      await this.db.collection(C.sourceBindings).doc(bindingId).get()
    );
  }
  async getCanonicalizationReceipt(idempotencyKey: string) {
    return data<CanonicalizationReceipt>(
      await this.db.collection(C.canonicalizationReceipts).doc(idempotencyKey).get()
    );
  }
  async listLineageByStage(stage: LineageStage) {
    const snap = await this.db.collection(C.lineage).where('stage', '==', stage).get();
    return snap.docs.map((doc) => doc.data() as FieldLineageRecord);
  }

  private async all<T>(collection: string): Promise<T[]> {
    const snap = await this.db.collection(collection).get();
    return snap.docs.map((x) => ({ id: x.id, ...x.data() }) as T);
  }
  async listVehicleModels() { return this.all<VehicleModel>(C.vehicleModels); }
  async listVehicleAssets() { return this.all<VehicleAsset>(C.vehicleAssets); }
  async listProducts() { return this.all<Product>(C.products); }
  async listOffers() { return this.all<Offer>(C.offers); }
  async listPolicies() { return this.all<Policy>(C.policies); }

  async stage<T>(release: ProjectionRelease<T>) {
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
  async getActive<T>(projectionId: string): Promise<ProjectionRelease<T> | null> {
    const active = await this.db.collection(C.activeReleases).doc(projectionId).get();
    if (!active.exists) return null;
    return data<ProjectionRelease<T>>(
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
