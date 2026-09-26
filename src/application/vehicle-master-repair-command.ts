import type { ActorRef } from '../domain/catalog.js';
import {
  VEHICLE_MASTER_REPAIR_WRITER_POLICY,
  deterministicVehicleMasterRecordId,
  sealVehicleMasterRepairReceipt,
  type VehicleMasterCompatibilityRule,
  type VehicleMasterNode,
  type VehicleMasterRepairReceipt,
} from '../domain/vehicle-master.js';
import {
  resolveExecutionWriter,
  type ExecutionWriterRef,
} from '../domain/writer-ownership.js';
import type { VehicleMasterStore } from '../ports/vehicle-master-store.js';
import { stableDigest } from '../shared/stable-digest.js';
import {
  auditVehicleMasterGraph,
  readVehicleMasterGraphSnapshot,
  type VehicleMasterGraphAuditReport,
} from './vehicle-master-graph-audit.js';
import {
  buildVehicleMasterRepairDryRun,
  materializeVehicleMasterRepairCandidate,
  type VehicleMasterRepairDryRun,
} from './vehicle-master-repair-dry-run.js';
import {
  buildVehicleMasterRepairPlan,
} from './vehicle-master-repair-plan.js';

export type ApplyVehicleMasterRepairCommandInput = {
  commandId: string;
  idempotencyKey: string;
  entityKind: 'NODE' | 'RULE';
  entityId: string;
  sourceAuditDigest: string;
  repairPlanDigest: string;
  dryRunDigest: string;
  dryRunObservedAt: string;
  expectedCurrentRevision: number;
  expectedBeforeContentHash: string;
  expectedAfterContentHash: string;
  committedAt: string;
  actor: ActorRef;
  writer?: ExecutionWriterRef;
  reason: string;
  approvalId: string;
};

export type ApplyVehicleMasterRepairCommandResult = {
  status: 'COMMITTED' | 'IDEMPOTENT_REPLAY';
  receipt: VehicleMasterRepairReceipt;
  postAudit: VehicleMasterGraphAuditReport | null;
};

export class VehicleMasterRepairCommandRejectedError extends Error {
  readonly code = 'VEHICLE_MASTER_REPAIR_COMMAND_REJECTED';

  constructor(readonly reason: string) {
    super(reason);
  }
}

const clean = (value: string, field: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new VehicleMasterRepairCommandRejectedError(
      `REQUIRED_FIELD_MISSING:${field}`
    );
  }
  return trimmed;
};

const commandRequest = (input: ApplyVehicleMasterRepairCommandInput) => ({
  commandId: clean(input.commandId, 'commandId'),
  idempotencyKey: clean(input.idempotencyKey, 'idempotencyKey'),
  entityKind: input.entityKind,
  entityId: clean(input.entityId, 'entityId'),
  sourceAuditDigest: clean(input.sourceAuditDigest, 'sourceAuditDigest'),
  repairPlanDigest: clean(input.repairPlanDigest, 'repairPlanDigest'),
  dryRunDigest: clean(input.dryRunDigest, 'dryRunDigest'),
  dryRunObservedAt: clean(input.dryRunObservedAt, 'dryRunObservedAt'),
  expectedCurrentRevision: input.expectedCurrentRevision,
  expectedBeforeContentHash: clean(
    input.expectedBeforeContentHash,
    'expectedBeforeContentHash'
  ),
  expectedAfterContentHash: clean(
    input.expectedAfterContentHash,
    'expectedAfterContentHash'
  ),
  committedAt: clean(input.committedAt, 'committedAt'),
  actor: structuredClone(input.actor),
  writer: input.writer ? structuredClone(input.writer) : undefined,
  reason: clean(input.reason, 'reason'),
  approvalId: clean(input.approvalId, 'approvalId'),
});

