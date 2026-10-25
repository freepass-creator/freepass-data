import { stableDigest } from '../shared/stable-digest.js';
import { assertProjectionReleaseIntegrity } from '../shared/projection-integrity.js';
const copy = (value) => structuredClone(value);
export class MemoryDataStore {
    models = new Map();
    assets = new Map();
    products = new Map();
    offers = new Map();
    policies = new Map();
    receipts = new Map();
    canonicalizationReceipts = new Map();
    manualCatalogEntryReceipts = new Map();
    reviewedSourceChangeReceipts = new Map();
    catalogWriterOwnership = null;
    writerOwnershipTransferReceipts = new Map();
    sourceDefinitions = new Map();
    sourceRuns = new Map();
    sourceHeads = new Map();
    rawRecords = new Map();
    candidates = new Map();
    lineage = new Map();
    sourceBindings = new Map();
    revisionHistory = new Map();
    audits = [];
    outbox = new Map();
    releases = new Map();
    manifests = new Map();
    projectionLineage = new Map();
    deliveryReceipts = new Map();
    sheetDeliveryEvidence = new Map();
    active = new Map();
    async seed(input) {
        for (const x of input.vehicleModels ?? [])
            this.models.set(x.id, copy(x));
        for (const x of input.vehicleAssets ?? [])
            this.assets.set(x.id, copy(x));
        for (const x of input.products ?? [])
            this.products.set(x.id, copy(x));
        for (const x of input.offers ?? [])
            this.offers.set(x.id, copy(x));
        for (const x of input.policies ?? [])
            this.policies.set(x.id, copy(x));
        for (const x of input.sourceDefinitions ?? [])
            this.sourceDefinitions.set(x.sourceId, copy(x));
        for (const x of input.sourceRuns ?? [])
            this.sourceRuns.set(x.runId, copy(x));
        for (const x of input.sourceHeads ?? [])
            this.sourceHeads.set(x.sourceId, copy(x));
        for (const x of input.rawRecords ?? [])
            this.rawRecords.set(x.rawRecordId, copy(x));
        for (const x of input.candidates ?? [])
            this.candidates.set(x.candidateId, copy(x));
        for (const x of input.lineage ?? [])
            this.lineage.set(x.lineageRecordId, copy(x));
        for (const x of input.sourceBindings ?? [])
            this.sourceBindings.set(x.bindingId, copy(x));
        for (const x of input.canonicalizationReceipts ?? []) {
            this.canonicalizationReceipts.set(x.idempotencyKey, copy(x));
        }
        for (const x of input.manualCatalogEntryReceipts ?? []) {
            this.manualCatalogEntryReceipts.set(x.idempotencyKey, copy(x));
        }
        for (const x of input.reviewedSourceChangeReceipts ?? []) {
            this.reviewedSourceChangeReceipts.set(x.idempotencyKey, copy(x));
        }
        if (input.catalogWriterOwnership !== undefined) {
            this.catalogWriterOwnership = copy(input.catalogWriterOwnership);
        }
        for (const x of input.writerOwnershipTransferReceipts ?? []) {
            this.writerOwnershipTransferReceipts.set(x.idempotencyKey, copy(x));
        }
        for (const x of input.revisionHistory ?? []) {
            this.revisionHistory.set(x.revisionRecordId, copy(x));
        }
    }
    async transact(fn) {
        const snapshot = {
            models: copy([...this.models.entries()]),
            assets: copy([...this.assets.entries()]),
            products: copy([...this.products.entries()]),
            offers: copy([...this.offers.entries()]),
            receipts: copy([...this.receipts.entries()]),
            canonicalizationReceipts: copy([...this.canonicalizationReceipts.entries()]),
            manualCatalogEntryReceipts: copy([...this.manualCatalogEntryReceipts.entries()]),
            reviewedSourceChangeReceipts: copy([...this.reviewedSourceChangeReceipts.entries()]),
            catalogWriterOwnership: copy(this.catalogWriterOwnership),
            writerOwnershipTransferReceipts: copy([...this.writerOwnershipTransferReceipts.entries()]),
            sourceDefinitions: copy([...this.sourceDefinitions.entries()]),
            sourceRuns: copy([...this.sourceRuns.entries()]),
            sourceHeads: copy([...this.sourceHeads.entries()]),
            rawRecords: copy([...this.rawRecords.entries()]),
            candidates: copy([...this.candidates.entries()]),
            lineage: copy([...this.lineage.entries()]),
            sourceBindings: copy([...this.sourceBindings.entries()]),
            revisionHistory: copy([...this.revisionHistory.entries()]),
            audits: copy(this.audits),
            outbox: copy([...this.outbox.entries()])
        };
        const tx = {
            getVehicleModel: async (id) => copy(this.models.get(id) ?? null),
            putVehicleModel: async (model) => { this.models.set(model.id, copy(model)); },
            getVehicleAsset: async (id) => copy(this.assets.get(id) ?? null),
            putVehicleAsset: async (asset) => {
                if (this.assets.has(asset.id))
                    throw new Error(`VehicleAsset already exists: ${asset.id}`);
                this.assets.set(asset.id, copy(asset));
            },
            updateVehicleAsset: async (asset) => {
                if (!this.assets.has(asset.id))
                    throw new Error(`VehicleAsset not found: ${asset.id}`);
                this.assets.set(asset.id, copy(asset));
            },
            updateVehicleModel: async (model) => {
                if (!this.models.has(model.id))
                    throw new Error(`VehicleModel not found: ${model.id}`);
                this.models.set(model.id, copy(model));
            },
            updateProduct: async (product) => {
                if (!this.products.has(product.id))
                    throw new Error(`Product not found: ${product.id}`);
                this.products.set(product.id, copy(product));
            },
            listProductsByVehicleModel: async (vehicleModelId) => copy([...this.products.values()].filter((p) => p.vehicleModelId === vehicleModelId)),
            getProduct: async (id) => copy(this.products.get(id) ?? null),
            putProduct: async (product) => { this.products.set(product.id, copy(product)); },
            getOffer: async (id) => copy(this.offers.get(id) ?? null),
            putOffer: async (offer) => { this.offers.set(offer.id, copy(offer)); },
            getSourceDefinition: async (sourceId) => copy(this.sourceDefinitions.get(sourceId) ?? null),
            putSourceDefinition: async (source) => {
                if (this.sourceDefinitions.has(source.sourceId)) {
                    throw new Error(`Source definition already exists: ${source.sourceId}`);
                }
                this.sourceDefinitions.set(source.sourceId, copy(source));
            },
            getSourceRun: async (runId) => copy(this.sourceRuns.get(runId) ?? null),
            putSourceRun: async (run) => {
                if (this.sourceRuns.has(run.runId))
                    throw new Error(`Source run already exists: ${run.runId}`);
                this.sourceRuns.set(run.runId, copy(run));
            },
            getSourceHead: async (sourceId) => copy(this.sourceHeads.get(sourceId) ?? null),
            putSourceHead: async (head) => {
                if (this.sourceHeads.has(head.sourceId)) {
                    throw new Error(`Source head already exists: ${head.sourceId}`);
                }
                this.sourceHeads.set(head.sourceId, copy(head));
            },
            getRawRecord: async (rawRecordId) => copy(this.rawRecords.get(rawRecordId) ?? null),
            putRawRecord: async (record) => {
                if (this.rawRecords.has(record.rawRecordId)) {
                    throw new Error(`Raw record already exists: ${record.rawRecordId}`);
                }
                this.rawRecords.set(record.rawRecordId, copy(record));
            },
            getCandidate: async (candidateId) => copy(this.candidates.get(candidateId) ?? null),
            putCandidate: async (record) => {
                if (this.candidates.has(record.candidateId)) {
                    throw new Error(`Candidate already exists: ${record.candidateId}`);
                }
                this.candidates.set(record.candidateId, copy(record));
            },
            listLineageForCandidate: async (candidateId) => copy([...this.lineage.values()].filter((item) => item.normalized?.candidateId === candidateId)),
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
            updateSourceBinding: async (binding) => {
                if (!this.sourceBindings.has(binding.bindingId)) {
                    throw new Error(`Source binding not found: ${binding.bindingId}`);
                }
                this.sourceBindings.set(binding.bindingId, copy(binding));
            },
            getCanonicalizationReceipt: async (key) => copy(this.canonicalizationReceipts.get(key) ?? null),
            putCanonicalizationReceipt: async (receipt) => {
                if (this.canonicalizationReceipts.has(receipt.idempotencyKey)) {
                    throw new Error(`Canonicalization receipt already exists: ${receipt.idempotencyKey}`);
                }
                this.canonicalizationReceipts.set(receipt.idempotencyKey, copy(receipt));
            },
            getCommandReceipt: async (key) => copy(this.receipts.get(key) ?? null),
            putCommandReceipt: async (receipt) => { this.receipts.set(receipt.idempotencyKey, copy(receipt)); },
            getManualCatalogEntryReceipt: async (key) => copy(this.manualCatalogEntryReceipts.get(key) ?? null),
            putManualCatalogEntryReceipt: async (receipt) => {
                if (this.manualCatalogEntryReceipts.has(receipt.idempotencyKey)) {
                    throw new Error(`Manual catalog entry receipt already exists: ${receipt.idempotencyKey}`);
                }
                this.manualCatalogEntryReceipts.set(receipt.idempotencyKey, copy(receipt));
            },
            getReviewedSourceChangeReceipt: async (key) => copy(this.reviewedSourceChangeReceipts.get(key) ?? null),
            putReviewedSourceChangeReceipt: async (receipt) => {
                if (this.reviewedSourceChangeReceipts.has(receipt.idempotencyKey)) {
                    throw new Error(`Reviewed source-change receipt already exists: ${receipt.idempotencyKey}`);
                }
                this.reviewedSourceChangeReceipts.set(receipt.idempotencyKey, copy(receipt));
            },
            getCatalogWriterOwnership: async () => copy(this.catalogWriterOwnership),
            putCatalogWriterOwnership: async (ownership) => {
                if (this.catalogWriterOwnership) {
                    throw new Error('Catalog writer ownership already exists');
                }
                this.catalogWriterOwnership = copy(ownership);
            },
            updateCatalogWriterOwnership: async (ownership) => {
                if (!this.catalogWriterOwnership) {
                    throw new Error('Catalog writer ownership not found');
                }
                this.catalogWriterOwnership = copy(ownership);
            },
            getWriterOwnershipTransferReceipt: async (key) => copy(this.writerOwnershipTransferReceipts.get(key) ?? null),
            putWriterOwnershipTransferReceipt: async (receipt) => {
                if (this.writerOwnershipTransferReceipts.has(receipt.idempotencyKey)) {
                    throw new Error(`Writer ownership transfer receipt already exists: ${receipt.idempotencyKey}`);
                }
                this.writerOwnershipTransferReceipts.set(receipt.idempotencyKey, copy(receipt));
            },
            appendAudit: async (event) => { this.audits.push(copy(event)); },
            appendRevision: async (record) => {
                if (this.revisionHistory.has(record.revisionRecordId)) {
                    throw new Error(`Revision record already exists: ${record.revisionRecordId}`);
                }
                this.revisionHistory.set(record.revisionRecordId, copy(record));
            },
            appendOutbox: async (event) => { this.outbox.set(event.eventId, copy(event)); }
        };
        try {
            return await fn(tx);
        }
        catch (error) {
            this.models = new Map(snapshot.models);
            this.assets = new Map(snapshot.assets);
            this.products = new Map(snapshot.products);
            this.offers = new Map(snapshot.offers);
            this.receipts = new Map(snapshot.receipts);
            this.canonicalizationReceipts = new Map(snapshot.canonicalizationReceipts);
            this.manualCatalogEntryReceipts = new Map(snapshot.manualCatalogEntryReceipts);
            this.reviewedSourceChangeReceipts = new Map(snapshot.reviewedSourceChangeReceipts);
            this.catalogWriterOwnership = copy(snapshot.catalogWriterOwnership);
            this.writerOwnershipTransferReceipts = new Map(snapshot.writerOwnershipTransferReceipts);
            this.sourceDefinitions = new Map(snapshot.sourceDefinitions);
            this.sourceRuns = new Map(snapshot.sourceRuns);
            this.sourceHeads = new Map(snapshot.sourceHeads);
            this.rawRecords = new Map(snapshot.rawRecords);
            this.candidates = new Map(snapshot.candidates);
            this.lineage = new Map(snapshot.lineage);
            this.sourceBindings = new Map(snapshot.sourceBindings);
            this.revisionHistory = new Map(snapshot.revisionHistory);
            this.audits.splice(0, this.audits.length, ...snapshot.audits);
            this.outbox.clear();
            for (const [key, value] of snapshot.outbox)
                this.outbox.set(key, value);
            throw error;
        }
    }
    async getVehicleModel(id) { return copy(this.models.get(id) ?? null); }
    async getVehicleAsset(id) { return copy(this.assets.get(id) ?? null); }
    async getProduct(id) { return copy(this.products.get(id) ?? null); }
    async getOffer(id) { return copy(this.offers.get(id) ?? null); }
    async getSourceDefinition(sourceId) { return copy(this.sourceDefinitions.get(sourceId) ?? null); }
    async getSourceRun(runId) { return copy(this.sourceRuns.get(runId) ?? null); }
    async getSourceHead(sourceId) { return copy(this.sourceHeads.get(sourceId) ?? null); }
    async getRawRecord(rawRecordId) { return copy(this.rawRecords.get(rawRecordId) ?? null); }
    async listRawRecordsByRun(runId) {
        return copy([...this.rawRecords.values()].filter((item) => item.runId === runId));
    }
    async getCandidate(candidateId) { return copy(this.candidates.get(candidateId) ?? null); }
    async listCandidatesByRun(runId) {
        return copy([...this.candidates.values()].filter((item) => item.runId === runId));
    }
    async getSourceBinding(bindingId) {
        return copy(this.sourceBindings.get(bindingId) ?? null);
    }
    async getCanonicalizationReceipt(idempotencyKey) {
        return copy(this.canonicalizationReceipts.get(idempotencyKey) ?? null);
    }
    async getManualCatalogEntryReceipt(idempotencyKey) {
        return copy(this.manualCatalogEntryReceipts.get(idempotencyKey) ?? null);
    }
    async getReviewedSourceChangeReceipt(idempotencyKey) {
        return copy(this.reviewedSourceChangeReceipts.get(idempotencyKey) ?? null);
    }
    async getCatalogWriterOwnership() {
        return copy(this.catalogWriterOwnership);
    }
    async getWriterOwnershipTransferReceipt(idempotencyKey) {
        return copy(this.writerOwnershipTransferReceipts.get(idempotencyKey) ?? null);
    }
    async listLineageByStage(stage) {
        return copy([...this.lineage.values()].filter((item) => item.stage === stage));
    }
    async listEntityHistory(entityType, entityId) {
        return copy([...this.revisionHistory.values()]
            .filter((item) => item.entityType === entityType && item.entityId === entityId)
            .sort((a, b) => a.revision - b.revision));
    }
    async listRevisionHistory() {
        return copy([...this.revisionHistory.values()]
            .sort((a, b) => a.entityType.localeCompare(b.entityType) ||
            a.entityId.localeCompare(b.entityId) ||
            a.revision - b.revision));
    }
    async listVehicleModels() { return copy([...this.models.values()]); }
    async listVehicleAssets() { return copy([...this.assets.values()]); }
    async listProducts() { return copy([...this.products.values()]); }
    async listOffers() { return copy([...this.offers.values()]); }
    async listPolicies() { return copy([...this.policies.values()]); }
    async stage(release) {
        this.releases.set(release.releaseId, copy(release));
    }
    async stageEvidence(input) {
        const release = this.releases.get(input.manifest.releaseId);
        if (!release || release.status !== 'BUILDING') {
            throw new Error('Projection evidence requires a BUILDING release');
        }
        if (this.manifests.has(input.manifest.releaseId)) {
            throw new Error('Projection release manifest already exists');
        }
        assertProjectionReleaseIntegrity(release, input.manifest, input.lineage);
        for (const item of input.lineage) {
            if (this.projectionLineage.has(item.lineageRecordId)) {
                throw new Error(`Projection lineage already exists: ${item.lineageRecordId}`);
            }
        }
        for (const item of input.lineage) {
            this.projectionLineage.set(item.lineageRecordId, copy(item));
        }
        this.manifests.set(input.manifest.releaseId, copy(input.manifest));
        release.status = 'VALIDATING';
    }
    async markReady(releaseId) {
        const release = this.releases.get(releaseId);
        if (!release)
            throw new Error('Release not found');
        if (release.status !== 'VALIDATING') {
            throw new Error('Only VALIDATING release can become READY');
        }
        const manifest = this.manifests.get(releaseId);
        if (!manifest)
            throw new Error('Release manifest not found');
        const evidence = [...this.projectionLineage.values()]
            .filter((item) => item.releaseId === releaseId);
        assertProjectionReleaseIntegrity(release, manifest, evidence);
        release.status = 'READY';
    }
    checkPublishGuard(guard) {
        if (!guard)
            return;
        const now = Date.parse(guard.now());
        if (!Number.isFinite(now))
            throw new Error('PROJECTION_SOURCE_TIME_INVALID');
        for (const witness of guard.sources) {
            if (stableDigest([this.sourceDefinitions.get(witness.sourceId) ?? null,
                this.sourceHeads.get(witness.sourceId) ?? null, this.sourceRuns.get(witness.runId) ?? null]) !== witness.digest)
                throw new Error('PROJECTION_SOURCE_CHANGED');
            if (now > witness.expiresAt)
                throw new Error('PROJECTION_SOURCE_STALE');
        }
        if (guard.claim) {
            this.requireOutboxLease(guard.claim.eventId, guard.claim.lease);
            if (now >= Date.parse(guard.claim.lease.leaseUntil))
                throw new Error('OUTBOX_LEASE_LOST');
        }
    }
    async activate(releaseId, guard) {
        const release = this.releases.get(releaseId);
        if (!release || release.status !== 'READY')
            throw new Error('Only READY release can activate');
        const manifest = this.manifests.get(releaseId);
        if (!manifest)
            throw new Error('Release manifest not found');
        const evidence = [...this.projectionLineage.values()]
            .filter((item) => item.releaseId === releaseId);
        assertProjectionReleaseIntegrity(release, manifest, evidence);
        this.checkPublishGuard(guard);
        if (guard?.receipt && this.deliveryReceipts.has(guard.receipt.eventId))
            throw new Error('Projection delivery receipt already exists');
        const previousId = this.active.get(release.projectionId);
        if (guard?.expectedActiveReleaseId !== undefined && (previousId ?? null) !== guard.expectedActiveReleaseId)
            throw new Error('PROJECTION_SOURCE_ACTIVE_CHANGED');
        if (previousId && previousId !== releaseId && (!guard?.claim || !guard.receipt))
            throw new Error('PROJECTION_ACTIVATION_APPROVAL_REQUIRED');
        const previous = previousId ? this.releases.get(previousId) : undefined;
        if (previous)
            previous.status = 'READY';
        release.status = 'ACTIVE';
        release.activatedAt = new Date().toISOString();
        this.active.set(release.projectionId, releaseId);
        if (guard?.receipt)
            this.deliveryReceipts.set(guard.receipt.eventId, copy(guard.receipt));
    }
    async getActive(projectionId) {
        const id = this.active.get(projectionId);
        return id
            ? copy(this.releases.get(id) ?? null)
            : null;
    }
    async getActiveEvidenceSnapshot(projectionId) {
        const releaseId = this.active.get(projectionId);
        if (!releaseId) {
            return {
                projectionId,
                release: null,
                manifest: null,
                lineage: [],
                consistency: 'ATOMIC'
            };
        }
        const release = this.releases.get(releaseId) ?? null;
        const manifest = this.manifests.get(releaseId) ?? null;
        const lineage = [...this.projectionLineage.values()]
            .filter((item) => item.releaseId === releaseId);
        return copy({
            projectionId,
            release,
            manifest,
            lineage,
            consistency: 'ATOMIC'
        });
    }
    async getManifest(releaseId) {
        return copy(this.manifests.get(releaseId) ?? null);
    }
    async listProjectionLineage(releaseId) {
        return copy([...this.projectionLineage.values()]
            .filter((item) => item.releaseId === releaseId));
    }
    async getDeliveryReceipt(eventId) {
        return copy(this.deliveryReceipts.get(eventId) ?? null);
    }
    async putDeliveryReceipt(receipt, guard) {
        this.checkPublishGuard(guard);
        if (guard && this.active.get(receipt.projectionId) !== receipt.releaseId)
            throw new Error('PROJECTION_SOURCE_ACTIVE_CHANGED');
        if (this.deliveryReceipts.has(receipt.eventId)) {
            throw new Error(`Projection delivery receipt already exists: ${receipt.eventId}`);
        }
        this.deliveryReceipts.set(receipt.eventId, copy(receipt));
    }
    async getSheetDeliveryEvidence(receiptId) {
        return copy(this.sheetDeliveryEvidence.get(receiptId) ?? null);
    }
    async putSheetDeliveryEvidence(evidence) {
        if (this.sheetDeliveryEvidence.has(evidence.receiptId)) {
            throw new Error(`Sheet delivery evidence already exists: ${evidence.receiptId}`);
        }
        this.sheetDeliveryEvidence.set(evidence.receiptId, copy(evidence));
    }
    async listSheetDeliveryEvidence(consumerId) {
        return copy([...this.sheetDeliveryEvidence.values()]
            .filter((item) => item.consumerId === consumerId));
    }
    async claimNext(input) {
        if (input.eventId !== undefined && !/^[A-Za-z0-9:_-]{1,200}$/.test(input.eventId))
            return null;
        if (input.expiresAt && (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.parse(input.now)))
            return null;
        if (!Number.isFinite(Date.parse(input.leaseUntil)) || Date.parse(input.leaseUntil) <= Date.parse(input.now))
            return null;
        const candidates = input.eventId ? [this.outbox.get(input.eventId)].filter((x) => Boolean(x)) : [...this.outbox.values()];
        const item = candidates
            .filter((x) => (!input.eventId || x.eventId === input.eventId) &&
            (x.status === 'PENDING' || (x.status === 'PROCESSING' && Boolean(x.leaseUntil) && x.leaseUntil <= input.now)) &&
            (!x.nextAttemptAt || x.nextAttemptAt <= input.now))
            .filter(x => !input.expectedEventDigest || stableDigest(x) === input.expectedEventDigest)
            .filter(x => {
            const receipt = this.deliveryReceipts.get(x.eventId);
            return !receipt || this.active.get(receipt.projectionId) === receipt.releaseId;
        })
            .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))[0];
        if (!item)
            return null;
        item.status = 'PROCESSING';
        item.leaseOwner = input.workerId;
        item.leaseUntil = input.leaseUntil;
        return copy(item);
    }
    requireOutboxLease(eventId, lease) {
        const item = this.outbox.get(eventId);
        if (!item)
            throw new Error('Outbox event not found');
        if (!lease || item.status !== 'PROCESSING' || item.leaseOwner !== lease.leaseOwner ||
            item.leaseUntil !== lease.leaseUntil)
            throw new Error('OUTBOX_LEASE_LOST');
        return item;
    }
    async markDone(eventId, lease) {
        const item = this.requireOutboxLease(eventId, lease);
        item.status = 'DONE';
        item.leaseOwner = null;
        item.leaseUntil = null;
    }
    async markRetry(input) {
        const item = this.requireOutboxLease(input.eventId, input.lease);
        item.status = 'PENDING';
        item.attempts = input.attempts;
        item.nextAttemptAt = input.nextAttemptAt;
        item.lastError = input.error;
        item.leaseOwner = null;
        item.leaseUntil = null;
    }
    async moveToDeadLetter(input) {
        const item = this.requireOutboxLease(input.eventId, input.lease);
        item.status = 'DEAD_LETTER';
        item.attempts = input.attempts;
        item.lastError = input.error;
        item.leaseOwner = null;
        item.leaseUntil = null;
    }
}
