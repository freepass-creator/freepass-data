import { getTargetFirebaseApp } from './firebase-target.js';
import { FIRESTORE_COLLECTIONS, sourceFirestoreDocumentId } from './firestore-layout.js';
import { decodeFirestoreDocument, decodeFirestoreIdentityDocument } from './firestore-document.js';
import { getFirestore } from 'firebase-admin/firestore';
import { stableDigest } from '../shared/stable-digest.js';
import { assertProjectionReleaseIntegrity } from '../shared/projection-integrity.js';
import { readFirestoreActiveProjection, readFirestoreActiveProjectionEvidence, readFirestoreProjectionLineage, readFirestoreProjectionManifest } from './firestore-projection-evidence.js';
const C = {
    vehicleModels: FIRESTORE_COLLECTIONS.catalog.vehicleModels,
    vehicleAssets: FIRESTORE_COLLECTIONS.catalog.vehicleAssets,
    products: FIRESTORE_COLLECTIONS.catalog.products,
    offers: FIRESTORE_COLLECTIONS.catalog.offers,
    policies: FIRESTORE_COLLECTIONS.catalog.policies,
    receipts: FIRESTORE_COLLECTIONS.commands.receipts,
    canonicalizationReceipts: FIRESTORE_COLLECTIONS.commands.canonicalizationReceipts,
    manualCatalogEntryReceipts: FIRESTORE_COLLECTIONS.commands.manualCatalogEntryReceipts,
    reviewedSourceChangeReceipts: FIRESTORE_COLLECTIONS.commands.reviewedSourceChangeReceipts,
    writerOwnership: FIRESTORE_COLLECTIONS.ownership.writer,
    writerOwnershipTransferReceipts: FIRESTORE_COLLECTIONS.ownership.transferReceipts,
    sources: FIRESTORE_COLLECTIONS.source.definitions,
    sourceRuns: FIRESTORE_COLLECTIONS.source.runs,
    sourceHeads: FIRESTORE_COLLECTIONS.source.heads,
    raw: FIRESTORE_COLLECTIONS.source.raw,
    candidates: FIRESTORE_COLLECTIONS.source.candidates,
    lineage: FIRESTORE_COLLECTIONS.source.lineage,
    sourceBindings: FIRESTORE_COLLECTIONS.catalog.sourceBindings,
    revisions: FIRESTORE_COLLECTIONS.catalog.revisions,
    audits: FIRESTORE_COLLECTIONS.evidence.audits,
    outbox: FIRESTORE_COLLECTIONS.evidence.outbox,
    releases: FIRESTORE_COLLECTIONS.projection.releases,
    releaseManifests: FIRESTORE_COLLECTIONS.projection.manifests,
    projectionLineage: FIRESTORE_COLLECTIONS.projection.lineage,
    projectionDeliveryReceipts: FIRESTORE_COLLECTIONS.projection.deliveryReceipts,
    sheetDeliveryEvidence: FIRESTORE_COLLECTIONS.projection.sheetDeliveryEvidence,
    activeReleases: FIRESTORE_COLLECTIONS.projection.active
};
const data = (snap) => decodeFirestoreDocument(snap);
const catalogEntity = (snap) => decodeFirestoreIdentityDocument(snap, 'id');
export class FirestoreDataStore {
    db;
    constructor(db) {
        this.db = db;
    }
    async transact(fn) {
        return this.db.runTransaction(async (native) => {
            const tx = {
                getVehicleModel: async (id) => catalogEntity(await native.get(this.db.collection(C.vehicleModels).doc(id))),
                putVehicleModel: async (model) => {
                    native.create(this.db.collection(C.vehicleModels).doc(model.id), model);
                },
                getVehicleAsset: async (id) => catalogEntity(await native.get(this.db.collection(C.vehicleAssets).doc(id))),
                putVehicleAsset: async (asset) => {
                    native.create(this.db.collection(C.vehicleAssets).doc(asset.id), asset);
                },
                updateVehicleAsset: async (asset) => {
                    native.set(this.db.collection(C.vehicleAssets).doc(asset.id), asset);
                },
                updateVehicleModel: async (model) => {
                    native.update(this.db.collection(C.vehicleModels).doc(model.id), model);
                },
                updateProduct: async (product) => {
                    native.update(this.db.collection(C.products).doc(product.id), product);
                },
                listProductsByVehicleModel: async (vehicleModelId) => {
                    const snap = await native.get(this.db.collection(C.products).where('vehicleModelId', '==', vehicleModelId));
                    return snap.docs.map((doc) => catalogEntity(doc)).filter((p) => !!p);
                },
                getProduct: async (id) => catalogEntity(await native.get(this.db.collection(C.products).doc(id))),
                putProduct: async (product) => {
                    native.create(this.db.collection(C.products).doc(product.id), product);
                },
                getOffer: async (id) => catalogEntity(await native.get(this.db.collection(C.offers).doc(id))),
                putOffer: async (offer) => { native.set(this.db.collection(C.offers).doc(offer.id), offer); },
                getSourceDefinition: async (sourceId) => data(await native.get(this.db.collection(C.sources).doc(sourceFirestoreDocumentId(sourceId)))),
                putSourceDefinition: async (source) => {
                    native.create(this.db.collection(C.sources).doc(sourceFirestoreDocumentId(source.sourceId)), source);
                },
                getSourceRun: async (runId) => data(await native.get(this.db.collection(C.sourceRuns).doc(runId))),
                putSourceRun: async (run) => {
                    native.create(this.db.collection(C.sourceRuns).doc(run.runId), run);
                },
                getSourceHead: async (sourceId) => data(await native.get(this.db.collection(C.sourceHeads).doc(sourceFirestoreDocumentId(sourceId)))),
                putSourceHead: async (head) => {
                    native.create(this.db.collection(C.sourceHeads).doc(sourceFirestoreDocumentId(head.sourceId)), head);
                },
                getRawRecord: async (rawRecordId) => data(await native.get(this.db.collection(C.raw).doc(sourceFirestoreDocumentId(rawRecordId)))),
                putRawRecord: async (record) => {
                    native.create(this.db.collection(C.raw).doc(sourceFirestoreDocumentId(record.rawRecordId)), record);
                },
                getCandidate: async (candidateId) => data(await native.get(this.db.collection(C.candidates).doc(sourceFirestoreDocumentId(candidateId)))),
                putCandidate: async (record) => {
                    native.create(this.db.collection(C.candidates).doc(sourceFirestoreDocumentId(record.candidateId)), record);
                },
                listLineageForCandidate: async (candidateId) => {
                    const snap = await native.get(this.db.collection(C.lineage).where('normalized.candidateId', '==', candidateId));
                    return snap.docs.map((doc) => doc.data());
                },
                appendLineage: async (record) => {
                    native.create(this.db.collection(C.lineage).doc(record.lineageRecordId), record);
                },
                getSourceBinding: async (bindingId) => data(await native.get(this.db.collection(C.sourceBindings).doc(bindingId))),
                putSourceBinding: async (binding) => {
                    native.create(this.db.collection(C.sourceBindings).doc(binding.bindingId), binding);
                },
                updateSourceBinding: async (binding) => {
                    native.set(this.db.collection(C.sourceBindings).doc(binding.bindingId), binding);
                },
                getCanonicalizationReceipt: async (key) => data(await native.get(this.db.collection(C.canonicalizationReceipts).doc(key))),
                putCanonicalizationReceipt: async (receipt) => {
                    native.create(this.db.collection(C.canonicalizationReceipts).doc(receipt.idempotencyKey), receipt);
                },
                getCommandReceipt: async (key) => data(await native.get(this.db.collection(C.receipts).doc(key))),
                putCommandReceipt: async (receipt) => {
                    native.create(this.db.collection(C.receipts).doc(receipt.idempotencyKey), receipt);
                },
                getManualCatalogEntryReceipt: async (key) => data(await native.get(this.db.collection(C.manualCatalogEntryReceipts).doc(encodeURIComponent(key)))),
                putManualCatalogEntryReceipt: async (receipt) => {
                    native.create(this.db.collection(C.manualCatalogEntryReceipts).doc(encodeURIComponent(receipt.idempotencyKey)), receipt);
                },
                getReviewedSourceChangeReceipt: async (key) => data(await native.get(this.db.collection(C.reviewedSourceChangeReceipts)
                    .doc(encodeURIComponent(key)))),
                putReviewedSourceChangeReceipt: async (receipt) => {
                    native.create(this.db.collection(C.reviewedSourceChangeReceipts).doc(encodeURIComponent(receipt.idempotencyKey)), receipt);
                },
                getCatalogWriterOwnership: async () => data(await native.get(this.db.collection(C.writerOwnership).doc('catalog'))),
                putCatalogWriterOwnership: async (ownership) => {
                    native.create(this.db.collection(C.writerOwnership).doc('catalog'), ownership);
                },
                updateCatalogWriterOwnership: async (ownership) => {
                    native.update(this.db.collection(C.writerOwnership).doc('catalog'), ownership);
                },
                getWriterOwnershipTransferReceipt: async (key) => data(await native.get(this.db.collection(C.writerOwnershipTransferReceipts)
                    .doc(encodeURIComponent(key)))),
                putWriterOwnershipTransferReceipt: async (receipt) => {
                    native.create(this.db.collection(C.writerOwnershipTransferReceipts)
                        .doc(encodeURIComponent(receipt.idempotencyKey)), receipt);
                },
                appendAudit: async (event) => {
                    native.create(this.db.collection(C.audits).doc(event.eventId), event);
                },
                appendRevision: async (record) => {
                    native.create(this.db.collection(C.revisions).doc(record.revisionRecordId), record);
                },
                appendOutbox: async (event) => {
                    native.create(this.db.collection(C.outbox).doc(event.eventId), event);
                }
            };
            return fn(tx);
        });
    }
    async getVehicleModel(id) {
        return catalogEntity(await this.db.collection(C.vehicleModels).doc(id).get());
    }
    async getVehicleAsset(id) {
        return catalogEntity(await this.db.collection(C.vehicleAssets).doc(id).get());
    }
    async getProduct(id) {
        return catalogEntity(await this.db.collection(C.products).doc(id).get());
    }
    async getOffer(id) { return catalogEntity(await this.db.collection(C.offers).doc(id).get()); }
    async getSourceDefinition(sourceId) {
        return data(await this.db.collection(C.sources).doc(sourceFirestoreDocumentId(sourceId)).get());
    }
    async getSourceRun(runId) {
        return data(await this.db.collection(C.sourceRuns).doc(runId).get());
    }
    async getSourceHead(sourceId) {
        return data(await this.db.collection(C.sourceHeads).doc(sourceFirestoreDocumentId(sourceId)).get());
    }
    async getRawRecord(rawRecordId) {
        return data(await this.db.collection(C.raw).doc(sourceFirestoreDocumentId(rawRecordId)).get());
    }
    async listRawRecordsByRun(runId) {
        const snap = await this.db.collection(C.raw).where('runId', '==', runId).get();
        return snap.docs.map((item) => item.data());
    }
    async getCandidate(candidateId) {
        return data(await this.db.collection(C.candidates).doc(sourceFirestoreDocumentId(candidateId)).get());
    }
    async listCandidatesByRun(runId) {
        const snap = await this.db.collection(C.candidates).where('runId', '==', runId).get();
        return snap.docs.map((item) => item.data());
    }
    async getSourceBinding(bindingId) {
        return data(await this.db.collection(C.sourceBindings).doc(bindingId).get());
    }
    async getCanonicalizationReceipt(idempotencyKey) {
        return data(await this.db.collection(C.canonicalizationReceipts).doc(idempotencyKey).get());
    }
    async getManualCatalogEntryReceipt(idempotencyKey) {
        return data(await this.db.collection(C.manualCatalogEntryReceipts)
            .doc(encodeURIComponent(idempotencyKey))
            .get());
    }
    async getReviewedSourceChangeReceipt(idempotencyKey) {
        return data(await this.db.collection(C.reviewedSourceChangeReceipts)
            .doc(encodeURIComponent(idempotencyKey))
            .get());
    }
    async getCatalogWriterOwnership() {
        return data(await this.db.collection(C.writerOwnership).doc('catalog').get());
    }
    async getWriterOwnershipTransferReceipt(idempotencyKey) {
        return data(await this.db.collection(C.writerOwnershipTransferReceipts)
            .doc(encodeURIComponent(idempotencyKey))
            .get());
    }
    async listLineageByStage(stage) {
        const snap = await this.db.collection(C.lineage).where('stage', '==', stage).get();
        return snap.docs.map((doc) => doc.data());
    }
    async listEntityHistory(entityType, entityId) {
        const snap = await this.db.collection(C.revisions)
            .where('entityType', '==', entityType)
            .where('entityId', '==', entityId)
            .orderBy('revision', 'asc')
            .get();
        return snap.docs.map((doc) => doc.data());
    }
    async listRevisionHistory() {
        const snap = await this.db.collection(C.revisions).get();
        return snap.docs
            .map((doc) => decodeFirestoreIdentityDocument(doc, 'revisionRecordId'))
            .sort((a, b) => a.entityType.localeCompare(b.entityType) ||
            a.entityId.localeCompare(b.entityId) ||
            a.revision - b.revision);
    }
    async all(collection) {
        const snap = await this.db.collection(collection).get();
        return snap.docs.map((doc) => decodeFirestoreIdentityDocument(doc, 'id'));
    }
    async listVehicleModels() { return this.all(C.vehicleModels); }
    async listVehicleAssets() { return this.all(C.vehicleAssets); }
    async listProducts() { return this.all(C.products); }
    async listOffers() { return this.all(C.offers); }
    async listPolicies() { return this.all(C.policies); }
    /** Read-only backup. Private persistence/readback and operating approval remain external gates. */
    async captureFirstActivationPreimage(eventId) {
        if (!/^[A-Za-z0-9:_-]{1,200}$/.test(eventId))
            throw new Error('RECOVERY_EVENT_INVALID');
        return this.db.runTransaction(async (tx) => {
            const [event, active, receipt] = await Promise.all([
                tx.get(this.db.collection(C.outbox).doc(eventId)),
                tx.get(this.db.collection(C.activeReleases).doc('erp-public')),
                tx.get(this.db.collection(C.projectionDeliveryReceipts).doc(encodeURIComponent(eventId)))
            ]);
            const existingPublication = await Promise.all([C.releases, C.releaseManifests, C.projectionLineage, C.projectionDeliveryReceipts]
                .map(collection => tx.get(this.db.collection(collection).where('projectionId', '==', 'erp-public').limit(1))));
            if (existingPublication.some(snapshot => !snapshot.empty))
                throw new Error('RECOVERY_PRIOR_PUBLICATION_EXISTS');
            if (!event.exists || event.get('eventId') !== eventId || event.get('status') !== 'PENDING' || active.exists || receipt.exists)
                throw new Error('RECOVERY_FIRST_ACTIVATION_REQUIRED');
            const backup = { schema: 'first-activation-preimage/v1', eventId,
                event: event.data(), eventUpdateTime: event.updateTime.toDate().toISOString(), active: null, receipt: null, publicationDocumentsAbsent: true };
            return { ...backup, digest: stableDigest(backup) };
        });
    }
    /** Builds exact document preconditions; never writes or deletes operational data. */
    async planFirstActivationRecovery(backup, approvedBackupDigest) {
        const { digest, ...body } = backup;
        if (backup.schema !== 'first-activation-preimage/v1' || stableDigest(body) !== digest || digest !== approvedBackupDigest ||
            backup.publicationDocumentsAbsent !== true ||
            backup.active !== null || backup.receipt !== null || backup.eventId !== backup.event.eventId || backup.event.status !== 'PENDING')
            throw new Error('RECOVERY_PREIMAGE_INVALID');
        return this.db.runTransaction(async (tx) => {
            const eventRef = this.db.collection(C.outbox).doc(backup.eventId);
            const activeRef = this.db.collection(C.activeReleases).doc('erp-public');
            const receiptRef = this.db.collection(C.projectionDeliveryReceipts).doc(encodeURIComponent(backup.eventId));
            const [event, active, receipt] = await Promise.all([tx.get(eventRef), tx.get(activeRef), tx.get(receiptRef)]);
            const releaseId = receipt.get('releaseId');
            if (!releaseId || !/^rel_[A-Za-z0-9_-]+$/.test(releaseId) || active.get('releaseId') !== releaseId ||
                receipt.get('eventId') !== backup.eventId || receipt.get('eventType') !== backup.event.eventType ||
                receipt.get('targetRevision') !== backup.event.targetRevision || receipt.get('projectionId') !== 'erp-public' ||
                event.get('eventId') !== backup.eventId || !['PROCESSING', 'DONE'].includes(event.get('status')))
                throw new Error('RECOVERY_SCOPE_CHANGED');
            // The event's business payload must still be the backed-up event.
            const control = new Set(['status', 'leaseOwner', 'leaseUntil', 'attempts', 'nextAttemptAt', 'lastError']);
            const business = (value) => Object.fromEntries(Object.entries(value).filter(([key]) => !control.has(key)));
            if (stableDigest(business(event.data())) !== stableDigest(business(backup.event)))
                throw new Error('RECOVERY_EVENT_CHANGED');
            const releaseRef = this.db.collection(C.releases).doc(releaseId);
            const [release, manifest, lineage] = await Promise.all([
                tx.get(releaseRef), tx.get(this.db.collection(C.releaseManifests).doc(releaseId)),
                tx.get(this.db.collection(C.projectionLineage).where('releaseId', '==', releaseId))
            ]);
            if (!release.exists || release.get('status') !== 'ACTIVE' || release.get('projectionId') !== 'erp-public' ||
                receipt.get('inputDigest') !== release.get('inputDigest') || receipt.get('dataDigest') !== release.get('dataDigest'))
                throw new Error('RECOVERY_RELEASE_CHANGED');
            if (!manifest.exists)
                throw new Error('RECOVERY_MANIFEST_MISSING');
            assertProjectionReleaseIntegrity(release.data(), manifest.data(), lineage.docs.map(doc => doc.data()));
            const allowedReleaseFields = new Set(['releaseId', 'projectionId', 'schemaVersion', 'canonicalRevision', 'manifestId',
                'inputDigest', 'dataDigest', 'status', 'generatedAt', 'activatedAt', 'data']);
            if (Object.keys(release.data()).some(key => !allowedReleaseFields.has(key)))
                throw new Error('RECOVERY_RELEASE_FIELDS_CHANGED');
            const { activatedAt: _activatedAt, ...readyImage } = release.data();
            const fence = (doc) => ({ path: doc.ref.path, updateTime: doc.updateTime.toDate().toISOString(),
                updateSeconds: doc.updateTime.seconds, updateNanos: doc.updateTime.nanoseconds, digest: stableDigest(doc.data()) });
            const plan = { schema: 'first-activation-recovery/v1', backupDigest: backup.digest, eventId: backup.eventId, releaseId,
                restore: [{ ...fence(active), action: 'DELETE', value: null },
                    { ...fence(event), action: 'SET', value: backup.event },
                    { ...fence(release), action: 'SET', value: { ...readyImage, status: 'READY' } }],
                preserve: [fence(receipt), fence(manifest), ...lineage.docs.map(fence)],
                newDocuments: [release.ref.path, manifest.ref.path, receipt.ref.path, ...lineage.docs.map(doc => doc.ref.path)] };
            return { ...plan, digest: stableDigest(plan) };
        });
    }
    async stage(release) {
        await this.db.collection(C.releases).doc(release.releaseId).create(release);
    }
    async stageEvidence(input) {
        const releaseRef = this.db.collection(C.releases).doc(input.manifest.releaseId);
        const releaseSnap = await releaseRef.get();
        if (!releaseSnap.exists || releaseSnap.get('status') !== 'BUILDING') {
            throw new Error('Projection evidence requires a BUILDING release');
        }
        assertProjectionReleaseIntegrity(releaseSnap.data(), input.manifest, input.lineage);
        const chunkSize = 400;
        for (let offset = 0; offset < input.lineage.length; offset += chunkSize) {
            const batch = this.db.batch();
            for (const item of input.lineage.slice(offset, offset + chunkSize)) {
                batch.set(this.db.collection(C.projectionLineage).doc(item.lineageRecordId), item);
            }
            await batch.commit();
        }
        await this.db.runTransaction(async (tx) => {
            const freshRelease = await tx.get(releaseRef);
            if (!freshRelease.exists || freshRelease.get('status') !== 'BUILDING') {
                throw new Error('Release changed while staging evidence');
            }
            tx.create(this.db.collection(C.releaseManifests).doc(input.manifest.releaseId), input.manifest);
            tx.update(releaseRef, { status: 'VALIDATING' });
        });
    }
    async markReady(releaseId) {
        const releaseRef = this.db.collection(C.releases).doc(releaseId);
        const manifestRef = this.db.collection(C.releaseManifests).doc(releaseId);
        const evidenceQuery = this.db.collection(C.projectionLineage)
            .where('releaseId', '==', releaseId);
        await this.db.runTransaction(async (tx) => {
            const releaseSnap = await tx.get(releaseRef);
            const manifestSnap = await tx.get(manifestRef);
            const evidenceSnap = await tx.get(evidenceQuery);
            if (!releaseSnap.exists || releaseSnap.get('status') !== 'VALIDATING') {
                throw new Error('Only VALIDATING release can become READY');
            }
            if (!manifestSnap.exists)
                throw new Error('Release manifest not found');
            const manifest = manifestSnap.data();
            const evidence = evidenceSnap.docs.map((doc) => doc.data());
            assertProjectionReleaseIntegrity(releaseSnap.data(), manifest, evidence);
            tx.update(releaseRef, { status: 'READY' });
        });
    }
    async readPublishGuard(tx, guard) {
        if (!guard)
            throw new Error('PROJECTION_SOURCE_GUARD_REQUIRED');
        if (!guard.sources.length)
            throw new Error('PROJECTION_SOURCE_FRESHNESS_UNKNOWN');
        for (const witness of guard.sources) {
            const definition = data(await tx.get(this.db.collection(C.sources).doc(sourceFirestoreDocumentId(witness.sourceId))));
            const head = data(await tx.get(this.db.collection(C.sourceHeads).doc(sourceFirestoreDocumentId(witness.sourceId))));
            const run = data(await tx.get(this.db.collection(C.sourceRuns).doc(witness.runId)));
            if (stableDigest([definition, head, run]) !== witness.digest)
                throw new Error('PROJECTION_SOURCE_CHANGED');
        }
        if (guard.claim) {
            const snap = await tx.get(this.db.collection(C.outbox).doc(guard.claim.eventId));
            const event = data(snap);
            if (!event || event.status !== 'PROCESSING' || event.leaseOwner !== guard.claim.lease.leaseOwner ||
                event.leaseUntil !== guard.claim.lease.leaseUntil)
                throw new Error('OUTBOX_LEASE_LOST');
        }
        const now = Date.parse(guard.now());
        if (!Number.isFinite(now))
            throw new Error('PROJECTION_SOURCE_TIME_INVALID');
        if (guard.sources.some(witness => now > witness.expiresAt))
            throw new Error('PROJECTION_SOURCE_STALE');
        if (guard.claim && now >= Date.parse(guard.claim.lease.leaseUntil))
            throw new Error('OUTBOX_LEASE_LOST');
    }
    async activate(releaseId, guard) {
        await this.db.runTransaction(async (tx) => {
            const ref = this.db.collection(C.releases).doc(releaseId);
            const manifestRef = this.db.collection(C.releaseManifests).doc(releaseId);
            const evidenceQuery = this.db.collection(C.projectionLineage)
                .where('releaseId', '==', releaseId);
            const snap = await tx.get(ref);
            const manifestSnap = await tx.get(manifestRef);
            const evidenceSnap = await tx.get(evidenceQuery);
            if (!snap.exists || snap.get('status') !== 'READY') {
                throw new Error('Only READY release can activate');
            }
            if (!manifestSnap.exists)
                throw new Error('Release manifest not found');
            const manifest = manifestSnap.data();
            const evidence = evidenceSnap.docs.map((doc) => doc.data());
            assertProjectionReleaseIntegrity(snap.data(), manifest, evidence);
            const projectionId = snap.get('projectionId');
            const activeRef = this.db.collection(C.activeReleases).doc(projectionId);
            const activeSnap = await tx.get(activeRef);
            const previousId = activeSnap.exists ? activeSnap.get('releaseId') : null;
            if (guard?.expectedActiveReleaseId !== undefined && previousId !== guard.expectedActiveReleaseId)
                throw new Error('PROJECTION_SOURCE_ACTIVE_CHANGED');
            if (projectionId === 'erp-public' && !previousId &&
                (guard?.expectedActiveReleaseId !== null || !guard?.claim || !guard.receipt))
                throw new Error('PROJECTION_FIRST_ACTIVATION_APPROVAL_REQUIRED');
            if (previousId && previousId !== releaseId && (!guard?.claim || !guard.receipt))
                throw new Error('PROJECTION_ACTIVATION_APPROVAL_REQUIRED');
            if (projectionId === 'erp-public')
                await this.readPublishGuard(tx, guard);
            if (guard?.receipt)
                tx.create(this.db.collection(C.projectionDeliveryReceipts)
                    .doc(encodeURIComponent(guard.receipt.eventId)), guard.receipt);
            if (previousId && previousId !== releaseId) {
                tx.update(this.db.collection(C.releases).doc(previousId), { status: 'READY' });
            }
            tx.update(ref, { status: 'ACTIVE', activatedAt: new Date().toISOString() });
            tx.set(activeRef, { releaseId, projectionId });
        });
    }
    async getActive(projectionId) {
        return readFirestoreActiveProjection(this.db, projectionId);
    }
    async getActiveEvidenceSnapshot(projectionId) {
        return readFirestoreActiveProjectionEvidence(this.db, projectionId);
    }
    async getManifest(releaseId) {
        return readFirestoreProjectionManifest(this.db, releaseId);
    }
    async listProjectionLineage(releaseId) {
        return readFirestoreProjectionLineage(this.db, releaseId);
    }
    async getDeliveryReceipt(eventId) {
        return data(await this.db.collection(C.projectionDeliveryReceipts)
            .doc(encodeURIComponent(eventId))
            .get());
    }
    async putDeliveryReceipt(receipt, guard) {
        if (receipt.projectionId !== 'erp-public') {
            await this.db.collection(C.projectionDeliveryReceipts).doc(encodeURIComponent(receipt.eventId)).create(receipt);
            return;
        }
        await this.db.runTransaction(async (tx) => {
            const active = await tx.get(this.db.collection(C.activeReleases).doc(receipt.projectionId));
            if (!active.exists || active.get('releaseId') !== receipt.releaseId)
                throw new Error('PROJECTION_SOURCE_ACTIVE_CHANGED');
            await this.readPublishGuard(tx, guard);
            tx.create(this.db.collection(C.projectionDeliveryReceipts).doc(encodeURIComponent(receipt.eventId)), receipt);
        });
    }
    async getSheetDeliveryEvidence(receiptId) {
        return data(await this.db.collection(C.sheetDeliveryEvidence)
            .doc(encodeURIComponent(receiptId))
            .get());
    }
    async putSheetDeliveryEvidence(evidence) {
        await this.db.collection(C.sheetDeliveryEvidence)
            .doc(encodeURIComponent(evidence.receiptId))
            .create(evidence);
    }
    async listSheetDeliveryEvidence(consumerId) {
        const snap = await this.db.collection(C.sheetDeliveryEvidence)
            .where('consumerId', '==', consumerId)
            .get();
        return snap.docs.map((doc) => doc.data());
    }
    async claimNext(input) {
        if (input.eventId !== undefined && !/^[A-Za-z0-9:_-]{1,200}$/.test(input.eventId))
            return null;
        const started = performance.now();
        const currentTime = () => new Date(Date.parse(input.now) + Math.floor(performance.now() - started)).toISOString();
        const valid = () => Date.parse(input.leaseUntil) > Date.parse(currentTime()) && (!input.expiresAt || (Number.isFinite(Date.parse(input.expiresAt)) && Date.parse(input.expiresAt) > Date.parse(currentTime())));
        if (!valid())
            return null;
        const snap = input.eventId
            ? { docs: [await this.db.collection(C.outbox).doc(input.eventId).get()] }
            : await this.db.collection(C.outbox)
                .where('status', 'in', ['PENDING', 'PROCESSING'])
                .orderBy('occurredAt', 'asc')
                .limit(20)
                .get();
        for (const candidate of snap.docs) {
            const claimed = await this.db.runTransaction(async (tx) => {
                const fresh = await tx.get(candidate.ref);
                if (!fresh.exists || !valid())
                    return null;
                const event = { id: fresh.id, ...fresh.data() };
                if (input.eventId && event.eventId !== input.eventId)
                    return null;
                if (input.expectedEventDigest && stableDigest(fresh.data()) !== input.expectedEventDigest)
                    return null;
                const leaseExpired = event.status === 'PROCESSING' && Boolean(event.leaseUntil) && event.leaseUntil <= input.now;
                const due = !event.nextAttemptAt || event.nextAttemptAt <= input.now;
                if (!due || (event.status !== 'PENDING' && !leaseExpired))
                    return null;
                const receipt = await tx.get(this.db.collection(C.projectionDeliveryReceipts).doc(encodeURIComponent(event.eventId)));
                if (receipt.exists) {
                    const active = await tx.get(this.db.collection(C.activeReleases).doc(receipt.get('projectionId')));
                    if (!active.exists || active.get('releaseId') !== receipt.get('releaseId'))
                        return null;
                }
                if (!valid())
                    return null;
                tx.update(candidate.ref, {
                    status: 'PROCESSING',
                    leaseOwner: input.workerId,
                    leaseUntil: input.leaseUntil
                });
                return { ...event, status: 'PROCESSING', leaseOwner: input.workerId, leaseUntil: input.leaseUntil };
            });
            if (claimed)
                return claimed;
        }
        return null;
    }
    async updateClaimedOutbox(eventId, lease, update) {
        const ref = this.db.collection(C.outbox).doc(eventId);
        await this.db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (!snap.exists)
                throw new Error('Outbox event not found');
            const event = snap.data();
            if (!lease || event.status !== 'PROCESSING' || event.leaseOwner !== lease.leaseOwner ||
                event.leaseUntil !== lease.leaseUntil)
                throw new Error('OUTBOX_LEASE_LOST');
            tx.update(ref, update);
        });
    }
    async markDone(eventId, lease) {
        await this.updateClaimedOutbox(eventId, lease, {
            status: 'DONE', leaseOwner: null, leaseUntil: null
        });
    }
    async markRetry(input) {
        await this.updateClaimedOutbox(input.eventId, input.lease, {
            status: 'PENDING', attempts: input.attempts, nextAttemptAt: input.nextAttemptAt,
            lastError: input.error, leaseOwner: null, leaseUntil: null
        });
    }
    async moveToDeadLetter(input) {
        await this.updateClaimedOutbox(input.eventId, input.lease, {
            status: 'DEAD_LETTER', attempts: input.attempts, lastError: input.error,
            leaseOwner: null, leaseUntil: null
        });
    }
}
export async function createFirestoreDataStore() {
    return new FirestoreDataStore(getFirestore(getTargetFirebaseApp()));
}
