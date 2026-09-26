import type { DocumentSnapshot, QueryDocumentSnapshot } from 'firebase-admin/firestore';

type FirestoreSnapshot = DocumentSnapshot | QueryDocumentSnapshot;

export function decodeFirestoreDocument<T>(
  snap: FirestoreSnapshot
): T | null {
  return snap.exists ? snap.data() as T : null;
}

export function decodeFirestoreIdentityDocument<T>(
  snap: FirestoreSnapshot,
  identityField: string
): T | null {
  if (!snap.exists) return null;

  const stored = snap.data() as Record<string, unknown>;
  const payloadIdentity = stored[identityField];
  if (payloadIdentity !== undefined && payloadIdentity !== snap.id) {
    throw new Error(`Firestore document identity mismatch in ${snap.ref.parent.id}`);
  }

  return {
    ...stored,
    [identityField]: snap.id
  } as T;
}
