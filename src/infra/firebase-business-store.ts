import { getFirestore } from 'firebase-admin/firestore';
import { getDatabase } from 'firebase-admin/database';
import { getStorage } from 'firebase-admin/storage';
import { createHash } from 'node:crypto';
import {
  assertBusinessId,
  resolveBusinessResource,
  type BusinessResource,
} from '../domain/business-resource-registry.js';
import { getBusinessFirebaseApp } from './firebase-target.js';

export type BusinessReadRequest = {
  consumerId: string;
  resource: string;
  id?: string;
  parentId?: string;
  limit?: number;
};

export type BusinessMutation = {
  resource: string;
  action: 'CREATE' | 'SET' | 'PATCH' | 'DELETE';
  id: string;
  parentId?: string;
  data?: Record<string, unknown>;
};

export type BusinessWriteRequest = {
  consumerId: string;
  commandId: string;
  idempotencyKey: string;
  reason: string;
  operations: BusinessMutation[];
};

export type BusinessWriteReceipt = {
  contract: 'freepass-data.business-write-receipt/v1';
  consumerId: string;
  commandId: string;
  idempotencyKey: string;
  status: 'COMMITTED';
  operationCount: number;
  committedAt: string;
};

function firestoreRef(resource: BusinessResource, id: string, parentId?: string) {
  const db = getFirestore(getBusinessFirebaseApp(resource.target));
  if (resource.nestedUnder) {
    const parent = assertBusinessId(parentId, 'parent_id');
    return db.collection(resource.nestedUnder).doc(parent)
      .collection(resource.collectionOrRoot).doc(assertBusinessId(id));
  }
  return db.collection(resource.collectionOrRoot).doc(assertBusinessId(id));
}

function rtdbRef(resource: BusinessResource, id?: string, parentId?: string) {
  const db = getDatabase(getBusinessFirebaseApp(resource.target));
  const segments = [resource.collectionOrRoot];
  if (parentId) segments.push(assertBusinessId(parentId, 'parent_id'));
  if (id) segments.push(assertBusinessId(id));
  return db.ref(segments.join('/'));
}

function plain(value: unknown): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object') {
    const candidate = value as { toMillis?: () => number; toDate?: () => Date };
    if (typeof candidate.toMillis === 'function') {
      try { return candidate.toMillis(); } catch { /* fall through */ }
    }
    if (typeof candidate.toDate === 'function') {
      try { return candidate.toDate().toISOString(); } catch { /* fall through */ }
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, plain(item)])
    );
  }
  return String(value);
}

export class FirebaseBusinessStore {
  async read(input: BusinessReadRequest) {
    const resource = resolveBusinessResource(input.consumerId, input.resource, 'READ');
    if (!resource) throw new Error('BUSINESS_RESOURCE_READ_FORBIDDEN');

    if (resource.backend === 'RTDB') {
      const snap = await rtdbRef(resource, input.id, input.parentId).get();
      return {
        contract: 'freepass-data.business-read/v1' as const,
        consumerId: input.consumerId,
        resource: resource.name,
        data: snap.exists() ? plain(snap.val()) : null,
        readAt: new Date().toISOString(),
      };
    }

    if (input.id) {
      const snap = await firestoreRef(resource, input.id, input.parentId).get();
      return {
        contract: 'freepass-data.business-read/v1' as const,
        consumerId: input.consumerId,
        resource: resource.name,
        data: snap.exists ? { id: snap.id, ...(plain(snap.data()) as Record<string, unknown>) } : null,
        readAt: snap.readTime.toDate().toISOString(),
      };
    }

    const db = getFirestore(getBusinessFirebaseApp(resource.target));
    const limit = Math.max(1, Math.min(Number(input.limit ?? 500), 2000));
    const query = resource.nestedUnder
      ? (() => {
          const parent = assertBusinessId(input.parentId, 'parent_id');
          return db.collection(resource.nestedUnder).doc(parent)
            .collection(resource.collectionOrRoot).limit(limit);
        })()
      : db.collection(resource.collectionOrRoot).limit(limit);
    const snap = await query.get();
    return {
      contract: 'freepass-data.business-read/v1' as const,
      consumerId: input.consumerId,
      resource: resource.name,
      data: snap.docs.map((doc) => ({ id: doc.id, ...(plain(doc.data()) as Record<string, unknown>) })),
      readAt: snap.readTime.toDate().toISOString(),
    };
  }