function resolveAuthorizedWriter(
  actor: ActorRef,
  writer?: ExecutionWriterRef
) {
  const resolved = resolveExecutionWriter(actor, writer);
  if (
    resolved.id !== VEHICLE_MASTER_REPAIR_WRITER_POLICY.primaryWriterId ||
    resolved.kind !== 'SERVICE'
  ) {
    throw new VehicleMasterRepairCommandRejectedError(
      'REPAIR_WRITER_NOT_OWNER'
    );
  }
  if (
    actor.kind === 'SERVICE' &&
    actor.id !== VEHICLE_MASTER_REPAIR_WRITER_POLICY.primaryWriterId
  ) {
    throw new VehicleMasterRepairCommandRejectedError(
      'REPAIR_ACTOR_NOT_AUTHORIZED'
    );
  }
  return resolved;
}

function validateInput(input: ReturnType<typeof commandRequest>) {
  if (
    !Number.isSafeInteger(input.expectedCurrentRevision) ||
    input.expectedCurrentRevision < 1
  ) {
    throw new VehicleMasterRepairCommandRejectedError(
      'EXPECTED_CURRENT_REVISION_INVALID'
    );
  }
  if (!Number.isFinite(Date.parse(input.dryRunObservedAt))) {
    throw new VehicleMasterRepairCommandRejectedError(
      'DRY_RUN_OBSERVED_AT_INVALID'
    );
  }
  if (!Number.isFinite(Date.parse(input.committedAt))) {
    throw new VehicleMasterRepairCommandRejectedError(
      'COMMITTED_AT_INVALID'
    );
  }
}

function findReadyItem(
  dryRun: VehicleMasterRepairDryRun,
  entityKind: 'NODE' | 'RULE',
  entityId: string
) {
  return dryRun.items.find(
    (item) =>
      item.entityKind === entityKind &&
      item.entityId === entityId &&
      item.status === 'READY'
  ) ?? null;
}

async function readCurrent(
  store: VehicleMasterStore,
  kind: 'NODE' | 'RULE',
  id: string
): Promise<VehicleMasterNode | VehicleMasterCompatibilityRule | null> {
  return kind === 'NODE'
    ? store.getNode(id)
    : store.getCompatibilityRule(id);
}

