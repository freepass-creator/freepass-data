import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

export const SESSION_COOKIE = 'fpd_session';
export const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const MAX_FAILED_ATTEMPTS = 8;
export const LOCKOUT_SECONDS = 15 * 60;

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (text) => Buffer.from(text, 'base64url');

function equal(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Compare padded copies so a length difference cannot be read off the timing.
  const width = Math.max(left.length, right.length);
  const padLeft = Buffer.alloc(width);
  const padRight = Buffer.alloc(width);
  left.copy(padLeft);
  right.copy(padRight);
  return timingSafeEqual(padLeft, padRight) && left.length === right.length;
}

/** Account ids are lowercased so "A@b.com" and "a@b.com" cannot become two accounts. */
export function normalizeAccountId(raw) {
  if (typeof raw !== 'string') return null;
  const id = raw.trim().toLowerCase();
  if (id.length < 3 || id.length > 120) return null;
  if (!/^[a-z0-9][a-z0-9._%+-]*(@[a-z0-9.-]+\.[a-z]{2,})?$/.test(id)) return null;
  return id;
}

export function validatePassword(raw) {
  if (typeof raw !== 'string') return 'PASSWORD_REQUIRED';
  if (raw.length < 10) return 'PASSWORD_TOO_SHORT';
  if (raw.length > 200) return 'PASSWORD_TOO_LONG';
  if (!/[a-zA-Z]/.test(raw) || !/[0-9]/.test(raw)) return 'PASSWORD_NEEDS_LETTER_AND_DIGIT';
  return null;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64url(salt)}$${b64url(derived)}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, expected] = parts;
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isSafeInteger(cost.N) || !Number.isSafeInteger(cost.r) || !Number.isSafeInteger(cost.p)) return false;
  if (cost.N < 1024 || cost.r < 1 || cost.p < 1) return false;
  let derived;
  try {
    derived = await scrypt(password, fromB64url(salt), fromB64url(expected).length, cost);
  } catch {
    return false;
  }
  return equal(derived, fromB64url(expected));
}

export function signSession(payload, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('WEAK_SESSION_SECRET');
  const body = { ...payload, iat: nowSeconds, exp: nowSeconds + SESSION_TTL_SECONDS };
  const encoded = b64url(JSON.stringify(body));
  const mac = createHmac('sha256', secret).update(encoded).digest();
  return `${encoded}.${b64url(mac)}`;
}

export function readSession(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof token !== 'string' || typeof secret !== 'string' || secret.length < 32) return null;
  const dot = token.indexOf('.');
  if (dot < 1 || token.indexOf('.', dot + 1) !== -1) return null;
  const encoded = token.slice(0, dot);
  const mac = createHmac('sha256', secret).update(encoded).digest();
  if (!equal(b64url(mac), token.slice(dot + 1))) return null;
  let body;
  try {
    body = JSON.parse(fromB64url(encoded).toString('utf8'));
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  if (!Number.isSafeInteger(body.exp) || body.exp <= nowSeconds) return null;
  if (typeof body.sub !== 'string' || !body.sub) return null;
  return body;
}

export function sessionCookie(token, { secure = true } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_TTL_SECONDS}`
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedCookie({ secure = true } = {}) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function readCookie(header, name = SESSION_COOKIE) {
  if (typeof header !== 'string') return null;
  for (const piece of header.split(';')) {
    const at = piece.indexOf('=');
    if (at === -1) continue;
    if (piece.slice(0, at).trim() === name) return piece.slice(at + 1).trim() || null;
  }
  return null;
}

export function isLockedOut(account, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!account || typeof account !== 'object') return false;
  const until = account.lockedUntil;
  return Number.isSafeInteger(until) && until > nowSeconds;
}

export function nextFailureState(account, nowSeconds = Math.floor(Date.now() / 1000)) {
  const failed = (Number.isSafeInteger(account?.failedAttempts) ? account.failedAttempts : 0) + 1;
  return failed >= MAX_FAILED_ATTEMPTS
    ? { failedAttempts: 0, lockedUntil: nowSeconds + LOCKOUT_SECONDS }
    : { failedAttempts: failed, lockedUntil: 0 };
}

/**
 * Only an approved account may read data, and the master is approved by definition
 * so the first account can never be locked out of its own approval queue.
 */
export function accountView(account, masterId) {
  if (!account) return null;
  const isMaster = account.id === masterId;
  return {
    id: account.id,
    status: isMaster ? 'APPROVED' : account.status,
    role: isMaster ? 'MASTER' : 'MEMBER',
    createdAt: account.createdAt ?? null,
    approvedAt: isMaster ? (account.createdAt ?? null) : (account.approvedAt ?? null),
    approvedBy: isMaster ? 'SELF_MASTER' : (account.approvedBy ?? null)
  };
}

export function canReadData(view) {
  return !!view && view.status === 'APPROVED';
}
