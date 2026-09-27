import { cert, getApps, initializeApp } from 'firebase-admin/app';

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

export function adminApp() {
  const existing = getApps();
  if (existing.length) return existing[0];
  const account = serviceAccount();
  return initializeApp({
    credential: cert({
      projectId: account.project_id,
      clientEmail: account.client_email,
      // Vercel environment values keep the newlines escaped.
      privateKey: account.private_key.replace(/\\n/g, '\n')
    }),
    projectId: account.project_id
  });
}
