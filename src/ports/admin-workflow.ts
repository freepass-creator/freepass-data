import type {
  AdminWorkflowCommitReceipt,
  AdminWorkflowCommitRequest,
  AdminWorkflowReadResult,
  AdminWorkflowReadSpec,
} from '../domain/admin-workflow.js';

export type AdminWorkflowStore = {
  read(spec: AdminWorkflowReadSpec): Promise<AdminWorkflowReadResult>;
  commit(consumerId: string, request: AdminWorkflowCommitRequest): Promise<AdminWorkflowCommitReceipt>;
};
