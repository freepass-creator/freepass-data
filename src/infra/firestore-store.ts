import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore, type Transaction } from 'firebase-admin/firestore';
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
  ProjectionFieldLineageRecord,
  ProjectionReleaseManifest
} from '../domain/projection-evidence.js';

const C = {
  vehicleModels: 'catalog_vehicle_models',
  vehicleAssets: 'catalog_vehicle_assets',
  products: 'catalog_products',
  offers: 'catalog_offers',
  policies: 'catalog_policies',
  receipts: 'command_receipts',
  canonicalizationReceipts: 'canonicalization_receipts',
  manualCatalogEntryReceipts: 'manual_catalog_entry_receipts',
  sources: 'sources',
  sourceRuns: 'source_runs',
  sourceHeads: 'source_heads',
  raw: 'raw_records',
  candidates: 'normalized_candidates',
  lineage: 'field_lineage',
  sourceBindings: 'canonical_source_bindings',
  revisions: 'catalog_entity_revisions',
  audits: 'audit_events',
  outbox: 'outbox_events',
  releases: 'projection_releases',
  releaseManifests: 'projection_release_manifests',
  projectionLineage: 'projection_field_lineage',
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

        getSourceDefinition: async (sourceId) =>
          data<SourceDefinition>(
            await native.get(this.db.collection(C.sources).doc(sourceId.replaceAll('/', '__')))
          ),
        putSourceDefinition: async (source) => {
          native.create(
            this.db.collection(C.sources).doc(source.sourceId.replaceAll('/', '__')),
            source
          );
        },
        getSourceRun: async (runId) =>
          data<SourceRun>(await native.get(this.db.collection(C.sourceRuns).doc(runId))),
        putSourceRun: async (run) => {
          native.create(this.db.collection(C.sourceRuns).doc(run.runId), run);
        },
        getSourceHead: async (sourceId) =>
          data<SourceHead>(
            await native.get(this.db.collection(C.sourceHeads).doc(sourceId.replaceAll('/', '__')))
          ),
        putSourceHead: async (head) => {
          native.create(
            this.db.collection(C.sourceHeads).doc(head.sourceId.replaceAll('/', '__')),
            head
          );
        },
        getRawRecord: async (rawRecordId) =>
          data<RawRecord>(
            await native.get(this.db.collection(C.raw).doc(rawRecordId.replaceAll('/', '__')))
          ),
        putRawRecord: async (record) => {
          native.create(
            this.db.collection(C.raw).doc(record.rawRecordId.replaceAll('/', '__')),
            record
          );
        },
        getCandidate: async (candidateId) =>
          data<NormalizedCandidateRecord>(
            await native.get(this.db.collection(C.candidates).doc(candidateId.replaceAll('/', '__')))
          ),
        putCandidate: async (record) => {
          native.create(
            this.db.collection(C.candidates).doc(record.candidateId.replaceAll('/', '__')),
            record
          );
        },
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
        getManualCatalogEntryReceipt: async (key) =>
          data<ManualCatalogEntryReceipt>(
            await native.get(
              this.db.collection(C.manualCatalogEntryReceipts).doc(encodeURIComponent(key))
            )
          ),
        putManualCatalogEntryReceipt: async (receipt) => {
          native.create(
            this.db.collection(C.manualCatalogEntryReceipts).doc(
              encodeURIComponent(receipt.idempotencyKey)
            ),
            receipt
          );
        },
        appendAudit: async (event: AuditEvent) => {
          native.create(this.db.collection(C.audits).doc(event.eventId), event);
        },
        appendRevision: async (record: EntityRevisionRecord) => {
          native.create(this.db.collection(C.revisions).doc(record.revisionRecordId), record);
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
  async getSourceDefinition(sourceId: string) {
    return data<SourceDefinition>(
      await this.db.collection(C.sources).doc(sourceId.replaceAll('/', '__')).get()
    );
  }
  async getSourceRun(runId: string) {
    return data<SourceRun>(await this.db.collection(C.sourceRuns).doc(runId).get());
  }
  async getSourceHead(sourceId: string) {
    return data<SourceHead>(
      await this.db.collection(C.sourceHeads).doc(sourceId.replaceAll('/', '__')).get()
    );
  }
  async getRawRecord(rawRecordId: string) {
    return data<RawRecord>(
      await this.db.collection(C.raw).doc(rawRecordId.replaceAll('/', '__')).get()
    );
  }
  async getCandidate(candidateId: string) {
    return data<NormalizedCandidateRecord>(
      await this.db.collection(C.candidates).doc(candidateId.replaceAll('/', '__')).get()
    );
  }
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
  async getManualCatalogEntryReceipt(idempotencyKey: string) {
    return data<ManualCatalogEntryReceipt>(
      await this.db.collection(C.manualCatalogEntryReceipts)
        .doc(encodeURIComponent(idempotencyKey))
        .get()
    );
  }
  async listLineageByStage(stage: SourceLineageStage) {
    const snap = await this.db.collection(C.lineage).where('stage', '==', stage).get();
    return snap.docs.map((doc) => doc.data() as FieldLineageRecord);
  }
  async listEntityHistory(entityType: CatalogEntityType, entityId: string) {
    const snap = await this.db.collection(C.revisions)
      .where('entityType', '==', entityType)
      .where('entityId', '==', entityId)
      .orderBy('revision', 'asc')
      .get();
    return snap.docs.map((doc) => doc.data() as EntityRevisionRecord);
  }
  async listRevisionHistory() {
    const snap = await this.db.collection(C.revisions).get();
    return snap.docs
      .map((doc) => doc.data() as EntityRevisionRecord)
      .sort((a, b) =>
        a.entityType.localeCompare(b.entityType) ||
        a.entityId.localeCompare(b.entityId) ||
        a.revision - b.revision
      );
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

  async stage(release: ProjectionRelease<ErpPublicProduct>) {
    await this.db.collection(C.releases).doc(release.releaseId).create(release);
  }
  async stageEvidence(input: {
    manifest: ProjectionReleaseManifest;
    lineage: ProjectionFieldLineageRecord[];
  }) {
    const releaseRef = this.db.collection(C.releases).doc(input.manifest.releaseId);
    const releaseSnap = await releaseRef.get();
    if (!releaseSnap.exists || releaseSnap.get('status') !== 'BUILDING') {
      throw new Error('Projection evidence requires a BUILDING release');
    }

    const chunkSize = 400;
    for (let offset = 0; offset < input.lineage.length; offset += chunkSize) {
      const batch = this.db.batch();
      for (const item of input.lineage.slice(offset, offset + chunkSize)) {
        batch.set(
          this.db.collection(C.projectionLineage).doc(item.lineageRecordId),
          item
        );
      }
      await batch.commit();
    }

    await this.db.runTransaction(async (tx) => {
      const freshRelease = await tx.get(releaseRef);
      if (!freshRelease.exists || freshRelease.get('status') !== 'BUILDING') {
        throw new Error('Release changed while staging evidence');
      }
      tx.create(
        this.db.collection(C.releaseManifests).doc(input.manifest.releaseId),
        input.manifest
      );
      tx.update(releaseRef, { status: 'VALIDATING' });
    });
  }
  async markReady(releaseId: string) {
    const releaseRef = this.db.collection(C.releases).doc(releaseId);
    const [releaseSnap, manifestSnap, evidenceCountSnap] = await Promise.all([
      releaseRef.get(),
      this.db.collection(C.releaseManifests).doc(releaseId).get(),
      this.db.collection(C.projectionLineage)
        .where('releaseId', '==', releaseId)
        .count()
        .get()
    ]);
    if (!releaseSnap.exists || releaseSnap.get('status') !== 'VALIDATING') {
      throw new Error('Only VALIDATING release can become READY');
    }
    if (!manifestSnap.exists) throw new Error('Release manifest not found');
    const manifest = manifestSnap.data() as ProjectionReleaseManifest;
    if (evidenceCountSnap.data().count !== manifest.fieldEvidenceCount) {
      throw new Error('Projection field evidence count mismatch');
    }
    await releaseRef.update({ status: 'READY' });
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
  async getManifest(releaseId: string) {
    return data<ProjectionReleaseManifest>(
      await this.db.collection(C.releaseManifests).doc(releaseId).get()
    );
  }
  async listProjectionLineage(releaseId: string) {
    const snap = await this.db.collection(C.projectionLineage)
      .where('releaseId', '==', releaseId)
      .get();
    return snap.docs.map((doc) => doc.data() as ProjectionFieldLineageRecord);
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
