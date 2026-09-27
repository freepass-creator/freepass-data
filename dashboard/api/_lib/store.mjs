import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const COLLECTION = 'dashboard_accounts';

function serviceAccount() {
  const raw = process.env.DASHBOARD_FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('MISSING_DASHBOARD_FIREBASE_SERVICE_ACCOUNT_JSON');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('INVALID_SERVICE_ACCOUNT_JSON');
  }
  for (const key of ['project_id', 'client_email', 'private_key']) {
    if (typeof parsed[key] !== 'string' || !parsed[key]) throw new Error('INCOMPLETE_SERVICE_ACCOUNT_JSON');
  }
  return parsed;
}

function db() {
  if (!getApps().length) {
    const account = serviceAccount();
    initializeApp({
      credential: cert({
        projectId: account.project_id,
        clientEmail: account.client_email,
        // Vercel env values keep newlines escaped.
        privateKey: account.private_key.replace(/\\n/g, '\n')
      }),
      projectId: account.project_id
    });
  }
  return getFirestore();
}

export async function getAccount(id) {
  const snap = await db().collection(COLLECTION).doc(id).get();
  return snap.exists ? { id, ...snap.data() } : null;
}

export async function listAccounts(limit = 200) {
  const snap = await db().collection(COLLECTION).orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

/** Refuses to overwrite an existing account so registration cannot reset a password. */
export async function createAccount(id, fields) {
  await db().collection(COLLECTION).doc(id).create({ ...fields, id });
}

export async function updateAccount(id, fields) {
  await db().collection(COLLECTION).doc(id).update(fields);
}

export function isAlreadyExists(error) {
  return error?.code === 6 || /ALREADY_EXISTS/i.test(String(error?.message ?? ''));
}