export async function applyVehicleMasterRepairCommand(
  store: VehicleMasterStore,
  rawInput: ApplyVehicleMasterRepairCommandInput
): Promise<ApplyVehicleMasterRepairCommandResult> {
  const input = commandRequest(rawInput);
  validateInput(input);
  const writer = resolveAuthorizedWriter(input.actor, input.writer);

  const requestDigest = stableDigest({
    ...input,
    writer,
  });
  const receiptId = deterministicVehicleMasterRecordId(
    'vehicle_master_repair_receipt',
    { idempotencyKey: input.idempotencyKey }
  );

  const existingReceipt = await store.getRepairReceipt(receiptId);
  if (existingReceipt) {
    if (existingReceipt.requestDigest !== requestDigest) {
      throw new VehicleMasterRepairCommandRejectedError(
        'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST'
      );
    }
    return {
      status: 'IDEMPOTENT_REPLAY',
      receipt: existingReceipt,
      postAudit: null,
    };
  }

  const approval = await store.getRepairApproval(input.approvalId);
  if (!approval) {
    throw new VehicleMasterRepairCommandRejectedError(
      'REPAIR_APPROVAL_MISSING'
    );
  }
  if (
    approval.writerId !== writer.id ||
    approval.reason !== input.reason ||
    approval.entityKind !== input.entityKind ||
    approval.entityId !== input.entityId ||
    approval.sourceAuditDigest !== input.sourceAuditDigest ||
    approval.repairPlanDigest !== input.repairPlanDigest ||
    approval.dryRunDigest !== input.dryRunDigest ||
    approval.expectedCurrentRevision !== input.expectedCurrentRevision ||
    approval.expectedBeforeContentHash !== input.expectedBeforeContentHash ||
    approval.expectedAfterContentHash !== input.expectedAfterContentHash
  ) {
    throw new VehicleMasterRepairCommandRejectedError(
      'REPAIR_APPROVAL_MISMATCH'
    );
  }

  const snapshot = await readVehicleMasterGraphSnapshot(store);
  const audit = auditVehicleMasterGraph(snapshot);
  if (audit.digest !== input.sourceAuditDigest) {
    throw new VehicleMasterRepairCommandRejectedError(
      'SOURCE_AUDIT_DIGEST_STALE'
    );
  }

  const plan = buildVehicleMasterRepairPlan(audit);
  if (plan.digest !== input.repairPlanDigest) {
    throw new VehicleMasterRepairCommandRejectedError(
      'REPAIR_PLAN_DIGEST_STALE'
    );
  }

  const dryRun = buildVehicleMasterRepairDryRun({
    snapshot,
    auditReport: audit,
    repairPlan: plan,
    observedAt: input.dryRunObservedAt,
  });
  if (dryRun.digest !== input.dryRunDigest) {
    throw new VehicleMasterRepairCommandRejectedError(
      'DRY_RUN_DIGEST_STALE'
    );
  }

  const readyItem = findReadyItem(
    dryRun,
    input.entityKind,
    input.entityId
  );
  if (!readyItem) {
    throw new VehicleMasterRepairCommandRejectedError(
      'TARGET_NOT_READY_IN_DRY_RUN'
    );
  }

  if (
    readyItem.currentRevision !== input.expectedCurrentRevision ||
    readyItem.beforeContentHash !== input.expectedBeforeContentHash ||
    readyItem.afterContentHash !== input.expectedAfterContentHash
  ) {
    throw new VehicleMasterRepairCommandRejectedError(
      'DRY_RUN_EXPECTATION_MISMATCH'
    );
  }

  const materialized = materializeVehicleMasterRepairCandidate({
    snapshot,
    repairPlan: plan,
    dryRunItem: readyItem,
    observedAt: input.dryRunObservedAt,
  });
  if (!materialized.record || materialized.blockers.length) {
    throw new VehicleMasterRepairCommandRejectedError(
      `CANDIDATE_MATERIALIZATION_BLOCKED:${materialized.blockers.join(',')}`
    );
  }

  if (
    materialized.record.revision !== input.expectedCurrentRevision + 1 ||
    materialized.record.contentHash !== input.expectedAfterContentHash
  ) {
    throw new VehicleMasterRepairCommandRejectedError(
      'MATERIALIZED_CANDIDATE_MISMATCH'
    );
  }

  const receipt = sealVehicleMasterRepairReceipt({
    receiptId,
    idempotencyKey: input.idempotencyKey,
    commandId: input.commandId,
    requestDigest,
    sourceAuditDigest: input.sourceAuditDigest,
    repairPlanDigest: input.repairPlanDigest,
    dryRunDigest: input.dryRunDigest,
    actor: structuredClone(input.actor),
    writerId: writer.id,
    reason: input.reason,
    approvalId: approval.approvalId,
    approvalDigest: approval.contentHash,
    approvedBy: structuredClone(approval.approvedBy),
    authorityRuleId: approval.authorityRuleId,
    entityKind: input.entityKind,
    entityId: input.entityId,
    beforeRevision: input.expectedCurrentRevision,
    afterRevision: materialized.record.revision,
    beforeContentHash: input.expectedBeforeContentHash,
    afterContentHash: materialized.record.contentHash,
    committedAt: input.committedAt,
  });

  const commit =
    input.entityKind === 'NODE'
      ? await store.commitRepair({
          entityKind: 'NODE',
          expectedRevision: input.expectedCurrentRevision,
          expectedContentHash: input.expectedBeforeContentHash,
          record: materialized.record as VehicleMasterNode,
          approval,
          receipt,
        })
      : await store.commitRepair({
          entityKind: 'RULE',
          expectedRevision: input.expectedCurrentRevision,
          expectedContentHash: input.expectedBeforeContentHash,
          record: materialized.record as VehicleMasterCompatibilityRule,
          approval,
          receipt,
        });

  const readback = await readCurrent(
    store,
    input.entityKind,
    input.entityId
  );
  if (
    !readback ||
    readback.revision !== receipt.afterRevision ||
    readback.contentHash !== receipt.afterContentHash
  ) {
    throw new VehicleMasterRepairCommandRejectedError(
      'POST_COMMIT_READBACK_MISMATCH'
    );
  }

  const postSnapshot = await readVehicleMasterGraphSnapshot(store);
  const postAudit = auditVehicleMasterGraph(postSnapshot);

  return {
    status: commit.status,
    receipt: commit.receipt,
    postAudit,
  };
}
