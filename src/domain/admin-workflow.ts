export const ADMIN_WORKFLOW_RESOURCES = {
  products: true,
  policies: true,
  vehicleMaster: true,
  settlementRows: true,
  settlementEvents: true,
  settlementInvoices: true,
  settlementCashEvents: true,
  settlementClawbacks: true,
  settlementFeeRules: true,
  settlementRules: true,
  partners: true,
  contracts: true,
  contractEvents: true,
  esignSessions: true,
  esignPrivate: true,
  esignEvents: true,
  esignIssueLocks: true,
} as const;

export type AdminWorkflowResource = keyof typeof ADMIN_WORKFLOW_RESOURCES;

export type AdminWorkflowSemanticOwner =
  | 'FREEPASS_DATA_CATALOG'
  | 'FREEPASS_DATA_SETTLEMENT'
  | 'FREEPASS_DATA_REFERENCE'
  | 'FREEPASS_ADMIN_APPLICATION_CONTRACT';

export type AdminWorkflowResourcePolicy = {
  semanticOwner: AdminWorkflowSemanticOwner;
  writeThroughGateway: boolean;
};

export const ADMIN_WORKFLOW_RESOURCE_POLICIES: Record<AdminWorkflowResource, AdminWorkflowResourcePolicy> = {
  products: { semanticOwner: 'FREEPASS_DATA_CATALOG', writeThroughGateway: false },
  policies: { semanticOwner: 'FREEPASS_DATA_CATALOG', writeThroughGateway: false },
  vehicleMaster: { semanticOwner: 'FREEPASS_DATA_CATALOG', writeThroughGateway: false },
  partners: { semanticOwner: 'FREEPASS_DATA_REFERENCE', writeThroughGateway: false },
  settlementRows: { semanticOwner: 'FREEPASS_DATA_SETTLEMENT', writeThroughGateway: true },
  settlementEvents: { semanticOwner: 'FREEPASS_DATA_SETTLEMENT', writeThroughGateway: true },
  settlementInvoices: { semanticOwner: 'FREEPASS_DATA_SETTLEMENT', writeThroughGateway: true },
  settlementCashEvents: { semanticOwner: 'FREEPASS_DATA_SETTLEMENT', writeThroughGateway: true },
  settlementClawbacks: { semanticOwner: 'FREEPASS_DATA_SETTLEMENT', writeThroughGateway: true },
  settlementFeeRules: { semanticOwner: 'FREEPASS_DATA_SETTLEMENT', writeThroughGateway: true },
  settlementRules: { semanticOwner: 'FREEPASS_DATA_SETTLEMENT', writeThroughGateway: true },
  contracts: { semanticOwner: 'FREEPASS_ADMIN_APPLICATION_CONTRACT', writeThroughGateway: true },
  contractEvents: { semanticOwner: 'FREEPASS_ADMIN_APPLICATION_CONTRACT', writeThroughGateway: true },
  esignSessions: { semanticOwner: 'FREEPASS_ADMIN_APPLICATION_CONTRACT', writeThroughGateway: true },
  esignPrivate: { semanticOwner: 'FREEPASS_ADMIN_APPLICATION_CONTRACT', writeThroughGateway: true },
  esignEvents: { semanticOwner: 'FREEPASS_ADMIN_APPLICATION_CONTRACT', writeThroughGateway: true },
  esignIssueLocks: { semanticOwner: 'FREEPASS_ADMIN_APPLICATION_CONTRACT', writeThroughGateway: true },
};

export type AdminWorkflowFilter = {
  field: string;
  op: '==';
  value: unknown;
};

export type AdminWorkflowReadSpec =
  | { kind: 'doc'; resource: AdminWorkflowResource; id: string }
  | {
      kind: 'query';
      resource: AdminWorkflowResource;
      filters?: AdminWorkflowFilter[];
      limit?: number;
    };

export type AdminWorkflowDocument = {
  id: string;
  data: Record<string, unknown>;
};

export type AdminWorkflowReadResult = {
  schema: 'freepass-data.admin-workflow-read/v1';
  docs: AdminWorkflowDocument[];
  digest: string;
};

export type AdminWorkflowExpectation = {
  spec: AdminWorkflowReadSpec;
  digest: string;
};

export type AdminWorkflowMutation =
  | {
      op: 'set';
      resource: AdminWorkflowResource;
      id: string;
      data: Record<string, unknown>;
      merge?: boolean;
    }
  | {
      op: 'update';
      resource: AdminWorkflowResource;
      id: string;
      data: Record<string, unknown>;
    }
  | {
      op: 'create';
      resource: AdminWorkflowResource;
      id: string;
      data: Record<string, unknown>;
    };

export type AdminWorkflowCommitRequest = {
  operationId: string;
  actor: string;
  purpose: string;
  expectations: AdminWorkflowExpectation[];
  mutations: AdminWorkflowMutation[];
};

export type AdminWorkflowCommitReceiptV1 = {
  schema: 'freepass-data.admin-workflow-receipt/v1';
  authority: 'FREEPASS_DATA';
  consumerId: string;
  operationId: string;
  requestDigest: string;
  mutationCount: number;
  committedAt: string;
  receiptDigest: string;
  idempotent: boolean;
};

