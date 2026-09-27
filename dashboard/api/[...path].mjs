import { createRequire } from 'node:module';
import { accountView, APPLICATION, canEnter, decisionRecord, normalizeAccountId, pendingRecord } from './_lib/authority.mjs';
import { verifyBearer } from './_lib/identity.mjs';
import { createAccount, getAccount, isAlreadyExists, listAccounts, updateAccount } from './_lib/store.mjs';

const require = createRequire(import.meta.url);
const snapshot = require('../data/audit-latest.json');

const MASTER_ID = normalizeAccountId(process.env.DASHBOARD_MASTER_ID ?? '');

const WEB_CONFIG = {
  apiKey: process.env.DASHBOARD_FIREBASE_WEB_API_KEY ?? '',
  authDomain: process.env.DASHBOARD_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: process.env.DASHBOARD_FIREBASE_PROJECT_ID ?? '',
  // Set only for local development against an emulator (docs/IDENTITY-AND-ACCESS.md §2).
  ...(process.env.DASHBOARD_FIREBASE_AUTH_EMULATOR_HOST
    ? { authEmulatorHost: process.env.DASHBOARD_FIREBASE_AUTH_EMULATOR_HOST }
    : {})
};

const json = (res, status, body) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).end(JSON.stringify(body));
};

async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('INVALID_JSON');
  }
}

/** Resolves the caller to an authority record, or a reason it cannot be resolved. */
async function caller(req) {
  const identity = await verifyBearer(req.headers.authorization);
  if (!identity) return { error: 'SIGN_IN_REQUIRED', status: 401 };
  if (!identity.emailVerified) return { error: 'EMAIL_NOT_VERIFIED', status: 403, identity };
  const id = normalizeAccountId(identity.email);
  if (!id) return { error: 'INVALID_ACCOUNT_ID', status: 400, identity };
  const account = await getAccount(id);
  return { identity, id, view: accountView(account, MASTER_ID) };
}

export default async function handler(req, res) {
  if (!MASTER_ID || !WEB_CONFIG.apiKey || !WEB_CONFIG.authDomain || !WEB_CONFIG.projectId) {
    return json(res, 503, { error: 'SERVICE_NOT_CONFIGURED' });
  }

  // URL이 정본이다. catch-all 파라미터 이름은 런타임이 정하는 것이라 거기에 기대면
  // 호스트가 바뀌는 순간 모든 경로가 조용히 404가 된다(실제로 첫 배포에서 그랬다).
  const fromUrl = String(req.url ?? '').split('?')[0].replace(/^\/+api\/?/, '');
  const fromQuery = Array.isArray(req.query?.path)
    ? req.query.path.join('/')
    : String(req.query?.path ?? '');
  const route = (fromUrl || fromQuery).split('/').filter(Boolean).join('/');

  try {
    // Public by design: the web config identifies the project, it does not grant access.
    if (route === 'config' && req.method === 'GET') return json(res, 200, { firebase: WEB_CONFIG });
    if (route === 'register' && req.method === 'POST') return await register(req, res);
    if (route === 'me' && req.method === 'GET') return await me(req, res);
    if (route === 'audit' && req.method === 'GET') return await audit(req, res);
    if (route === 'accounts' && req.method === 'GET') return await accounts(req, res);
    if (route === 'accounts/decide' && req.method === 'POST') return await decide(req, res);
    return json(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    const bad = error?.message === 'BODY_TOO_LARGE' || error?.message === 'INVALID_JSON';
    return json(res, bad ? 400 : 500, { error: bad ? error.message : 'INTERNAL_ERROR' });
  }
}

/** Creates the authority record for an already-authenticated Firebase user. */
async function register(req, res) {
  const resolved = await caller(req);
  if (resolved.error) return json(res, resolved.status, { error: resolved.error });
  if (resolved.view) return json(res, 200, { account: resolved.view });

  const record = pendingRecord(resolved.id, MASTER_ID);
  try {
    await createAccount(resolved.id, record);
  } catch (error) {
    if (isAlreadyExists(error)) return json(res, 200, { account: accountView(await getAccount(resolved.id), MASTER_ID) });
    throw error;
  }
  return json(res, 201, { account: accountView(record, MASTER_ID) });
}

async function me(req, res) {
  const resolved = await caller(req);
  if (resolved.error) return json(res, resolved.status, { error: resolved.error });
  return json(res, 200, { account: resolved.view, application: APPLICATION });
}

async function audit(req, res) {
  const resolved = await caller(req);
  if (resolved.error) return json(res, resolved.status, { error: resolved.error });
  if (!canEnter(resolved.view)) {
    return json(res, 403, { error: 'APPROVAL_PENDING', status: resolved.view?.status ?? 'UNREGISTERED' });
  }
  return json(res, 200, { account: resolved.view, snapshot });
}

async function requireMaster(req, res) {
  const resolved = await caller(req);
  if (resolved.error) {
    json(res, resolved.status, { error: resolved.error });
    return null;
  }
  if (resolved.view?.role !== 'MASTER') {
    json(res, 403, { error: 'MASTER_ONLY' });
    return null;
  }
  return resolved;
}

async function accounts(req, res) {
  if (!(await requireMaster(req, res))) return;
  return json(res, 200, { accounts: (await listAccounts()).map((item) => accountView(item, MASTER_ID)) });
}

async function decide(req, res) {
  if (!(await requireMaster(req, res))) return;

  const { id: rawId, decision } = await body(req);
  const id = normalizeAccountId(rawId);
  if (!id || !['APPROVED', 'REJECTED'].includes(decision)) return json(res, 400, { error: 'INVALID_DECISION' });
  if (id === MASTER_ID) return json(res, 400, { error: 'MASTER_CANNOT_BE_CHANGED' });
  if (!(await getAccount(id))) return json(res, 404, { error: 'ACCOUNT_NOT_FOUND' });

  await updateAccount(id, decisionRecord(decision, MASTER_ID));
  return json(res, 200, { id, status: decision });
}
