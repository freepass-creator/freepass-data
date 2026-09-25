import type {
  VehicleMasterCompatibilityRule,
  VehicleMasterHashRecord,
  VehicleMasterNode,
  VehicleMasterPipelineRecord,
  VehicleMasterPriceRevision,
  VehicleMasterResolverFeedback,
  VehicleMasterSourceDocument,
  VehicleMasterWriteResult,
} from '../domain/vehicle-master.js';
import type { VehicleMasterStore } from '../ports/vehicle-master-store.js';

const copy = <T>(value: T): T => structuredClone(value);

type VersionedRecord = {
  id: string;
  revision: number;
  contentHash: string;
};

export class MemoryVehicleMasterStore implements VehicleMasterStore {
  private readonly nodes = new Map<string, VehicleMasterNode>();
  private readonly rules = new Map<string, VehicleMasterCompatibilityRule>();
  private readonly prices = new Map<string, VehicleMasterPriceRevision>();
  private readonly sourceDocuments = new Map<string, VehicleMasterSourceDocument>();
  private readonly hashes = new Map<string, VehicleMasterHashRecord>();
  private readonly pipeline = new Map<string, VehicleMasterPipelineRecord>();
  private readonly resolverFeedback = new Map<string, VehicleMasterResolverFeedback>();

  private putVersioned<T extends VersionedRecord>(
    map: Map<string, T>,
    record: T
  ): VehicleMasterWriteResult {
    const current = map.get(record.id);
    if (!current) {
      if (record.revision !== 1) {
        throw new Error('VEHICLE_MASTER_FIRST_REVISION_MUST_BE_ONE');
      }
      map.set(record.id, copy(record));
      return 'CREATED';
    }
    if (current.contentHash === record.contentHash) return 'UNCHANGED';
    if (record.revision !== current.revision + 1) {
      throw new Error(
        `VEHICLE_MASTER_REVISION_CONFLICT:${record.id}:${current.revision}->${record.revision}`
      );
    }
    map.set(record.id, copy(record));
    return 'UPDATED';
  }

  private putImmutable<T extends { contentHash: string }>(
    map: Map<string, T>,
    id: string,
    record: T
  ): VehicleMasterWriteResult {
    const current = map.get(id);
    if (!current) {
      map.set(id, copy(record));
      return 'CREATED';
    }
    if (current.contentHash === record.contentHash) return 'UNCHANGED';
    throw new Error(`VEHICLE_MASTER_DETERMINISTIC_ID_COLLISION:${id}`);
  }

  async getNode(id: string) {
    return copy(this.nodes.get(id) ?? null);
  }

  async listNodesByType(nodeType: VehicleMasterNode['nodeType']) {
    return copy([...this.nodes.values()].filter((item) => item.nodeType === nodeType));
  }

  async putNode(record: VehicleMasterNode) {
    return this.putVersioned(this.nodes, record);
  }

  async getCompatibilityRule(id: string) {
    return copy(this.rules.get(id) ?? null);
  }

  async putCompatibilityRule(record: VehicleMasterCompatibilityRule) {
    return this.putVersioned(this.rules, record);
  }

  async getPriceRevision(id: string) {
    return copy(this.prices.get(id) ?? null);
  }

  async listPriceRevisionsByTarget(targetId: string) {
    return copy([...this.prices.values()]
      .filter((item) => item.targetId === targetId)
      .sort((a, b) => a.revision - b.revision || a.id.localeCompare(b.id)));
  }

  async putPriceRevision(record: VehicleMasterPriceRevision) {
    return this.putImmutable(this.prices, record.id, record);
  }

  async getSourceDocument(id: string) {
    return copy(this.sourceDocuments.get(id) ?? null);
  }

  async listSourceDocuments() {
    return copy([...this.sourceDocuments.values()]
      .sort((a, b) => a.sourceDocumentId.localeCompare(b.sourceDocumentId)));
  }

  async putSourceDocument(record: VehicleMasterSourceDocument) {
    return this.putImmutable(
      this.sourceDocuments,
      record.sourceDocumentId,
      record
    );
  }

  async getHash(hashId: string) {
    return copy(this.hashes.get(hashId) ?? null);
  }

  async putHash(record: VehicleMasterHashRecord) {
    return this.putImmutable(this.hashes, record.hashId, record);
  }

  async getPipelineRecord(
    kind: VehicleMasterPipelineRecord['kind'],
    recordId: string
  ) {
    return copy(this.pipeline.get(`${kind}:${recordId}`) ?? null);
  }

  async listPipelineRecords(
    kind: VehicleMasterPipelineRecord['kind'],
    sourceDocumentId: string
  ) {
    return copy([...this.pipeline.values()]
      .filter((item) =>
        item.kind === kind &&
        item.sourceDocumentId === sourceDocumentId
      )
      .sort((a, b) => a.recordId.localeCompare(b.recordId)));
  }

  async listPipelineRecordsByKind(
    kind: VehicleMasterPipelineRecord['kind']
  ) {
    return copy([...this.pipeline.values()]
      .filter((item) => item.kind === kind)
      .sort((a, b) => a.recordId.localeCompare(b.recordId)));
  }

  async putPipelineRecord(record: VehicleMasterPipelineRecord) {
    return this.putImmutable(
      this.pipeline,
      `${record.kind}:${record.recordId}`,
      record
    );
  }

  async getResolverFeedback(feedbackId: string) {
    return copy(this.resolverFeedback.get(feedbackId) ?? null);
  }

  async putResolverFeedback(record: VehicleMasterResolverFeedback) {
    return this.putImmutable(this.resolverFeedback, record.feedbackId, record);
  }
}
