import { createHash } from 'node:crypto';
import { getFirestore, type Firestore, type Query, type Transaction } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';
import { stableDigest } from '../shared/stable-digest.js';
import {
  ADMIN_WORKFLOW_RESOURCES,
  assertAdminWorkflowCommitRequest,
  assertAdminWorkflowReadSpec,
  type AdminWorkflowCommitReceipt,
  type AdminWorkflowCommitRequest,
  type AdminWorkflowDocument,
  type AdminWorkflowMutation,
  type AdminWorkflowReadResult,
  type AdminWorkflowReadSpec,
} from '../api/admin-workflow-contract.js';

const RECEIPTS = 'data_admin_workflow_receipts';

class AdminWorkflowConflictError extends Error {
  readonly code = 'ADMIN_WORKFLOW_CONFLICT';
  constructor() { super('ADMIN_WORKFLOW_CONFLICT'); }
}

class AdminWorkflowIdempotencyError extends Error {
  readonly code = 'ADMIN_WORKFLOW_IDEMPOTENCY_CONFLICT';
  constructor() { super('ADMIN_WORKFLOW_IDEMPOTENCY_CONFLICT'); }
}

const collectionName = (resource: keyof typeof ADMIN_WORKFLOW_RESOURCES) =>
  ADMIN_WORKFLOW_RESOURCES[resource];

function queryFor(db: Firestore, spec: Extract<AdminWorkflowReadSpec, { kind: 'query' }>): Query {
  let query: Query = db.collection(collectionName(spec.resource));
  for (const filter of spec.filters ?? []) query = query.where(filter.field, filter.op, filter.value);
  if (spec.limit) query = query.limit(spec.limit);
  return query;
}

const docResult = (id: string, exists: boolean, data?: Record<string, unknown>): AdminWorkflowReadResult => {
  const docs: AdminWorkflowDocument[] = exists ? [{ id, data: data ?? {} }] : [];
  return {
    schema: 'freepass-data.admin-workflow-read/v1',
    docs,
    digest: stableDigest({ kind: 'doc', id, exists, data: exists ? (data ?? {}) : null }),
  };
};

const queryResult = (docs: AdminWorkflowDocument[]): AdminWorkflowReadResult => {
  const sorted = [...docs].sort((a, b) => a.id.localeCompare(b.id));
  return {
    schema: 'freepass-data.admin-workflow-read/v1',
    docs,
    digest: stableDigest({ kind: 'query', docs: sorted }),
  };
};

async function readWith(
  db: Firestore,
  spec: AdminWorkflowReadSpec,
  tx?: Transaction,
): Promise<AdminWorkflowReadResult> {
  assertAdminWorkflowReadSpec(spec);
  if (spec.kind === 'doc') {
    const ref = db.collection(collectionName(spec.resource)).doc(spec.id);
    const snap = tx ? await tx.get(ref) : await ref.get();
    return docResult(snap.id, snap.exists, snap.exists ? snap.data() as Record<string, unknown> : undefined);
  }
  const query = queryFor(db, spec);
  const snap = tx ? await tx.get(query) : await query.get();
  return queryResult(snap.docs.map((doc) => ({ id: doc.id, data: doc.data() as Record<string, unknown> })));
}

function applyMutation(
  db: Firestore,
  tx: Transaction,
  mutation: AdminWorkflowMutation,
) {
  const ref = db.collection(collectionName(mutation.resource)).doc(mutation.id);
  if (mutation.op === 'set') {
    tx.set(ref, mutation.data, mutation.merge ? { merge: true } : undefined);
  } else if (mutation.op === 'update') {
    tx.update(ref, mutation.data);
  } else {
    tx.create(ref, mutation.data);
  }
}

function receiptId(consumerId: string, operationId: string) {
  return 'awr_' + createHash('sha256').update(consumerId + '|' + operationId).digest('hex').slice(0, 40);
}

export type AdminWorkflowStore = {
  read(spec: AdminWorkflowReadSpec): Promise<AdminWorkflowReadResult>;
  commit(consumerId: string, request: AdminWorkflowCommitRequest): Promise<AdminWorkflowCommitReceipt>;
};

export function adminWorkflowStore(db: Firestore): AdminWorkflowStore {
  return {
    async read(spec) {
      return readWith(db, spec);
    },

    async commit(consumerId, request) {
      assertAdminWorkflowCommitRequest(request);
      const requestDigest = stableDigest({
        consumerId,
        operationId: request.operationId,
        actor: request.actor,
        purpose: request.purpose,
        expectations: request.expectations,
        mutations: request.mutations,
      });
      const receiptRef = db.collection(RECEIPTS).doc(receiptId(consumerId, request.operationId));

      return db.runTransaction(async (tx) => {
        const prior = await tx.get(receiptRef);
        if (prior.exists) {
          const value = prior.data() as AdminWorkflowCommitReceipt;
          if (value.requestDigest !== requestDigest) throw new AdminWorkflowIdempotencyError();
          return { ...value, idempotent: true };
        }

        for (const expectation of request.expectations) {
          const current = await readWith(db, expectation.spec, tx);
          if (current.digest !== expectation.digest) throw new AdminWorkflowConflictError();
        }

        for (const mutation of request.mutations) applyMutation(db, tx, mutation);

        const committedAt = new Date().toISOString();
        const base = {
          schema: 'freepass-data.admin-workflow-receipt/v1' as const,
          authority: 'FREEPASS_DATA' as const,
          consumerId,
          operationId: request.operationId,
          requestDigest,
          mutationCount: request.mutations.length,
          committedAt,
        };
        const receipt: AdminWorkflowCommitReceipt = {
          ...base,
          receiptDigest: stableDigest(base),
          idempotent: false,
        };
        tx.create(receiptRef, receipt);
        return receipt;
      });
    },
  };
}

export function createFirestoreAdminWorkflowStore() {
  return adminWorkflowStore(getFirestore(getTargetFirebaseApp()));
}
