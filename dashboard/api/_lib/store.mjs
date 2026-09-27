import { getFirestore } from 'firebase-admin/firestore';
import { adminApp } from './firebase.mjs';

const COLLECTION = 'identity_accounts';

const db = () => getFirestore(adminApp());

export async function getAccount(id) {
  const snap = await db().collection(COLLECTION).doc(id).get();
  return snap.exists ? { id, ...snap.data() } : null;
}

export async function listAccounts(limit = 200) {
  const snap = await db().collection(COLLECTION).orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

/** Refuses to overwrite, so a second registration cannot reset an existing authority. */
export async function createAccount(id, fields) {
  await db().collection(COLLECTION).doc(id).create({ ...fields, id });
}

export async function updateAccount(id, fields) {
  await db().collection(COLLECTION).doc(id).update(fields);
}

export function isAlreadyExists(error) {
  return error?.code === 6 || /ALREADY_EXISTS/i.test(String(error?.message ?? ''));
}
