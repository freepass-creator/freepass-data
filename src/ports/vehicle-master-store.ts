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

export interface VehicleMasterStore {
  getNode(id: string): Promise<VehicleMasterNode | null>;
  listNodesByType(nodeType: VehicleMasterNode['nodeType']): Promise<VehicleMasterNode[]>;
  listNodeRevisions(): Promise<VehicleMasterNode[]>;
  putNode(record: VehicleMasterNode): Promise<VehicleMasterWriteResult>;

  getCompatibilityRule(id: string): Promise<VehicleMasterCompatibilityRule | null>;
  listCompatibilityRules(): Promise<VehicleMasterCompatibilityRule[]>;
  listCompatibilityRuleRevisions(): Promise<VehicleMasterCompatibilityRule[]>;
  putCompatibilityRule(record: VehicleMasterCompatibilityRule): Promise<VehicleMasterWriteResult>;

  getPriceRevision(id: string): Promise<VehicleMasterPriceRevision | null>;
  listPriceRevisions(): Promise<VehicleMasterPriceRevision[]>;
  listPriceRevisionsByTarget(targetId: string): Promise<VehicleMasterPriceRevision[]>;
  putPriceRevision(record: VehicleMasterPriceRevision): Promise<VehicleMasterWriteResult>;

  getSourceDocument(id: string): Promise<VehicleMasterSourceDocument | null>;
  listSourceDocuments(): Promise<VehicleMasterSourceDocument[]>;
  putSourceDocument(record: VehicleMasterSourceDocument): Promise<VehicleMasterWriteResult>;

  getHash(hashId: string): Promise<VehicleMasterHashRecord | null>;
  putHash(record: VehicleMasterHashRecord): Promise<VehicleMasterWriteResult>;

  getPipelineRecord(
    kind: VehicleMasterPipelineRecord['kind'],
    recordId: string
  ): Promise<VehicleMasterPipelineRecord | null>;
  listPipelineRecords(
    kind: VehicleMasterPipelineRecord['kind'],
    sourceDocumentId: string
  ): Promise<VehicleMasterPipelineRecord[]>;
  listPipelineRecordsByKind(
    kind: VehicleMasterPipelineRecord['kind']
  ): Promise<VehicleMasterPipelineRecord[]>;
  putPipelineRecord(record: VehicleMasterPipelineRecord): Promise<VehicleMasterWriteResult>;

  getResolverFeedback(feedbackId: string): Promise<VehicleMasterResolverFeedback | null>;
  putResolverFeedback(record: VehicleMasterResolverFeedback): Promise<VehicleMasterWriteResult>;
}