  async write(input: BusinessWriteRequest): Promise<BusinessWriteReceipt> {
    if (!input.commandId.trim() || !input.idempotencyKey.trim() || !input.reason.trim()) {
      throw new Error('BUSINESS_COMMAND_EVIDENCE_REQUIRED');
    }
    if (!input.operations.length || input.operations.length > 100) {
      throw new Error('BUSINESS_COMMAND_OPERATION_COUNT_INVALID');
    }

    const resolved = input.operations.map((operation) => {
      const resource = resolveBusinessResource(input.consumerId, operation.resource, 'WRITE');
      if (!resource) throw new Error('BUSINESS_RESOURCE_WRITE_FORBIDDEN');
      return { operation, resource };
    });
    const backends = new Set(resolved.map((item) => item.resource.backend));
    const targets = new Set(resolved.map((item) => item.resource.target));
    if (backends.size !== 1 || targets.size !== 1) {
      throw new Error('BUSINESS_COMMAND_MIXED_BACKEND_FORBIDDEN');
    }

    const buildReceipt = (): BusinessWriteReceipt => ({
      contract: 'freepass-data.business-write-receipt/v1',
      consumerId: input.consumerId,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      status: 'COMMITTED',
      operationCount: input.operations.length,
      committedAt: new Date().toISOString(),
    });

    if (resolved[0]!.resource.backend === 'RTDB') {
      const root = getDatabase(getBusinessFirebaseApp(resolved[0]!.resource.target)).ref();
      const receiptRef = root.child('_freepass_data_command_receipts')
        .child(encodeURIComponent(input.consumerId))
        .child(encodeURIComponent(input.idempotencyKey));
      const committed = await receiptRef.transaction((current) => {
        if (current) return;
        return {
          state: 'CLAIMED',
          commandId: input.commandId,
          idempotencyKey: input.idempotencyKey,
          claimedAt: new Date().toISOString(),
        };
      }, undefined, false);
      if (!committed.committed) {
        const current = committed.snapshot.val() as BusinessWriteReceipt | { receipt?: BusinessWriteReceipt } | null;
        const existing = current && 'receipt' in current ? current.receipt : current;
        if (existing && (existing as BusinessWriteReceipt).contract === 'freepass-data.business-write-receipt/v1') {
          return existing as BusinessWriteReceipt;
        }
        throw new Error('BUSINESS_COMMAND_IN_PROGRESS');
      }

      const receipt = buildReceipt();
      const updates: Record<string, unknown> = {};
      for (const { operation, resource } of resolved) {
        const segments = [resource.collectionOrRoot];
        if (operation.parentId) segments.push(assertBusinessId(operation.parentId, 'parent_id'));
        segments.push(assertBusinessId(operation.id));
        const key = segments.join('/');
        if (operation.action === 'DELETE') updates[key] = null;
        else if (operation.action === 'PATCH') {
          for (const [field, value] of Object.entries(operation.data ?? {})) {
            if (!field || field.includes('/') || field === '__proto__') throw new Error('BUSINESS_FIELD_INVALID');
            updates[`${key}/${field}`] = value;
          }
        } else {
          updates[key] = operation.data ?? {};
        }
      }
      updates[`_freepass_data_command_receipts/${encodeURIComponent(input.consumerId)}/${encodeURIComponent(input.idempotencyKey)}`] = {
        state: 'COMMITTED',
        receipt,
      };
      await root.update(updates);
      return receipt;
    }

    const db = getFirestore(getBusinessFirebaseApp(resolved[0]!.resource.target));
    const receiptRef = db.collection('_freepass_data_command_receipts')
      .doc(encodeURIComponent(`${input.consumerId}:${input.idempotencyKey}`));
    return db.runTransaction(async (tx) => {
      const existing = await tx.get(receiptRef);
      if (existing.exists) {
        const stored = existing.data()?.receipt as BusinessWriteReceipt | undefined;
        if (!stored || stored.commandId !== input.commandId) {
          throw new Error('BUSINESS_IDEMPOTENCY_CONFLICT');
        }
        return stored;
      }

      for (const { operation, resource } of resolved) {
        const ref = firestoreRef(resource, operation.id, operation.parentId);
        if (operation.action === 'CREATE') tx.create(ref, operation.data ?? {});
        else if (operation.action === 'SET') tx.set(ref, operation.data ?? {});
        else if (operation.action === 'PATCH') tx.update(ref, operation.data ?? {});
        else tx.delete(ref);
      }
      const receipt = buildReceipt();
      tx.create(receiptRef, {
        consumerId: input.consumerId,
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        receipt,
      });
      return receipt;
    });
  }
}


  async readAsset(input: {
    consumerId: string;
    resource: string;
    id: string;
    parentId?: string;
  }) {
    const resource = resolveBusinessResource(input.consumerId, input.resource, 'READ');
    if (!resource || resource.backend !== 'STORAGE') throw new Error('BUSINESS_ASSET_READ_FORBIDDEN');
    const segments = [resource.collectionOrRoot];
    if (input.parentId) segments.push(assertBusinessId(input.parentId, 'parent_id'));
    segments.push(assertBusinessId(input.id));
    const objectName = segments.join('/');
    const file = getStorage(getBusinessFirebaseApp(resource.target)).bucket().file(objectName);
    const [exists] = await file.exists();
    if (!exists) throw new Error('BUSINESS_ASSET_NOT_FOUND');
    const [[bytes], [metadata]] = await Promise.all([file.download(), file.getMetadata()]);
    return {
      bytes,
      meta: {
        contract: 'freepass-data.business-asset/v1' as const,
        consumerId: input.consumerId,
        resource: resource.name,
        id: input.id,
        size: bytes.length,
        contentType: metadata.contentType || 'application/octet-stream',
        digest: createHash('sha256').update(bytes).digest('hex'),
      },
    };
  }

  async writeAsset(input: {
    consumerId: string;
    resource: string;
    id: string;
    parentId?: string;
    contentType: string;
    bytes: Buffer;
  }) {
    const resource = resolveBusinessResource(input.consumerId, input.resource, 'WRITE');
    if (!resource || resource.backend !== 'STORAGE') throw new Error('BUSINESS_ASSET_WRITE_FORBIDDEN');
    if (!input.bytes.length || input.bytes.length > 32 * 1024 * 1024) throw new Error('BUSINESS_ASSET_SIZE_INVALID');
    const segments = [resource.collectionOrRoot];
    if (input.parentId) segments.push(assertBusinessId(input.parentId, 'parent_id'));
    segments.push(assertBusinessId(input.id));
    const objectName = segments.join('/');
    const digest = createHash('sha256').update(input.bytes).digest('hex');
    const file = getStorage(getBusinessFirebaseApp(resource.target)).bucket().file(objectName);
    await file.save(input.bytes, {
      resumable: false,
      validation: 'crc32c',
      metadata: {
        contentType: input.contentType || 'application/octet-stream',
        metadata: {
          freepassDataDigest: digest,
          freepassDataConsumer: input.consumerId,
        },
      },
    });
    return {
      contract: 'freepass-data.business-asset-write-receipt/v1' as const,
      consumerId: input.consumerId,
      resource: resource.name,
      id: input.id,
      size: input.bytes.length,
      digest,
      committedAt: new Date().toISOString(),
    };
  }

export function createFirebaseBusinessStore() {
  return new FirebaseBusinessStore();
}
