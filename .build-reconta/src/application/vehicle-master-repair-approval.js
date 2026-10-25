import { VEHICLE_MASTER_REPAIR_AUTHORITY_RULE_ID, VEHICLE_MASTER_REPAIR_WRITER_POLICY, sealVehicleMasterRepairApproval, } from '../domain/vehicle-master.js';
import { resolveExecutionWriter, } from '../domain/writer-ownership.js';
import { auditVehicleMasterGraph, readVehicleMasterGraphSnapshot, } from './vehicle-master-graph-audit.js';
import { buildVehicleMasterRepairDryRun, } from './vehicle-master-repair-dry-run.js';
import { buildVehicleMasterRepairPlan, } from './vehicle-master-repair-plan.js';
export class VehicleMasterRepairApprovalRejectedError extends Error {
    reason;
    code = 'VEHICLE_MASTER_REPAIR_APPROVAL_REJECTED';
    constructor(reason) {
        super(reason);
        this.reason = reason;
    }
}
const clean = (value, field) => {
    const trimmed = value.trim();
    if (!trimmed) {
        throw new VehicleMasterRepairApprovalRejectedError(`REQUIRED_FIELD_MISSING:${field}`);
    }
    return trimmed;
};
function assertWriter(approvedBy, writer) {
    if (approvedBy.kind !== 'USER') {
        throw new VehicleMasterRepairApprovalRejectedError('APPROVAL_REQUIRES_USER_ACTOR');
    }
    const resolved = resolveExecutionWriter(approvedBy, writer);
    if (resolved.id !== VEHICLE_MASTER_REPAIR_WRITER_POLICY.primaryWriterId ||
        resolved.kind !== 'SERVICE') {
        throw new VehicleMasterRepairApprovalRejectedError('REPAIR_WRITER_NOT_OWNER');
    }
    return resolved;
}
export async function approveVehicleMasterRepair(store, rawInput) {
    const approvalId = clean(rawInput.approvalId, 'approvalId');
    const entityId = clean(rawInput.entityId, 'entityId');
    const reason = clean(rawInput.reason, 'reason');
    const sourceAuditDigest = clean(rawInput.sourceAuditDigest, 'sourceAuditDigest');
    const repairPlanDigest = clean(rawInput.repairPlanDigest, 'repairPlanDigest');
    const dryRunDigest = clean(rawInput.dryRunDigest, 'dryRunDigest');
    const expectedBeforeContentHash = clean(rawInput.expectedBeforeContentHash, 'expectedBeforeContentHash');
    const expectedAfterContentHash = clean(rawInput.expectedAfterContentHash, 'expectedAfterContentHash');
    const dryRunObservedAt = clean(rawInput.dryRunObservedAt, 'dryRunObservedAt');
    const approvedAt = clean(rawInput.approvedAt, 'approvedAt');
    if (!Number.isFinite(Date.parse(dryRunObservedAt))) {
        throw new VehicleMasterRepairApprovalRejectedError('DRY_RUN_OBSERVED_AT_INVALID');
    }
    if (!Number.isFinite(Date.parse(approvedAt))) {
        throw new VehicleMasterRepairApprovalRejectedError('APPROVED_AT_INVALID');
    }
    if (!Number.isSafeInteger(rawInput.expectedCurrentRevision) ||
        rawInput.expectedCurrentRevision < 1) {
        throw new VehicleMasterRepairApprovalRejectedError('EXPECTED_CURRENT_REVISION_INVALID');
    }
    const writer = assertWriter(rawInput.approvedBy, rawInput.writer);
    const snapshot = await readVehicleMasterGraphSnapshot(store);
    const audit = auditVehicleMasterGraph(snapshot);
    if (audit.digest !== sourceAuditDigest) {
        throw new VehicleMasterRepairApprovalRejectedError('SOURCE_AUDIT_DIGEST_STALE');
    }
    const plan = buildVehicleMasterRepairPlan(audit);
    if (plan.digest !== repairPlanDigest) {
        throw new VehicleMasterRepairApprovalRejectedError('REPAIR_PLAN_DIGEST_STALE');
    }
    const dryRun = buildVehicleMasterRepairDryRun({
        snapshot,
        auditReport: audit,
        repairPlan: plan,
        observedAt: dryRunObservedAt,
    });
    if (dryRun.digest !== dryRunDigest) {
        throw new VehicleMasterRepairApprovalRejectedError('DRY_RUN_DIGEST_STALE');
    }
    const item = dryRun.items.find((candidate) => candidate.entityKind === rawInput.entityKind &&
        candidate.entityId === entityId &&
        candidate.status === 'READY');
    if (!item) {
        throw new VehicleMasterRepairApprovalRejectedError('TARGET_NOT_READY_IN_DRY_RUN');
    }
    if (item.currentRevision !== rawInput.expectedCurrentRevision ||
        item.beforeContentHash !== expectedBeforeContentHash ||
        item.afterContentHash !== expectedAfterContentHash) {
        throw new VehicleMasterRepairApprovalRejectedError('DRY_RUN_EXPECTATION_MISMATCH');
    }
    const approval = sealVehicleMasterRepairApproval({
        approvalId,
        entityKind: rawInput.entityKind,
        entityId,
        sourceAuditDigest,
        repairPlanDigest,
        dryRunDigest,
        expectedCurrentRevision: rawInput.expectedCurrentRevision,
        expectedBeforeContentHash,
        expectedAfterContentHash,
        approvedBy: structuredClone(rawInput.approvedBy),
        writerId: writer.id,
        reason,
        approvedAt,
        authorityRuleId: VEHICLE_MASTER_REPAIR_AUTHORITY_RULE_ID,
    });
    const status = await store.putRepairApproval(approval);
    if (status === 'UPDATED') {
        throw new VehicleMasterRepairApprovalRejectedError('APPROVAL_MUST_BE_IMMUTABLE');
    }
    return {
        status,
        approval,
    };
}
