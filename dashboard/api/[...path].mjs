import { createRequire } from 'node:module';
import {
  accountView,
  canReadData,
  clearedCookie,
  hashPassword,
  isLockedOut,
  nextFailureState,
  normalizeAccountId,
  readCookie,
  readSession,
  sessionCookie,
  signSession,
  validatePassword,
  verifyPassword
} from './_lib/auth.mjs';
import { createAccount, getAccount, isAlreadyExists, listAccounts, updateAccount } from './_lib/store.mjs';

const require = createRequire(import.meta.url);
const snapshot = require('../data/audit-latest.json');

const MASTER_ID = normalizeAccountId(process.env.DASHBOARD_MASTER_ID ?? '');
const SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET ?? '';

const json = (res, status, body, cookie) => {
  if (cookie) res.setHeader('Set-Cookie', cookie);
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

async function currentView(req) {
  const token = readCookie(req.headers.cookie);
  const session = readSession(token, SESSION_SECRET);
  if (!session) return null;
  const account = await getAccount(session.sub);
  return accountView(account, MASTER_ID);
}

export default async function handler(req, res) {
  if (!MASTER_ID || SESSION_SECRET.length < 32) {
    return json(res, 503, { error: 'SERVICE_NOT_CONFIGURED' });
  }

  const route = (Array.isArray(req.query?.path) ? req.query.path : String(req.query?.path ?? '').split('/'))
    .filter(Boolean)
    .join('/');

  try {
    if (route === 'register' && req.method === 'POST') return await register(req, res);
    if (route === 'login' && req.method === 'POST') return await login(req, res);
    if (route === 'logout' && req.method === 'POST') return json(res, 200, { ok: true }, clearedCookie());
    if (route === 'me' && req.method === 'GET') return json(res, 200, { account: await currentView(req) });
    if (route === 'audit' && req.method === 'GET') return await audit(req, res);
    if (route === 'accounts' && req.method === 'GET') return await accounts(req, res);
    if (route === 'accounts/decide' && req.method === 'POST') return await decide(req, res);
    return json(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    const code = error?.message === 'BODY_TOO_LARGE' || error?.message === 'INVALID_JSON' ? 400 : 500;
    return json(res, code, { error: code === 400 ? error.message : 'INTERNAL_ERROR' });
  }
}

async function register(req, res) {
  const { id: rawId, password } = await body(req);
  const id = normalizeAccountId(rawId);
  if (!id) return json(res, 400, { error: 'INVALID_ACCOUNT_ID' });
  const weak = validatePassword(password);
  if (weak) return json(res, 400, { error: weak });

  const now = new Date().toISOString();
  const isMaster = id === MASTER_ID;
  try {
    await createAccount(id, {
      status: isMaster ? 'APPROVED' : 'PENDING',
      passwordHash: await hashPassword(password),
      createdAt: now,
      approvedAt: isMaster ? now : null,
      approvedBy: isMaster ? 'SELF_MASTER' : null,
      failedAttempts: 0,
      lockedUntil: 0
    });
  } catch (error) {
    if (isAlreadyExists(error)) return json(res, 409, { error: 'ACCOUNT_EXISTS' });
    throw error;
  }
  return json(res, 201, { status: isMaster ? 'APPROVED' : 'PENDING' });
}

async function login(req, res) {
  const { id: rawId, password } = await body(req);
  const id = normalizeAccountId(rawId);
  // Same answer for an unknown id and a wrong password so accounts cannot be enumerated.
  const reject = () => json(res, 401, { error: 'INVALID_CREDENTIALS' });
  if (!id || typeof password !== 'string') return reject();

  const account = await getAccount(id);
  if (!account) {
    await hashPassword(password); // keep the timing of a miss close to a hit
    return reject();
  }
  if (isLockedOut(account)) return json(res, 423, { error: 'TEMPORARILY_LOCKED' });

  if (!(await verifyPassword(password, account.passwordHash))) {
    await updateAccount(id, nextFailureState(account));
    return reject();
  }
  if (account.failedAttempts || account.lockedUntil) {
    await updateAccount(id, { failedAttempts: 0, lockedUntil: 0 });
  }

  const view = accountView({ ...account, failedAttempts: 0, lockedUntil: 0 }, MASTER_ID);
  return json(res, 200, { account: view }, sessionCookie(signSession({ sub: id }, SESSION_SECRET)));
}

async function audit(req, res) {
  const view = await currentView(req);
  if (!view) return json(res, 401, { error: 'SIGN_IN_REQUIRED' });
  if (!canReadData(view)) return json(res, 403, { error: 'APPROVAL_PENDING', status: view.status });
  return json(res, 200, { account: view, snapshot });
}

async function accounts(req, res) {
  const view = await currentView(req);
  if (view?.role !== 'MASTER') return json(res, 403, { error: 'MASTER_ONLY' });
  return json(res, 200, { accounts: (await listAccounts()).map((item) => accountView(item, MASTER_ID)) });
}

async function decide(req, res) {
  const view = await currentView(req);
  if (view?.role !== 'MASTER') return json(res, 403, { error: 'MASTER_ONLY' });

  const { id: rawId, decision } = await body(req);
  const id = normalizeAccountId(rawId);
  if (!id || !['APPROVED', 'REJECTED'].includes(decision)) return json(res, 400, { error: 'INVALID_DECISION' });
  if (id === MASTER_ID) return json(res, 400, { error: 'MASTER_CANNOT_BE_CHANGED' });
  if (!(await getAccount(id))) return json(res, 404, { error: 'ACCOUNT_NOT_FOUND' });

  await updateAccount(id, {
    status: decision,
    approvedAt: decision === 'APPROVED' ? new Date().toISOString() : null,
    approvedBy: decision === 'APPROVED' ? MASTER_ID : null,
    failedAttempts: 0,
    lockedUntil: 0
  });
  return json(res, 200, { id, status: decision });
}
