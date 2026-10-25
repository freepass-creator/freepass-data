import { VEHICLE_MASTER_REPAIR_AUTHORITY_RULE_ID, VEHICLE_MASTER_REPAIR_WRITER_POLICY, verifyVehicleMasterRepairApproval, verifyVehicleMasterRepairReceipt, } from '../domain/vehicle-master.js';
const copy = (value) => structuredClone(value);
export class MemoryVehicleMasterStore {
    nodes = new Map();
    nodeRevisions = new Map();
    rules = new Map();
    ruleRevisions = new Map();
    prices = new Map();
    sourceDocuments = new Map();
    hashes = new Map();
    pipeline = new Map();
    resolverFeedback = new Map();
    repairApprovals = new Map();
    repairReceipts = new Map();
    putVersioned(map, revisions, record) {
        const current = map.get(record.id);
        if (!current) {
            if (record.revision !== 1) {
                throw new Error('VEHICLE_MASTER_FIRST_REVISION_MUST_BE_ONE');
            }
            map.set(record.id, copy(record));
            revisions.set(`${record.id}__r${record.revision}`, copy(record));
            return 'CREATED';
        }
        if (current.contentHash === record.contentHash)
            return 'UNCHANGED';
        if (record.revision !== current.revision + 1) {
            throw new Error(`VEHICLE_MASTER_REVISION_CONFLICT:${record.id}:${current.revision}->${record.revision}`);
        }
        map.set(record.id, copy(record));
        revisions.set(`${record.id}__r${record.revision}`, copy(record));
        return 'UPDATED';
    }
    putImmutable(map, id, record) {
        const current = map.get(id);
        if (!current) {
            map.set(id, copy(record));
            return 'CREATED';
        }
        if (current.contentHash === record.contentHash)
            return 'UNCHANGED';
        throw new Error(`VEHICLE_MASTER_DETERMINISTIC_ID_COLLISION:${id}`);
    }
    async getNode(id) {
        return copy(this.nodes.get(id) ?? null);
    }
    async listNodesByType(nodeType) {
        return copy([...this.nodes.values()].filter((item) => item.nodeType === nodeType));
    }
    async listNodeRevisions() {
        return copy([...this.nodeRevisions.values()]
            .sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision));
    }
    async putNode(record) {
        return this.putVersioned(this.nodes, this.nodeRevisions, record);
    }
    async getCompatibilityRule(id) {
        return copy(this.rules.get(id) ?? null);
    }
    async listCompatibilityRules() {
        return copy([...this.rules.values()]
            .sort((a, b) => a.id.localeCompare(b.id)));
    }
    async listCompatibilityRuleRevisions() {
        return copy([...this.ruleRevisions.values()]
            .sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision));
    }
    async putCompatibilityRule(record) {
        return this.putVersioned(this.rules, this.ruleRevisions, record);
    }
    async getPriceRevision(id) {
        return copy(this.prices.get(id) ?? null);
    }
    async listPriceRevisions() {
        return copy([...this.prices.values()]
            .sort((a, b) => a.targetId.localeCompare(b.targetId) || a.id.localeCompare(b.id)));
    }
    async listPriceRevisionsByTarget(targetId) {
        return copy([...this.prices.values()]
            .filter((item) => item.targetId === targetId)
            .sort((a, b) => a.revision - b.revision || a.id.localeCompare(b.id)));
    }
    async putPriceRevision(record) {
        return this.putImmutable(this.prices, record.id, record);
    }
    async getSourceDocument(id) {
        return copy(this.sourceDocuments.get(id) ?? null);
    }
    async listSourceDocuments() {
        return copy([...this.sourceDocuments.values()]
            .sort((a, b) => a.sourceDocumentId.localeCompare(b.sourceDocumentId)));
    }
    async putSourceDocument(record) {
        return this.putImmutable(this.sourceDocuments, record.sourceDocumentId, record);
    }
    async getHash(hashId) {
        return copy(this.hashes.get(hashId) ?? null);
    }
    async putHash(record) {
        return this.putImmutable(this.hashes, record.hashId, record);
    }
    async getPipelineRecord(kind, recordId) {
        return copy(this.pipeline.get(`${kind}:${recordId}`) ?? null);
    }
    async listPipelineRecords(kind, sourceDocumentId) {
        return copy([...this.pipeline.values()]
            .filter((item) => item.kind === kind &&
            item.sourceDocumentId === sourceDocumentId)
            .sort((a, b) => a.recordId.localeCompare(b.recordId)));
    }
    async listPipelineRecordsByKind(kind) {
        return copy([...this.pipeline.values()]
            .filter((item) => item.kind === kind)
            .sort((a, b) => a.recordId.localeCompare(b.recordId)));
    }
    async putPipelineRecord(record) {
        return this.putImmutable(this.pipeline, `${record.kind}:${record.recordId}`, record);
    }
    async getResolverFeedback(feedbackId) {
        return copy(this.resolverFeedback.get(feedbackId) ?? null);
    }
    async putResolverFeedback(record) {
        return this.putImmutable(this.resolverFeedback, record.feedbackId, record);
    }
    async getRepairApproval(approvalId) {
        return copy(this.repairApprovals.get(approvalId) ?? null);
    }
    async putRepairApproval(record) {
        if (!verifyVehicleMasterRepairApproval(record)) {
            throw new Error(`VEHICLE_MASTER_REPAIR_APPROVAL_HASH_INVALID:${record.approvalId}`);
        }
        return this.putImmutable(this.repairApprovals, record.approvalId, record);
    }
    async getRepairReceipt(receiptId) {
        return copy(this.repairReceipts.get(receiptId) ?? null);
    }
    async commitRepair(input) {
        const storedApproval = this.repairApprovals.get(input.approval.approvalId);
        if (!storedApproval) {
            throw new Error(`VEHICLE_MASTER_REPAIR_APPROVAL_MISSING:${input.approval.approvalId}`);
        }
        if (storedApproval.contentHash !== input.approval.contentHash) {
            throw new Error(`VEHICLE_MASTER_REPAIR_APPROVAL_MISMATCH:${input.approval.approvalId}`);
        }
        if (!verifyVehicleMasterRepairApproval(storedApproval)) {
            throw new Error(`VEHICLE_MASTER_REPAIR_APPROVAL_HASH_INVALID:${storedApproval.approvalId}`);
        }
        if (!verifyVehicleMasterRepairReceipt(input.receipt)) {
            throw new Error(`VEHICLE_MASTER_REPAIR_RECEIPT_HASH_INVALID:${input.receipt.receiptId}`);
        }
        if (storedApproval.approvedBy.kind !== 'USER' ||
            storedApproval.writerId !==
                VEHICLE_MASTER_REPAIR_WRITER_POLICY.primaryWriterId ||
            storedApproval.authorityRuleId !==
                VEHICLE_MASTER_REPAIR_AUTHORITY_RULE_ID) {
            throw new Error(`VEHICLE_MASTER_REPAIR_APPROVAL_AUTHORITY_INVALID:${storedApproval.approvalId}`);
        }
        if (input.receipt.approvalId !== storedApproval.approvalId ||
            input.receipt.approvalDigest !== storedApproval.contentHash ||
            input.receipt.approvedBy.id !== storedApproval.approvedBy.id ||
            input.receipt.approvedBy.kind !== storedApproval.approvedBy.kind ||
            (input.receipt.approvedBy.organizationId ?? null) !==
                (storedApproval.approvedBy.organizationId ?? null) ||
            input.receipt.writerId !== storedApproval.writerId ||
            input.receipt.authorityRuleId !== storedApproval.authorityRuleId ||
            input.receipt.reason !== storedApproval.reason ||
            input.receipt.sourceAuditDigest !== storedApproval.sourceAuditDigest ||
            input.receipt.repairPlanDigest !== storedApproval.repairPlanDigest ||
            input.receipt.dryRunDigest !== storedApproval.dryRunDigest ||
            input.receipt.entityKind !== storedApproval.entityKind ||
            input.receipt.entityId !== storedApproval.entityId ||
            (input.receipt.actor.kind === 'SERVICE' &&
                input.receipt.actor.id !==
                    VEHICLE_MASTER_REPAIR_WRITER_POLICY.primaryWriterId)) {
            throw new Error(`VEHICLE_MASTER_REPAIR_APPROVAL_RECEIPT_MISMATCH:${storedApproval.approvalId}`);
        }
        const existingReceipt = this.repairReceipts.get(input.receipt.receiptId);
        if (existingReceipt) {
            if (existingReceipt.requestDigest !== input.receipt.requestDigest) {
                throw new Error(`VEHICLE_MASTER_REPAIR_IDEMPOTENCY_CONFLICT:${input.receipt.receiptId}`);
            }
            return {
                status: 'IDEMPOTENT_REPLAY',
                receipt: copy(existingReceipt),
            };
        }
        const map = input.entityKind === 'NODE' ? this.nodes : this.rules;
        const revisions = input.entityKind === 'NODE' ? this.nodeRevisions : this.ruleRevisions;
        const current = map.get(input.record.id);
        if (!current) {
            throw new Error(`VEHICLE_MASTER_REPAIR_CURRENT_MISSING:${input.entityKind}:${input.record.id}`);
        }
        if (current.revision !== input.expectedRevision ||
            current.contentHash !== input.expectedContentHash) {
            throw new Error(`VEHICLE_MASTER_REPAIR_CAS_MISMATCH:${input.record.id}:` +
                `${current.revision}:${current.contentHash}`);
        }
        if (storedApproval.expectedCurrentRevision !== current.revision ||
            storedApproval.expectedBeforeContentHash !== current.contentHash ||
            storedApproval.expectedAfterContentHash !== input.record.contentHash) {
            throw new Error(`VEHICLE_MASTER_REPAIR_APPROVAL_TARGET_MISMATCH:${storedApproval.approvalId}`);
        }
        if (input.record.revision !== current.revision + 1) {
            throw new Error(`VEHICLE_MASTER_REPAIR_REVISION_MISMATCH:${input.record.id}:` +
                `${current.revision}->${input.record.revision}`);
        }
        if (input.receipt.entityKind !== input.entityKind ||
            input.receipt.entityId !== input.record.id ||
            input.receipt.beforeRevision !== current.revision ||
            input.receipt.afterRevision !== input.record.revision ||
            input.receipt.beforeContentHash !== current.contentHash ||
            input.receipt.afterContentHash !== input.record.contentHash) {
            throw new Error(`VEHICLE_MASTER_REPAIR_RECEIPT_MISMATCH:${input.receipt.receiptId}`);
        }
        if (input.entityKind === 'NODE') {
            this.nodes.set(input.record.id, copy(input.record));
            this.nodeRevisions.set(`${input.record.id}__r${input.record.revision}`, copy(input.record));
        }
        else {
            this.rules.set(input.record.id, copy(input.record));
            this.ruleRevisions.set(`${input.record.id}__r${input.record.revision}`, copy(input.record));
        }
        this.repairReceipts.set(input.receipt.receiptId, copy(input.receipt));
        return {
            status: 'COMMITTED',
            receipt: copy(input.receipt),
        };
    }
}
