import { getFirestore } from 'firebase-admin/firestore';
import { getTargetFirebaseApp } from './firebase-target.js';

/** READ-ONLY: fetch whole documents by id (getAll). No write call of any kind lives in this module. */
export async function readCanonDocuments(collection: 'products' | 'policy', ids: string[]): Promise<Record<string, Record<string, unknown>>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const db = getFirestore(getTargetFirebaseApp());
  const refs = unique.map((id) => db.collection(collection).doc(id));
  const snaps = await db.getAll(...refs);
  return Object.fromEntries(snaps.map((snap, index) => [unique[index]!, snap.exists ? snap.data() ?? {} : {}]));
}