export type AdminWorkflowCommitReceiptV2 = Omit<AdminWorkflowCommitReceiptV1, 'schema' | 'authority'> & {
  schema: 'freepass-data.admin-workflow-receipt/v2';
  authority: 'FREEPASS_DATA_ACCESS_GATEWAY';
  authorityRole: 'EXECUTION_GATEWAY';
  semanticOwners: AdminWorkflowSemanticOwner[];
};

export type AdminWorkflowCommitReceipt = AdminWorkflowCommitReceiptV1 | AdminWorkflowCommitReceiptV2;

export function adminWorkflowSemanticOwners(request: AdminWorkflowCommitRequest) {
  return [...new Set(request.mutations.map((mutation) =>
    ADMIN_WORKFLOW_RESOURCE_POLICIES[mutation.resource].semanticOwner
  ))].sort() as AdminWorkflowSemanticOwner[];
}

const id = (value: unknown, max = 256) =>
  typeof value === 'string'
  && value.length > 0
  && value.length <= max
  && !/[\u0000-\u001f\u007f]/.test(value);

const field = (value: unknown) =>
  typeof value === 'string'
  && /^[A-Za-z_][A-Za-z0-9_.]{0,127}$/.test(value);

export function assertAdminWorkflowReadSpec(value: unknown): asserts value is AdminWorkflowReadSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ADMIN_WORKFLOW_READ');
  const v = value as Record<string, unknown>;
  if (typeof v.resource !== 'string' || !(v.resource in ADMIN_WORKFLOW_RESOURCES)) throw new Error('INVALID_ADMIN_WORKFLOW_RESOURCE');
  if (v.kind === 'doc') {
    if (!id(v.id)) throw new Error('INVALID_ADMIN_WORKFLOW_DOCUMENT_ID');
    return;
  }
  if (v.kind !== 'query') throw new Error('INVALID_ADMIN_WORKFLOW_READ');
  if (v.limit !== undefined && (!Number.isSafeInteger(v.limit) || Number(v.limit) < 1 || Number(v.limit) > 5000)) {
    throw new Error('INVALID_ADMIN_WORKFLOW_LIMIT');
  }
  if (v.filters !== undefined) {
    if (!Array.isArray(v.filters) || v.filters.length > 8) throw new Error('INVALID_ADMIN_WORKFLOW_FILTER');
    for (const raw of v.filters) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_ADMIN_WORKFLOW_FILTER');
      const f = raw as Record<string, unknown>;
      if (!field(f.field) || f.op !== '==') throw new Error('INVALID_ADMIN_WORKFLOW_FILTER');
    }
  }
}

export function assertAdminWorkflowCommitRequest(value: unknown): asserts value is AdminWorkflowCommitRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ADMIN_WORKFLOW_COMMIT');
  const v = value as Record<string, unknown>;
  if (!id(v.operationId, 200) || !id(v.actor, 256) || !id(v.purpose, 256)) {
    throw new Error('INVALID_ADMIN_WORKFLOW_COMMIT');
  }
  if (!Array.isArray(v.expectations) || v.expectations.length > 64) throw new Error('INVALID_ADMIN_WORKFLOW_EXPECTATIONS');
  for (const raw of v.expectations) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_ADMIN_WORKFLOW_EXPECTATIONS');
    const e = raw as Record<string, unknown>;
    assertAdminWorkflowReadSpec(e.spec);
    if (typeof e.digest !== 'string' || !/^[a-f0-9]{64}$/.test(e.digest)) {
      throw new Error('INVALID_ADMIN_WORKFLOW_EXPECTATION_DIGEST');
    }
  }
  if (!Array.isArray(v.mutations) || v.mutations.length < 1 || v.mutations.length > 128) {
    throw new Error('INVALID_ADMIN_WORKFLOW_MUTATIONS');
  }
  for (const raw of v.mutations) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_ADMIN_WORKFLOW_MUTATION');
    const m = raw as Record<string, unknown>;
    if (!['set', 'update', 'create'].includes(String(m.op))) throw new Error('INVALID_ADMIN_WORKFLOW_MUTATION');
    if (typeof m.resource !== 'string' || !(m.resource in ADMIN_WORKFLOW_RESOURCES) || !id(m.id)) {
      throw new Error('INVALID_ADMIN_WORKFLOW_MUTATION');
    }
    if (!m.data || typeof m.data !== 'object' || Array.isArray(m.data)) throw new Error('INVALID_ADMIN_WORKFLOW_MUTATION');
    if (m.merge !== undefined && typeof m.merge !== 'boolean') throw new Error('INVALID_ADMIN_WORKFLOW_MUTATION');
    const policy = ADMIN_WORKFLOW_RESOURCE_POLICIES[m.resource as AdminWorkflowResource];
    if (!policy.writeThroughGateway) throw new Error('ADMIN_WORKFLOW_RESOURCE_READ_ONLY');
  }
}
