import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountView,
  canReadData,
  clearedCookie,
  isLockedOut,
  MAX_FAILED_ATTEMPTS,
  nextFailureState,
  normalizeAccountId,
  readCookie,
  readSession,
  sessionCookie,
  SESSION_TTL_SECONDS,
  signSession,
  hashPassword,
  validatePassword,
  verifyPassword
} from '../dashboard/api/_lib/auth.mjs';

const SECRET = 'x'.repeat(48);
const OTHER = 'y'.repeat(48);

test('account ids collapse to one identity and reject junk', () => {
  assert.equal(normalizeAccountId('  JPK@Example.COM '), 'jpk@example.com');
  assert.equal(normalizeAccountId('operator1'), 'operator1');
  for (const bad of ['', 'ab', null, 42, 'a b', '  ', '@nope.com', 'x'.repeat(200), '<script>alert(1)</script>']) {
    assert.equal(normalizeAccountId(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('weak passwords are refused before anything is stored', () => {
  assert.equal(validatePassword('correct-horse-9'), null);
  assert.equal(validatePassword('short1'), 'PASSWORD_TOO_SHORT');
  assert.equal(validatePassword('alllettersonly'), 'PASSWORD_NEEDS_LETTER_AND_DIGIT');
  assert.equal(validatePassword('1234567890'), 'PASSWORD_NEEDS_LETTER_AND_DIGIT');
  assert.equal(validatePassword(undefined), 'PASSWORD_REQUIRED');
});

test('password hashes are salted, never reversible and verify only the right password', async () => {
  const password = 'correct-horse-9';
  const a = await hashPassword(password);
  const b = await hashPassword(password);
  assert.notEqual(a, b, 'same password must not produce the same stored value');
  assert.ok(!a.includes(password), 'stored value must not contain the password');
  assert.ok(a.startsWith('scrypt$'));
  assert.equal(await verifyPassword(password, a), true);
  assert.equal(await verifyPassword(password, b), true);
  assert.equal(await verifyPassword('correct-horse-8', a), false);
  assert.equal(await verifyPassword('', a), false);
});

test('malformed or downgraded hashes never verify', async () => {
  for (const stored of [null, '', 'plaintext', 'scrypt$1$1$1$c2FsdA$aGFzaA', 'scrypt$16384$8$1$onlyfour', 'bcrypt$x$y$z$a$b']) {
    assert.equal(await verifyPassword('correct-horse-9', stored), false, `must reject ${String(stored)}`);
  }
});

test('session survives a round trip and carries an expiry', () => {
  const now = 1_800_000_000;
  const token = signSession({ sub: 'jpk@example.com' }, SECRET, now);
  const body = readSession(token, SECRET, now);
  assert.equal(body.sub, 'jpk@example.com');
  assert.equal(body.exp, now + SESSION_TTL_SECONDS);
});

test('tampered, foreign-signed and expired sessions are rejected', () => {
  const now = 1_800_000_000;
  const token = signSession({ sub: 'jpk@example.com' }, SECRET, now);
  assert.equal(readSession(token, OTHER, now), null, 'another secret must not validate');
  assert.equal(readSession(token, SECRET, now + SESSION_TTL_SECONDS + 1), null, 'expired must not validate');
  const [payload, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'attacker', exp: now + 999999 })).toString('base64url');
  assert.equal(readSession(`${forged}.${mac}`, SECRET, now), null, 'swapped payload must not validate');
  assert.equal(readSession(`${payload}.${Buffer.from('nope').toString('base64url')}`, SECRET, now), null);
  for (const junk of ['', 'no-dot', 'a.b.c', null, 'ey.ey']) {
    assert.equal(readSession(junk, SECRET, now), null, `must reject ${String(junk)}`);
  }
});

test('a short secret cannot be used to mint sessions', () => {
  assert.throws(() => signSession({ sub: 'x' }, 'too-short', 1), /WEAK_SESSION_SECRET/);
  assert.equal(readSession('anything', 'too-short'), null);
});

test('session cookie is httpOnly, strict and secure', () => {
  const cookie = sessionCookie('token-value');
  assert.match(cookie, /^fpd_session=token-value;/);
  for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/']) assert.ok(cookie.includes(flag), flag);
  assert.ok(!sessionCookie('t', { secure: false }).includes('Secure'));
  assert.match(clearedCookie(), /Max-Age=0/);
});

test('cookie parsing picks the right pair and ignores the rest', () => {
  assert.equal(readCookie('a=1; fpd_session=abc; b=2'), 'abc');
  assert.equal(readCookie('fpd_session_other=abc'), null);
  assert.equal(readCookie('fpd_session='), null);
  assert.equal(readCookie(undefined), null);
});

test('repeated failures lock the account, and a lockout is honoured', () => {
  const now = 1_800_000_000;
  let state = { failedAttempts: 0 };
  for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
    state = nextFailureState(state, now);
    assert.equal(state.lockedUntil, 0, `attempt ${i} must not lock yet`);
  }
  state = nextFailureState(state, now);
  assert.ok(state.lockedUntil > now, 'final attempt must lock');
  assert.equal(isLockedOut(state, now), true);
  assert.equal(isLockedOut(state, state.lockedUntil + 1), false, 'lockout must expire');
  assert.equal(isLockedOut({ failedAttempts: 3 }, now), false);
});

test('only approved accounts read data, and the master approves itself', () => {
  const master = 'jpk@example.com';
  const pending = { id: 'new@example.com', status: 'PENDING', createdAt: 't0' };
  assert.equal(canReadData(accountView(pending, master)), false);
  assert.equal(canReadData(accountView({ ...pending, status: 'APPROVED' }, master)), true);
  assert.equal(canReadData(accountView({ ...pending, status: 'REJECTED' }, master)), false);
  assert.equal(canReadData(null), false);

  // The master must not be able to lock itself out by never being approved.
  const masterAccount = { id: master, status: 'PENDING', createdAt: 't0' };
  const view = accountView(masterAccount, master);
  assert.equal(view.role, 'MASTER');
  assert.equal(view.status, 'APPROVED');
  assert.equal(canReadData(view), true);
});

test('account view never exposes the stored password hash', async () => {
  const account = {
    id: 'a@b.com',
    status: 'APPROVED',
    createdAt: 't0',
    passwordHash: await hashPassword('correct-horse-9'),
    failedAttempts: 2
  };
  const view = accountView(account, 'master@b.com');
  assert.equal(JSON.stringify(view).includes('scrypt$'), false);
  assert.equal(view.passwordHash, undefined);
  assert.equal(view.failedAttempts, undefined);
});
