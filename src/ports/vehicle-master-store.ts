import type {
  VehicleMasterCompatibilityRule,
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
  putNode(record: VehicleMasterNode): Promise<VehicleMasterWriteResult>;

  getCompatibilityRule(id: string): Promise<VehicleMasterCompatibilityRule | null>;
  putCompatibilityRule(record: VehicleMasterCompatibilityRule): Promise<VehicleMasterWriteResult>;

  getPriceRevision(id: string): Promise<VehicleMasterPriceRevision | null>;
  putPriceRevision(record: VehicleMasterPriceRevision): Promise<VehicleMasterWriteResult>;

  getSourceDocument(id: string): Promise<VehicleMasterSourceDocument | null>;
  putSourceDocument(record: VehicleMasterSourceDocument): Promise<VehicleMasterWriteResult>;

  getPipelineRecord(
    kind: VehicleMasterPipelineRecord['kind'],
    recordId: string
  ): Promise<VehicleMasterPipelineRecord | null>;
  putPipelineRecord(record: VehicleMasterPipelineRecord): Promise<VehicleMasterWriteResult>;

  getResolverFeedback(feedbackId: string): Promise<VehicleMasterResolverFeedback | null>;
  putResolverFeedback(record: VehicleMasterResolverFeedback): Promise<VehicleMasterWriteResult>;
}
