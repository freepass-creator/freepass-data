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
import type { ReviewedSourceChangeReceipt } from '../domain/source-change.js';
import type {
  CatalogWriterOwnership,
  WriterOwnershipTransferReceipt
} from '../domain/writer-ownership.js';
import type {
  ProjectionDeliveryReceipt,
  ProjectionFieldLineageRecord,
  ProjectionReleaseManifest
} from '../domain/projection-evidence.js';
import { stableRecordSetDigest } from '../shared/stable-digest.js';

const copy = <T>(value: T): T => structuredClone(value);

export class MemoryDataStore implements CatalogStore, ProjectionStore, OutboxStore {
  private models = new Map<string, VehicleModel>();
  private assets = new Map<string, VehicleAsset>();
  private products = new Map<string, Product>();
  private offers = new Map<string, Offer>();
  private policies = new Map<string, Policy>();
  private receipts = new Map<string, CommandReceipt>();
  private canonicalizationReceipts = new Map<string, CanonicalizationReceipt>();
  private manualCatalogEntryReceipts = new Map<string, ManualCatalogEntryReceipt>();
  private reviewedSourceChangeReceipts = new Map<string, ReviewedSourceChangeReceipt>();
  private catalogWriterOwnership: CatalogWriterOwnership | null = null;
  private writerOwnershipTransferReceipts = new Map<string, WriterOwnershipTransferReceipt>();
  private sourceDefinitions = new Map<string, SourceDefinition>();
  private sourceRuns = new Map<string, SourceRun>();
  private sourceHeads = new Map<string, SourceHead>();
  private rawRecords = new Map<string, RawRecord>();
  private candidates = new Map<string, NormalizedCandidateRecord>();
  private lineage = new Map<string, FieldLineageRecord>();
  private sourceBindings = new Map<string, CanonicalSourceBinding>();
  private revisionHistory = new Map<string, EntityRevisionRecord>();
  readonly audits: AuditEvent[] = [];
  readonly outbox = new Map<string, OutboxEvent>();
  private releases = new Map<string, ProjectionRelease<ErpPublicProduct>>();
  private manifests = new Map<string, ProjectionReleaseManifest>();
  private projectionLineage = new Map<string, ProjectionFieldLineageRecord>();
  private deliveryReceipts = new Map<string, ProjectionDeliveryReceipt>();
  private active = new Map<string, string>();

