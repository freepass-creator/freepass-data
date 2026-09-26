import { getFirestore, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import {
  VEHICLE_MASTER_REPAIR_AUTHORITY_RULE_ID,
  VEHICLE_MASTER_REPAIR_WRITER_POLICY,
  verifyVehicleMasterRepairApproval,
  verifyVehicleMasterRepairReceipt,
} from '../domain/vehicle-master.js';
import type {
  VehicleMasterCompatibilityRule,
  VehicleMasterHashRecord,
  VehicleMasterNode,
  VehicleMasterPipelineRecord,
  VehicleMasterPriceRevision,
  VehicleMasterRepairApproval,
  VehicleMasterRepairReceipt,
  VehicleMasterResolverFeedback,
  VehicleMasterSourceDocument,
  VehicleMasterWriteResult,
} from '../domain/vehicle-master.js';
import type {
  VehicleMasterRepairCommitInput,
  VehicleMasterRepairCommitResult,
  VehicleMasterStore,
} from '../ports/vehicle-master-store.js';

const C = {
  nodes: 'vehicle_master_nodes',
  nodeRevisions: 'vehicle_master_node_revisions',
  rules: 'vehicle_master_compatibility_rules',
  ruleRevisions: 'vehicle_master_rule_revisions',
  prices: 'vehicle_master_price_revisions',
  sourceDocuments: 'vehicle_master_source_documents',
  hashes: 'vehicle_master_hashes',
  rawRecords: 'vehicle_master_raw_records',
  normalizedRecords: 'vehicle_master_normalized_records',
  candidateFacts: 'vehicle_master_candidate_facts',
  evidenceSets: 'vehicle_master_evidence_sets',
  revisionCandidates: 'vehicle_master_revision_candidates',
  promotionResults: 'vehicle_master_promotion_results',
  changeEvents: 'vehicle_master_change_events',
  resolverFeedback: 'vehicle_master_resolver_feedback',
  auditReports: 'vehicle_master_audit_reports',
  repairApprovals: 'vehicle_master_repair_approvals',
  repairReceipts: 'vehicle_master_repair_receipts',
} as const;

export const vehicleMasterFirestoreDocumentId = (value: string) => encodeURIComponent(value);

const safeId = vehicleMasterFirestoreDocumentId;

const data = <T>(snapshot: FirebaseFirestore.DocumentSnapshot) =>
  snapshot.exists ? ({ ...snapshot.data() } as T) : null;

const pipelineCollection = (kind: VehicleMasterPipelineRecord['kind']) => {
  switch (kind) {
    case 'RAW_RECORD': return C.rawRecords;
    case 'NORMALIZED_RECORD': return C.normalizedRecords;
    case 'CANDIDATE_FACT': return C.candidateFacts;
    case 'EVIDENCE_SET': return C.evidenceSets;
    case 'REVISION_CANDIDATE': return C.revisionCandidates;
    case 'PROMOTION_RESULT': return C.promotionResults;
    case 'CHANGE_EVENT': return C.changeEvents;
    case 'AUDIT_REPORT': return C.auditReports;
  }
};

type VersionedRecord = {
  id: string;
  revision: number;
  contentHash: string;
};

export class FirestoreVehicleMasterStore implements VehicleMasterStore {
  constructor(private readonly db: Firestore) {}

  private async putVersioned<T extends VersionedRecord>(
    currentRef: DocumentReference,
    revisionCollection: string,
    record: T
  ): Promise<VehicleMasterWriteResult> {
    return this.db.runTransaction(async (tx) => {
      const currentSnap = await tx.get(currentRef);
      if (!currentSnap.exists) {
        if (record.revision !== 1) {
          throw new Error('VEHICLE_MASTER_FIRST_REVISION_MUST_BE_ONE');
        }
        tx.create(currentRef, record);
        tx.create(
          this.db.collection(revisionCollection).doc(`${safeId(record.id)}__r1`),
          record
        );
        return 'CREATED';
      }

      const current = currentSnap.data() as T;
      if (current.contentHash === record.contentHash) return 'UNCHANGED';
      if (record.revision !== current.revision + 1) {
        throw new Error(
          `VEHICLE_MASTER_REVISION_CONFLICT:${record.id}:${current.revision}->${record.revision}`
        );
      }

      tx.set(currentRef, record);
      tx.create(
        this.db.collection(revisionCollection)
          .doc(`${safeId(record.id)}__r${record.revision}`),
        record
      );
      return 'UPDATED';
    });
  }

  private async putImmutable<T extends { contentHash: string }>(
    ref: DocumentReference,
    record: T
  ): Promise<VehicleMasterWriteResult> {
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        tx.create(ref, record);
        return 'CREATED';
      }
      const current = snap.data() as T;
      if (current.contentHash === record.contentHash) return 'UNCHANGED';
      throw new Error(`VEHICLE_MASTER_DETERMINISTIC_ID_COLLISION:${ref.id}`);
    });
  }

  async getNode(id: string) {
    return data<VehicleMasterNode>(
      await this.db.collection(C.nodes).doc(safeId(id)).get()
    );
  }

  async listNodesByType(nodeType: VehicleMasterNode['nodeType']) {
    const snap = await this.db.collection(C.nodes).where('nodeType', '==', nodeType).get();
    return snap.docs.map((doc) => doc.data() as VehicleMasterNode);
  }

  async listNodeRevisions() {
    const snap = await this.db.collection(C.nodeRevisions).get();
    return snap.docs
      .map((doc) => doc.data() as VehicleMasterNode)
      .sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision);
  }

  async putNode(record: VehicleMasterNode) {
    return this.putVersioned(
      this.db.collection(C.nodes).doc(safeId(record.id)),
      C.nodeRevisions,
      record
    );
  }

  async getCompatibilityRule(id: string) {
    return data<VehicleMasterCompatibilityRule>(
      await this.db.collection(C.rules).doc(safeId(id)).get()
    );
  }

  async listCompatibilityRules() {
    const snap = await this.db.collection(C.rules).get();
    return snap.docs
      .map((doc) => doc.data() as VehicleMasterCompatibilityRule)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async listCompatibilityRuleRevisions() {
    const snap = await this.db.collection(C.ruleRevisions).get();
    return snap.docs
      .map((doc) => doc.data() as VehicleMasterCompatibilityRule)
      .sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision);
  }

  async putCompatibilityRule(record: VehicleMasterCompatibilityRule) {
    return this.putVersioned(
      this.db.collection(C.rules).doc(safeId(record.id)),
      C.ruleRevisions,
      record
    );
  }

  async getPriceRevision(id: string) {
    return data<VehicleMasterPriceRevision>(
      await this.db.collection(C.prices).doc(safeId(id)).get()
    );
  }

  async listPriceRevisions() {
    const snap = await this.db.collection(C.prices).get();
    return snap.docs
      .map((doc) => doc.data() as VehicleMasterPriceRevision)
      .sort((a, b) => a.targetId.localeCompare(b.targetId) || a.id.localeCompare(b.id));
  }

  async listPriceRevisionsByTarget(targetId: string) {
    const snap = await this.db.collection(C.prices).where('targetId', '==', targetId).get();
    return snap.docs
      .map((doc) => doc.data() as VehicleMasterPriceRevision)
      .sort((a, b) => a.revision - b.revision || a.id.localeCompare(b.id));
  }

  async putPriceRevision(record: VehicleMasterPriceRevision) {
    return this.putImmutable(
      this.db.collection(C.prices).doc(safeId(record.id)),
      record
    );
  }

  async getSourceDocument(id: string) {
    return data<VehicleMasterSourceDocument>(
      await this.db.collection(C.sourceDocuments).doc(safeId(id)).get()
    );
  }

  async listSourceDocuments() {
    const snap = await this.db.collection(C.sourceDocuments).get();
    return snap.docs
      .map((doc) => doc.data() as VehicleMasterSourceDocument)
      .sort((a, b) => a.sourceDocumentId.localeCompare(b.sourceDocumentId));
  }

  async putSourceDocument(record: VehicleMasterSourceDocument) {
    return this.putImmutable(
      this.db.collection(C.sourceDocuments).doc(safeId(record.sourceDocumentId)),
      record
    );
  }

  async getHash(hashId: string) {
    return data<VehicleMasterHashRecord>(
      await this.db.collection(C.hashes).doc(safeId(hashId)).get()
    );
  }

  async putHash(record: VehicleMasterHashRecord) {
    return this.putImmutable(
      this.db.collection(C.hashes).doc(safeId(record.hashId)),
      record
    );
  }

  async getPipelineRecord(
    kind: VehicleMasterPipelineRecord['kind'],
    recordId: string
  ) {
    return data<VehicleMasterPipelineRecord>(
      await this.db.collection(pipelineCollection(kind)).doc(safeId(recordId)).get()
    );
  }

  async listPipelineRecords(
    kind: VehicleMasterPipelineRecord['kind'],
    sourceDocumentId: string
  ) {
    const snap = await this.db.collection(pipelineCollection(kind))
      .where('sourceDocumentId', '==', sourceDocumentId)
      .get();
    return snap.docs
      .map((doc) => doc.data() as VehicleMasterPipelineRecord)
      .sort((a, b) => a.recordId.localeCompare(b.recordId));
  }

  async listPipelineRecordsByKind(
    kind: VehicleMasterPipelineRecord['kind']
  ) {
    const snap = await this.db.collection(pipelineCollection(kind)).get();
    return snap.docs
      .map((doc) => doc.data() as VehicleMasterPipelineRecord)
      .sort((a, b) => a.recordId.localeCompare(b.recordId));
  }

  async putPipelineRecord(record: VehicleMasterPipelineRecord) {
    return this.putImmutable(
      this.db.collection(pipelineCollection(record.kind)).doc(safeId(record.recordId)),
      record
    );
  }

  async getResolverFeedback(feedbackId: string) {
    return data<VehicleMasterResolverFeedback>(
      await this.db.collection(C.resolverFeedback).doc(safeId(feedbackId)).get()
    );
  }

  async putResolverFeedback(record: VehicleMasterResolverFeedback) {
    return this.putImmutable(
      this.db.collection(C.resolverFeedback).doc(safeId(record.feedbackId)),
      record
    );
  }

  async getRepairApproval(approvalId: string) {
    return data<VehicleMasterRepairApproval>(
      await this.db.collection(C.repairApprovals).doc(safeId(approvalId)).get()
    );
  }

  async putRepairApproval(record: VehicleMasterRepairApproval) {
    if (!verifyVehicleMasterRepairApproval(record)) {
      throw new Error(
        `VEHICLE_MASTER_REPAIR_APPROVAL_HASH_INVALID:${record.approvalId}`
      );
    }
    return this.putImmutable(
      this.db.collection(C.repairApprovals).doc(safeId(record.approvalId)),
      record
    );
  }

  async getRepairReceipt(receiptId: string) {
    return data<VehicleMasterRepairReceipt>(
      await this.db.collection(C.repairReceipts).doc(safeId(receiptId)).get()
    );
  }

  async commitRepair(
    input: VehicleMasterRepairCommitInput
  ): Promise<VehicleMasterRepairCommitResult> {
    const approvalRef = this.db.collection(C.repairApprovals)
      .doc(safeId(input.approval.approvalId));
    const receiptRef = this.db.collection(C.repairReceipts)
      .doc(safeId(input.receipt.receiptId));
    const currentCollection =
      input.entityKind === 'NODE' ? C.nodes : C.rules;
    const revisionCollection =
      input.entityKind === 'NODE' ? C.nodeRevisions : C.ruleRevisions;
    const currentRef = this.db.collection(currentCollection)
      .doc(safeId(input.record.id));
    const revisionRef = this.db.collection(revisionCollection)
      .doc(`${safeId(input.record.id)}__r${input.record.revision}`);

    return this.db.runTransaction(async (tx) => {
      const [approvalSnap, receiptSnap, currentSnap] = await Promise.all([
        tx.get(approvalRef),
        tx.get(receiptRef),
        tx.get(currentRef),
      ]);

      if (!approvalSnap.exists) {
        throw new Error(
          `VEHICLE_MASTER_REPAIR_APPROVAL_MISSING:${input.approval.approvalId}`
        );
      }
      const storedApproval = approvalSnap.data() as VehicleMasterRepairApproval;
      if (storedApproval.contentHash !== input.approval.contentHash) {
        throw new Error(
          `VEHICLE_MASTER_REPAIR_APPROVAL_MISMATCH:${input.approval.approvalId}`
        );
      }
      if (!verifyVehicleMasterRepairApproval(storedApproval)) {
        throw new Error(
          `VEHICLE_MASTER_REPAIR_APPROVAL_HASH_INVALID:${storedApproval.approvalId}`
        );
      }
      if (!verifyVehicleMasterRepairReceipt(input.receipt)) {
        throw new Error(
          `VEHICLE_MASTER_REPAIR_RECEIPT_HASH_INVALID:${input.receipt.receiptId}`
        );
      }
      if (
        storedApproval.approvedBy.kind !== 'USER' ||
        storedApproval.writerId !==
          VEHICLE_MASTER_REPAIR_WRITER_POLICY.primaryWriterId ||
        storedApproval.authorityRuleId !==
          VEHICLE_MASTER_REPAIR_AUTHORITY_RULE_ID
      ) {
        throw new Error(
          `VEHICLE_MASTER_REPAIR_APPROVAL_AUTHORITY_INVALID:${storedApproval.approvalId}`
        );
      }
      if (
        input.receipt.approvalId !== storedApproval.approvalId ||
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
        (
          input.receipt.actor.kind === 'SERVICE' &&
          input.receipt.actor.id !==
            VEHICLE_MASTER_REPAIR_WRITER_POLICY.primaryWriterId
        )
      ) {
        throw new Error(
          `VEHICLE_MASTER_REPAIR_APPROVAL_RECEIPT_MISMATCH:${storedApproval.approvalId}`
        );
      }

      if (receiptSnap.exists) {
        const existing = receiptSnap.data() as VehicleMasterRepairReceipt;
        if (existing.requestDigest !== input.receipt.requestDigest) {
          throw new Error(
            `VEHICLE_MASTER_REPAIR_IDEMPOTENCY_CONFLICT:${input.receipt.receiptId}`
          );
        }
        return {
          status: 'IDEMPOTENT_REPLAY',
          receipt: existing,
        };
      }

      if (!currentSnap.exists) {
        throw new Error(
          `VEHICLE_MASTER_REPAIR_CURRENT_MISSING:${input.entityKind}:${input.record.id}`
        );
      }

      const current = currentSnap.data() as
        | VehicleMasterNode
        | VehicleMasterCompatibilityRule;
      if (
        current.revision !== input.expectedRevision ||
        current.contentHash !== input.expectedContentHash
      ) {
        throw new Error(
          `VEHICLE_MASTER_REPAIR_CAS_MISMATCH:${input.record.id}:` +
          `${current.revision}:${current.contentHash}`
        );
      }
      if (
        storedApproval.expectedCurrentRevision !== current.revision ||
        storedApproval.expectedBeforeContentHash !== current.contentHash ||
        storedApproval.expectedAfterContentHash !== input.record.contentHash
      ) {
        throw new Error(
          `VEHICLE_MASTER_REPAIR_APPROVAL_TARGET_MISMATCH:${storedApproval.approvalId}`
        );
      }
      if (input.record.revision !== current.revision + 1) {
        throw new Error(
          `VEHICLE_MASTER_REPAIR_REVISION_MISMATCH:${input.record.id}:` +
          `${current.revision}->${input.record.revision}`
        );
      }
      if (
        input.receipt.entityKind !== input.entityKind ||
        input.receipt.entityId !== input.record.id ||
        input.receipt.beforeRevision !== current.revision ||
        input.receipt.afterRevision !== input.record.revision ||
        input.receipt.beforeContentHash !== current.contentHash ||
        input.receipt.afterContentHash !== input.record.contentHash
      ) {
        throw new Error(
          `VEHICLE_MASTER_REPAIR_RECEIPT_MISMATCH:${input.receipt.receiptId}`
        );
      }

      tx.set(currentRef, input.record);
      tx.create(revisionRef, input.record);
      tx.create(receiptRef, input.receipt);

      return {
        status: 'COMMITTED',
        receipt: input.receipt,
      };
    });
  }
}

export function createFirestoreVehicleMasterStore() {
  return new FirestoreVehicleMasterStore(getFirestore(getTargetFirebaseApp()));
}
