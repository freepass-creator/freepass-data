import { stableDigest } from '../shared/stable-digest.js';
export const VEHICLE_MASTER_SCHEMA_VERSION = '1.0.0';
export const VEHICLE_MASTER_REPAIR_AUTHORITY_RULE_ID = 'vehicle-master-auto-safe-repair-v1';
export const VEHICLE_MASTER_REPAIR_WRITER_POLICY = {
    scope: 'vehicle-master-repair',
    mode: 'EXCLUSIVE',
    primaryWriterId: 'service:freepass-data',
    authorityRuleId: VEHICLE_MASTER_REPAIR_AUTHORITY_RULE_ID,
};
const PREFIX = {
    MAKE: 'make',
    MODEL: 'model',
    GENERATION: 'gen',
    PHASE: 'phase',
    MODEL_YEAR: 'my',
    POWERTRAIN: 'pt',
    VARIANT: 'variant',
    TRIM: 'trim',
    BASE_ITEM: 'base',
    OPTION: 'opt',
    PACKAGE: 'pkg',
    OPTION_GROUP: 'og',
    COLOR: 'color',
};
const cleanText = (value, field) => {
    const normalized = value.trim();
    if (!normalized)
        throw new Error(`VEHICLE_MASTER_INVALID:${field}`);
    return normalized;
};
const assertRevision = (revision) => {
    if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new Error('VEHICLE_MASTER_INVALID:revision');
    }
};
const assertTime = (value, field) => {
    if (value == null)
        return;
    if (!Number.isFinite(Date.parse(value)))
        throw new Error(`VEHICLE_MASTER_INVALID:${field}`);
};
const assertTemporal = (value) => {
    assertTime(value.effectiveFrom, 'effectiveFrom');
    assertTime(value.effectiveTo, 'effectiveTo');
    if (value.effectiveFrom &&
        value.effectiveTo &&
        Date.parse(value.effectiveFrom) >= Date.parse(value.effectiveTo)) {
        throw new Error('VEHICLE_MASTER_INVALID:effectiveRange');
    }
};
const assertSha256 = (value, field) => {
    if (!/^[a-f0-9]{64}$/i.test(value))
        throw new Error(`VEHICLE_MASTER_INVALID:${field}`);
};
const uniqueSorted = (values) => [...new Set(values.map((value) => cleanText(value, 'id')))].sort();
export function deterministicVehicleMasterId(nodeType, identity) {
    if (!identity || !Object.keys(identity).length) {
        throw new Error('VEHICLE_MASTER_IDENTITY_REQUIRED');
    }
    return `${PREFIX[nodeType]}_${stableDigest({ nodeType, identity }).slice(0, 24)}`;
}
export function deterministicVehicleMasterRecordId(namespace, identity) {
    return `${cleanText(namespace, 'namespace')}_${stableDigest(identity).slice(0, 24)}`;
}
export function sealVehicleMasterNode(input) {
    assertRevision(input.revision);
    assertTemporal(input);
    assertTime(input.createdAt, 'createdAt');
    assertTime(input.updatedAt, 'updatedAt');
    const record = {
        ...input,
        id: cleanText(input.id, 'id'),
        canonicalName: cleanText(input.canonicalName, 'canonicalName'),
        aliases: uniqueSorted(input.aliases),
        sourceEvidenceIds: uniqueSorted(input.sourceEvidenceIds),
        schemaVersion: VEHICLE_MASTER_SCHEMA_VERSION,
    };
    return { ...record, contentHash: stableDigest(record) };
}
export function sealVehicleMasterCompatibilityRule(input) {
    assertRevision(input.revision);
    assertTemporal(input);
    assertTime(input.createdAt, 'createdAt');
    assertTime(input.updatedAt, 'updatedAt');
    if (!Number.isSafeInteger(input.priority)) {
        throw new Error('VEHICLE_MASTER_INVALID:priority');
    }
    const targetIds = uniqueSorted(input.targetIds);
    if (!targetIds.length && !['AVAILABLE_IF', 'UNAVAILABLE_IF'].includes(input.ruleType)) {
        throw new Error('VEHICLE_MASTER_INVALID:ruleTargets');
    }
    if (targetIds.includes(input.subjectId)) {
        throw new Error('VEHICLE_MASTER_INVALID:selfRule');
    }
    const record = {
        ...input,
        id: cleanText(input.id, 'id'),
        subjectId: cleanText(input.subjectId, 'subjectId'),
        targetIds,
        sourceEvidenceIds: uniqueSorted(input.sourceEvidenceIds),
        schemaVersion: VEHICLE_MASTER_SCHEMA_VERSION,
    };
    return { ...record, contentHash: stableDigest(record) };
}
export function sealVehicleMasterPriceRevision(input) {
    assertRevision(input.revision);
    assertTemporal(input);
    assertTime(input.createdAt, 'createdAt');
    assertTime(input.updatedAt, 'updatedAt');
    if (!Number.isSafeInteger(input.amount) || input.amount < 0) {
        throw new Error('VEHICLE_MASTER_INVALID:amount');
    }
    const record = {
        ...input,
        id: cleanText(input.id, 'id'),
        targetId: cleanText(input.targetId, 'targetId'),
        sourceEvidenceIds: uniqueSorted(input.sourceEvidenceIds),
        sourceDocumentIds: uniqueSorted(input.sourceDocumentIds),
        schemaVersion: VEHICLE_MASTER_SCHEMA_VERSION,
    };
    return { ...record, contentHash: stableDigest(record) };
}
export function sealVehicleMasterSourceDocument(input) {
    assertTemporal(input);
    assertTime(input.observedAt, 'observedAt');
    assertTime(input.publishedAt, 'publishedAt');
    assertSha256(input.sha256, 'sha256');
    if (!input.storagePath.trim())
        throw new Error('VEHICLE_MASTER_STORAGE_PATH_REQUIRED');
    const record = {
        ...input,
        sourceDocumentId: cleanText(input.sourceDocumentId, 'sourceDocumentId'),
        sourceName: cleanText(input.sourceName, 'sourceName'),
        storagePath: cleanText(input.storagePath, 'storagePath'),
        sha256: input.sha256.toLowerCase(),
    };
    return { ...record, contentHash: stableDigest(record) };
}
export function sealVehicleMasterHashRecord(input) {
    assertTime(input.observedAt, 'observedAt');
    assertSha256(input.digest, 'digest');
    if (input.algorithm !== 'SHA-256') {
        throw new Error('VEHICLE_MASTER_INVALID:hashAlgorithm');
    }
    if (input.byteLength != null &&
        (!Number.isSafeInteger(input.byteLength) || input.byteLength < 0)) {
        throw new Error('VEHICLE_MASTER_INVALID:byteLength');
    }
    const sourceDocumentId = input.sourceDocumentId == null
        ? null
        : cleanText(input.sourceDocumentId, 'sourceDocumentId');
    const targetId = input.targetId == null
        ? null
        : cleanText(input.targetId, 'targetId');
    const storagePath = input.storagePath == null
        ? null
        : cleanText(input.storagePath, 'storagePath');
    if (input.scope === 'SOURCE_BYTES' && (!sourceDocumentId || !storagePath)) {
        throw new Error('VEHICLE_MASTER_INVALID:sourceBytesHashRefs');
    }
    const record = {
        ...input,
        hashId: cleanText(input.hashId, 'hashId'),
        digest: input.digest.toLowerCase(),
        sourceDocumentId,
        targetId,
        storagePath,
    };
    return { ...record, contentHash: stableDigest(record) };
}
export function sealVehicleMasterPipelineRecord(input) {
    assertTime(input.observedAt, 'observedAt');
    const record = {
        ...input,
        recordId: cleanText(input.recordId, 'recordId'),
    };
    return { ...record, contentHash: stableDigest(record) };
}
export function sealVehicleMasterRepairApproval(input) {
    assertTime(input.approvedAt, 'approvedAt');
    assertRevision(input.expectedCurrentRevision);
    assertSha256(input.sourceAuditDigest, 'sourceAuditDigest');
    assertSha256(input.repairPlanDigest, 'repairPlanDigest');
    assertSha256(input.dryRunDigest, 'dryRunDigest');
    assertSha256(input.expectedBeforeContentHash, 'expectedBeforeContentHash');
    assertSha256(input.expectedAfterContentHash, 'expectedAfterContentHash');
    if (input.approvedBy.kind !== 'USER') {
        throw new Error('VEHICLE_MASTER_REPAIR_APPROVAL_REQUIRES_USER');
    }
    if (input.writerId !==
        VEHICLE_MASTER_REPAIR_WRITER_POLICY.primaryWriterId) {
        throw new Error('VEHICLE_MASTER_REPAIR_WRITER_NOT_OWNER');
    }
    if (input.authorityRuleId !== VEHICLE_MASTER_REPAIR_AUTHORITY_RULE_ID) {
        throw new Error('VEHICLE_MASTER_REPAIR_AUTHORITY_RULE_MISMATCH');
    }
    const record = {
        ...input,
        approvalId: cleanText(input.approvalId, 'approvalId'),
        entityId: cleanText(input.entityId, 'entityId'),
        writerId: cleanText(input.writerId, 'writerId'),
        reason: cleanText(input.reason, 'reason'),
        authorityRuleId: cleanText(input.authorityRuleId, 'authorityRuleId'),
        approvedBy: structuredClone(input.approvedBy),
    };
    return { ...record, contentHash: stableDigest(record) };
}
export function verifyVehicleMasterRepairApproval(record) {
    const { contentHash, ...input } = record;
    return sealVehicleMasterRepairApproval(input).contentHash === contentHash;
}
export function sealVehicleMasterRepairReceipt(input) {
    assertTime(input.committedAt, 'committedAt');
    assertRevision(input.beforeRevision);
    assertRevision(input.afterRevision);
    if (input.afterRevision !== input.beforeRevision + 1) {
        throw new Error('VEHICLE_MASTER_INVALID:repairRevisionTransition');
    }
    assertSha256(input.requestDigest, 'requestDigest');
    assertSha256(input.sourceAuditDigest, 'sourceAuditDigest');
    assertSha256(input.repairPlanDigest, 'repairPlanDigest');
    assertSha256(input.dryRunDigest, 'dryRunDigest');
    assertSha256(input.approvalDigest, 'approvalDigest');
    assertSha256(input.beforeContentHash, 'beforeContentHash');
    assertSha256(input.afterContentHash, 'afterContentHash');
    if (input.writerId !==
        VEHICLE_MASTER_REPAIR_WRITER_POLICY.primaryWriterId) {
        throw new Error('VEHICLE_MASTER_REPAIR_WRITER_NOT_OWNER');
    }
    if (input.authorityRuleId !== VEHICLE_MASTER_REPAIR_AUTHORITY_RULE_ID) {
        throw new Error('VEHICLE_MASTER_REPAIR_AUTHORITY_RULE_MISMATCH');
    }
    if (input.actor.kind === 'SERVICE' &&
        input.actor.id !== VEHICLE_MASTER_REPAIR_WRITER_POLICY.primaryWriterId) {
        throw new Error('VEHICLE_MASTER_REPAIR_ACTOR_NOT_AUTHORIZED');
    }
    if (input.approvedBy.kind !== 'USER') {
        throw new Error('VEHICLE_MASTER_REPAIR_APPROVAL_REQUIRES_USER');
    }
    const record = {
        ...input,
        receiptId: cleanText(input.receiptId, 'receiptId'),
        idempotencyKey: cleanText(input.idempotencyKey, 'idempotencyKey'),
        commandId: cleanText(input.commandId, 'commandId'),
        requestDigest: cleanText(input.requestDigest, 'requestDigest'),
        sourceAuditDigest: cleanText(input.sourceAuditDigest, 'sourceAuditDigest'),
        repairPlanDigest: cleanText(input.repairPlanDigest, 'repairPlanDigest'),
        dryRunDigest: cleanText(input.dryRunDigest, 'dryRunDigest'),
        writerId: cleanText(input.writerId, 'writerId'),
        reason: cleanText(input.reason, 'reason'),
        approvalId: cleanText(input.approvalId, 'approvalId'),
        approvalDigest: cleanText(input.approvalDigest, 'approvalDigest'),
        authorityRuleId: cleanText(input.authorityRuleId, 'authorityRuleId'),
        actor: structuredClone(input.actor),
        approvedBy: structuredClone(input.approvedBy),
        entityId: cleanText(input.entityId, 'entityId'),
        beforeContentHash: cleanText(input.beforeContentHash, 'beforeContentHash'),
        afterContentHash: cleanText(input.afterContentHash, 'afterContentHash'),
    };
    return { ...record, contentHash: stableDigest(record) };
}
export function verifyVehicleMasterRepairReceipt(record) {
    const { contentHash, ...input } = record;
    return sealVehicleMasterRepairReceipt(input).contentHash === contentHash;
}
export function sealVehicleMasterResolverFeedback(input) {
    assertTime(input.resolvedAt, 'resolvedAt');
    assertSha256(input.rawInputHash, 'rawInputHash');
    const record = {
        ...input,
        feedbackId: cleanText(input.feedbackId, 'feedbackId'),
        candidateIds: uniqueSorted(input.candidateIds),
        reason: cleanText(input.reason, 'reason'),
        resolvedBy: cleanText(input.resolvedBy, 'resolvedBy'),
    };
    return { ...record, contentHash: stableDigest(record) };
}