  async seed(input: {
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
  }) {
    for (const x of input.vehicleModels ?? []) this.models.set(x.id, copy(x));
    for (const x of input.vehicleAssets ?? []) this.assets.set(x.id, copy(x));
    for (const x of input.products ?? []) this.products.set(x.id, copy(x));
    for (const x of input.offers ?? []) this.offers.set(x.id, copy(x));
    for (const x of input.policies ?? []) this.policies.set(x.id, copy(x));
    for (const x of input.sourceDefinitions ?? []) this.sourceDefinitions.set(x.sourceId, copy(x));
    for (const x of input.sourceRuns ?? []) this.sourceRuns.set(x.runId, copy(x));
    for (const x of input.sourceHeads ?? []) this.sourceHeads.set(x.sourceId, copy(x));
    for (const x of input.rawRecords ?? []) this.rawRecords.set(x.rawRecordId, copy(x));
    for (const x of input.candidates ?? []) this.candidates.set(x.candidateId, copy(x));
    for (const x of input.lineage ?? []) this.lineage.set(x.lineageRecordId, copy(x));
    for (const x of input.sourceBindings ?? []) this.sourceBindings.set(x.bindingId, copy(x));
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

  async transact<T>(fn: (tx: CatalogTransaction) => Promise<T>): Promise<T> {
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
    const tx: CatalogTransaction = {
      getVehicleModel: async (id) => copy(this.models.get(id) ?? null),
      putVehicleModel: async (model) => { this.models.set(model.id, copy(model)); },
      getVehicleAsset: async (id) => copy(this.assets.get(id) ?? null),
      putVehicleAsset: async (asset) => {
        if (this.assets.has(asset.id)) throw new Error(`VehicleAsset already exists: ${asset.id}`);
        this.assets.set(asset.id, copy(asset));
      },
      updateVehicleAsset: async (asset) => {
        if (!this.assets.has(asset.id)) throw new Error(`VehicleAsset not found: ${asset.id}`);
        this.assets.set(asset.id, copy(asset));
      },
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
        if (this.sourceRuns.has(run.runId)) throw new Error(`Source run already exists: ${run.runId}`);
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
      updateSourceBinding: async (binding) => {
        if (!this.sourceBindings.has(binding.bindingId)) {
          throw new Error(`Source binding not found: ${binding.bindingId}`);
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
      getManualCatalogEntryReceipt: async (key) =>
        copy(this.manualCatalogEntryReceipts.get(key) ?? null),
      putManualCatalogEntryReceipt: async (receipt) => {
        if (this.manualCatalogEntryReceipts.has(receipt.idempotencyKey)) {
          throw new Error(`Manual catalog entry receipt already exists: ${receipt.idempotencyKey}`);
        }
        this.manualCatalogEntryReceipts.set(receipt.idempotencyKey, copy(receipt));
      },
      getReviewedSourceChangeReceipt: async (key) =>
        copy(this.reviewedSourceChangeReceipts.get(key) ?? null),
      putReviewedSourceChangeReceipt: async (receipt) => {
        if (this.reviewedSourceChangeReceipts.has(receipt.idempotencyKey)) {
          throw new Error(
            `Reviewed source-change receipt already exists: ${receipt.idempotencyKey}`
          );
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
      getWriterOwnershipTransferReceipt: async (key) =>
        copy(this.writerOwnershipTransferReceipts.get(key) ?? null),
      putWriterOwnershipTransferReceipt: async (receipt) => {
        if (this.writerOwnershipTransferReceipts.has(receipt.idempotencyKey)) {
          throw new Error(
            `Writer ownership transfer receipt already exists: ${receipt.idempotencyKey}`
          );
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
    try { return await fn(tx); }
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
      for (const [key, value] of snapshot.outbox) this.outbox.set(key, value);
      throw error;
    }
  }

  async getVehicleModel(id: string) { return copy(this.models.get(id) ?? null); }
  async getVehicleAsset(id: string) { return copy(this.assets.get(id) ?? null); }
  async getProduct(id: string) { return copy(this.products.get(id) ?? null); }
  async getOffer(id: string) { return copy(this.offers.get(id) ?? null); }
  async getSourceDefinition(sourceId: string) { return copy(this.sourceDefinitions.get(sourceId) ?? null); }
  async getSourceRun(runId: string) { return copy(this.sourceRuns.get(runId) ?? null); }
  async getSourceHead(sourceId: string) { return copy(this.sourceHeads.get(sourceId) ?? null); }
  async getRawRecord(rawRecordId: string) { return copy(this.rawRecords.get(rawRecordId) ?? null); }
  async getCandidate(candidateId: string) { return copy(this.candidates.get(candidateId) ?? null); }
  async getSourceBinding(bindingId: string) {
    return copy(this.sourceBindings.get(bindingId) ?? null);
  }
  async getCanonicalizationReceipt(idempotencyKey: string) {
    return copy(this.canonicalizationReceipts.get(idempotencyKey) ?? null);
  }
  async getManualCatalogEntryReceipt(idempotencyKey: string) {
    return copy(this.manualCatalogEntryReceipts.get(idempotencyKey) ?? null);
  }
  async getReviewedSourceChangeReceipt(idempotencyKey: string) {
    return copy(this.reviewedSourceChangeReceipts.get(idempotencyKey) ?? null);
  }
  async getCatalogWriterOwnership() {
    return copy(this.catalogWriterOwnership);
  }
  async getWriterOwnershipTransferReceipt(idempotencyKey: string) {
    return copy(this.writerOwnershipTransferReceipts.get(idempotencyKey) ?? null);
  }
  async listLineageByStage(stage: SourceLineageStage) {
    return copy([...this.lineage.values()].filter((item) => item.stage === stage));
  }
  async listEntityHistory(entityType: CatalogEntityType, entityId: string) {
    return copy(
      [...this.revisionHistory.values()]
        .filter((item) => item.entityType === entityType && item.entityId === entityId)
        .sort((a, b) => a.revision - b.revision)
    );
  }
  async listRevisionHistory() {
    return copy(
      [...this.revisionHistory.values()]
        .sort((a, b) =>
          a.entityType.localeCompare(b.entityType) ||
          a.entityId.localeCompare(b.entityId) ||
          a.revision - b.revision
        )
    );
  }
  async listVehicleModels() { return copy([...this.models.values()]); }
  async listVehicleAssets() { return copy([...this.assets.values()]); }
  async listProducts() { return copy([...this.products.values()]); }
  async listOffers() { return copy([...this.offers.values()]); }
  async listPolicies() { return copy([...this.policies.values()]); }

  async stage(release: ProjectionRelease<ErpPublicProduct>) {
    this.releases.set(release.releaseId, copy(release));
  }
  async stageEvidence(input: {
    manifest: ProjectionReleaseManifest;
    lineage: ProjectionFieldLineageRecord[];
  }) {
    const release = this.releases.get(input.manifest.releaseId);
    if (!release || release.status !== 'BUILDING') {
      throw new Error('Projection evidence requires a BUILDING release');
    }
    if (this.manifests.has(input.manifest.releaseId)) {
      throw new Error('Projection release manifest already exists');
    }
    if (!input.manifest.fieldEvidenceDigest) {
      throw new Error('Projection release manifest requires fieldEvidenceDigest');
    }
    if (input.manifest.fieldEvidenceDigest !== stableRecordSetDigest(input.lineage)) {
      throw new Error('Projection field evidence digest mismatch');
    }
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
  async markReady(releaseId: string) {
    const release = this.releases.get(releaseId);
    if (!release) throw new Error('Release not found');
    if (release.status !== 'VALIDATING') {
      throw new Error('Only VALIDATING release can become READY');
    }
    const manifest = this.manifests.get(releaseId);
    if (!manifest) throw new Error('Release manifest not found');
    const evidence = [...this.projectionLineage.values()]
      .filter((item) => item.releaseId === releaseId);
    if (evidence.length !== manifest.fieldEvidenceCount) {
      throw new Error('Projection field evidence count mismatch');
    }
    if (!manifest.fieldEvidenceDigest) {
      throw new Error('Projection release manifest requires fieldEvidenceDigest');
    }
    if (stableRecordSetDigest(evidence) !== manifest.fieldEvidenceDigest) {
      throw new Error('Projection field evidence digest mismatch');
    }
    release.status = 'READY';
  }
  async activate(releaseId: string) {
    const release = this.releases.get(releaseId);
    if (!release || release.status !== 'READY') throw new Error('Only READY release can activate');
    const manifest = this.manifests.get(releaseId);
    if (!manifest) throw new Error('Release manifest not found');
    const evidence = [...this.projectionLineage.values()]
      .filter((item) => item.releaseId === releaseId);
    if (evidence.length !== manifest.fieldEvidenceCount) {
      throw new Error('Projection field evidence count mismatch');
    }
    if (!manifest.fieldEvidenceDigest) {
      throw new Error('Projection release manifest requires fieldEvidenceDigest');
    }
    if (stableRecordSetDigest(evidence) !== manifest.fieldEvidenceDigest) {
      throw new Error('Projection field evidence digest mismatch');
    }
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
  async getManifest(releaseId: string) {
    return copy(this.manifests.get(releaseId) ?? null);
  }
  async listProjectionLineage(releaseId: string) {
    return copy(
      [...this.projectionLineage.values()]
        .filter((item) => item.releaseId === releaseId)
    );
  }
  async getDeliveryReceipt(eventId: string) {
    return copy(this.deliveryReceipts.get(eventId) ?? null);
  }
  async putDeliveryReceipt(receipt: ProjectionDeliveryReceipt) {
    if (this.deliveryReceipts.has(receipt.eventId)) {
      throw new Error(`Projection delivery receipt already exists: ${receipt.eventId}`);
    }
    this.deliveryReceipts.set(receipt.eventId, copy(receipt));
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
