import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const MASTER = 'master@freepass.test';
const SECRET = 'z'.repeat(48);
process.env.DASHBOARD_MASTER_ID = MASTER;
process.env.DASHBOARD_SESSION_SECRET = SECRET;

const accounts = new Map();

mock.module('../dashboard/api/_lib/store.mjs', {
  namedExports: {
    getAccount: async (id) => (accounts.has(id) ? { id, ...accounts.get(id) } : null),
    listAccounts: async () => [...accounts.entries()].map(([id, value]) => ({ id, ...value })),
    createAccount: async (id, fields) => {
      if (accounts.has(id)) {
        const error = new Error('ALREADY_EXISTS');
        error.code = 6;
        throw error;
      }
      accounts.set(id, fields);
    },
    updateAccount: async (id, fields) => accounts.set(id, { ...accounts.get(id), ...fields }),
    isAlreadyExists: (error) => error?.code === 6
  }
});

const { default: handler } = await import('../dashboard/api/[...path].mjs');

function call(method, path, { body, cookie } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    headers: cookie ? { cookie } : {},
    query: { path: path.split('/') },
    async *[Symbol.asyncIterator]() { yield* chunks; }
  };
  return new Promise((resolve) => {
    const headers = {};
    const res = {
      statusCode: 200,
      setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
      status(code) { this.statusCode = code; return this; },
      end(text) {
        resolve({
          status: this.statusCode,
          headers,
          body: text ? JSON.parse(text) : {},
          cookie: headers['set-cookie']
        });
      }
    };
    handler(req, res);
  });
}

const sessionOf = (setCookie) => String(setCookie).split(';')[0];

test.beforeEach(() => accounts.clear());

test('master registers, logs in and is approved without anyone approving it', async () => {
  const created = await call('POST', 'register', { body: { id: MASTER, password: 'master-pass-1' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'APPROVED');

  const login = await call('POST', 'login', { body: { id: MASTER, password: 'master-pass-1' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.account.role, 'MASTER');
  assert.match(login.cookie, /HttpOnly/);
  assert.match(login.cookie, /SameSite=Strict/);

  const audit = await call('GET', 'audit', { cookie: sessionOf(login.cookie) });
  assert.equal(audit.status, 200);
  assert.equal(audit.body.snapshot.version, 'erp5-source-inventory/1');
});

test('a new account is pending and cannot read data until the master approves', async () => {
  await call('POST', 'register', { body: { id: MASTER, password: 'master-pass-1' } });
  const masterLogin = await call('POST', 'login', { body: { id: MASTER, password: 'master-pass-1' } });
  const masterCookie = sessionOf(masterLogin.cookie);

  const signup = await call('POST', 'register', { body: { id: 'staff@freepass.test', password: 'staff-pass-1' } });
  assert.equal(signup.status, 201);
  assert.equal(signup.body.status, 'PENDING');

  const staffLogin = await call('POST', 'login', { body: { id: 'staff@freepass.test', password: 'staff-pass-1' } });
  const staffCookie = sessionOf(staffLogin.cookie);
  const blocked = await call('GET', 'audit', { cookie: staffCookie });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, 'APPROVAL_PENDING');

  const decided = await call('POST', 'accounts/decide', {
    cookie: masterCookie,
    body: { id: 'staff@freepass.test', decision: 'APPROVED' }
  });
  assert.equal(decided.status, 200);

  const allowed = await call('GET', 'audit', { cookie: staffCookie });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.snapshot.source.projectId, 'freepasserp5');
});

test('a rejected account loses access again', async () => {
  await call('POST', 'register', { body: { id: MASTER, password: 'master-pass-1' } });
  const masterCookie = sessionOf((await call('POST', 'login', { body: { id: MASTER, password: 'master-pass-1' } })).cookie);
  await call('POST', 'register', { body: { id: 'staff@freepass.test', password: 'staff-pass-1' } });
  const staffCookie = sessionOf((await call('POST', 'login', { body: { id: 'staff@freepass.test', password: 'staff-pass-1' } })).cookie);

  await call('POST', 'accounts/decide', { cookie: masterCookie, body: { id: 'staff@freepass.test', decision: 'APPROVED' } });
  assert.equal((await call('GET', 'audit', { cookie: staffCookie })).status, 200);

  await call('POST', 'accounts/decide', { cookie: masterCookie, body: { id: 'staff@freepass.test', decision: 'REJECTED' } });
  assert.equal((await call('GET', 'audit', { cookie: staffCookie })).status, 403);
});

test('a non-master cannot list or approve accounts', async () => {
  await call('POST', 'register', { body: { id: MASTER, password: 'master-pass-1' } });
  const masterCookie = sessionOf((await call('POST', 'login', { body: { id: MASTER, password: 'master-pass-1' } })).cookie);
  await call('POST', 'register', { body: { id: 'staff@freepass.test', password: 'staff-pass-1' } });
  await call('POST', 'accounts/decide', { cookie: masterCookie, body: { id: 'staff@freepass.test', decision: 'APPROVED' } });
  const staffCookie = sessionOf((await call('POST', 'login', { body: { id: 'staff@freepass.test', password: 'staff-pass-1' } })).cookie);

  assert.equal((await call('GET', 'accounts', { cookie: staffCookie })).status, 403);
  const escalation = await call('POST', 'accounts/decide', {
    cookie: staffCookie,
    body: { id: 'staff@freepass.test', decision: 'APPROVED' }
  });
  assert.equal(escalation.status, 403);
  assert.equal(escalation.body.error, 'MASTER_ONLY');
});

test('the master account cannot be demoted through the decision endpoint', async () => {
  await call('POST', 'register', { body: { id: MASTER, password: 'master-pass-1' } });
  const masterCookie = sessionOf((await call('POST', 'login', { body: { id: MASTER, password: 'master-pass-1' } })).cookie);
  const attempt = await call('POST', 'accounts/decide', { cookie: masterCookie, body: { id: MASTER, decision: 'REJECTED' } });
  assert.equal(attempt.status, 400);
  assert.equal((await call('GET', 'audit', { cookie: masterCookie })).status, 200);
});

test('no session, a forged session and a wrong password are all refused', async () => {
  await call('POST', 'register', { body: { id: MASTER, password: 'master-pass-1' } });

  assert.equal((await call('GET', 'audit')).status, 401);
  assert.equal((await call('GET', 'audit', { cookie: 'fpd_session=forged.value' })).status, 401);

  const wrong = await call('POST', 'login', { body: { id: MASTER, password: 'master-pass-2' } });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, 'INVALID_CREDENTIALS');
  assert.equal(wrong.cookie, undefined, 'a failed login must not set a session');
});

test('an unknown id answers exactly like a wrong password', async () => {
  await call('POST', 'register', { body: { id: MASTER, password: 'master-pass-1' } });
  const unknown = await call('POST', 'login', { body: { id: 'nobody@freepass.test', password: 'master-pass-1' } });
  const wrong = await call('POST', 'login', { body: { id: MASTER, password: 'nope-12345' } });
  assert.deepEqual(unknown.body, wrong.body);
  assert.equal(unknown.status, wrong.status);
});

test('registering an existing id cannot reset its password', async () => {
  await call('POST', 'register', { body: { id: MASTER, password: 'master-pass-1' } });
  const again = await call('POST', 'register', { body: { id: MASTER, password: 'attacker-pass-9' } });
  assert.equal(again.status, 409);
  assert.equal((await call('POST', 'login', { body: { id: MASTER, password: 'attacker-pass-9' } })).status, 401);
  assert.equal((await call('POST', 'login', { body: { id: MASTER, password: 'master-pass-1' } })).status, 200);
});

test('repeated wrong passwords lock the account', async () => {
  await call('POST', 'register', { body: { id: MASTER, password: 'master-pass-1' } });
  let last;
  for (let i = 0; i < 8; i++) last = await call('POST', 'login', { body: { id: MASTER, password: `bad-pass-${i}1` } });
  assert.equal(last.status, 401);
  const locked = await call('POST', 'login', { body: { id: MASTER, password: 'master-pass-1' } });
  assert.equal(locked.status, 423, 'the correct password must still be refused while locked');
});

test('responses never carry the stored password hash', async () => {
  await call('POST', 'register', { body: { id: MASTER, password: 'master-pass-1' } });
  const masterCookie = sessionOf((await call('POST', 'login', { body: { id: MASTER, password: 'master-pass-1' } })).cookie);
  await call('POST', 'register', { body: { id: 'staff@freepass.test', password: 'staff-pass-1' } });
  for (const res of [
    await call('GET', 'me', { cookie: masterCookie }),
    await call('GET', 'accounts', { cookie: masterCookie }),
    await call('GET', 'audit', { cookie: masterCookie })
  ]) {
    assert.equal(JSON.stringify(res.body).includes('scrypt$'), false);
  }
});

test('weak passwords and junk ids never create an account', async () => {
  for (const body of [
    { id: 'ok@freepass.test', password: 'short1' },
    { id: 'ok@freepass.test', password: 'nodigitshere' },
    { id: 'no', password: 'fine-pass-12' },
    { id: '', password: 'fine-pass-12' }
  ]) {
    const res = await call('POST', 'register', { body });
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal(accounts.size, 0);
});

test('unknown routes and oversized bodies fail closed', async () => {
  assert.equal((await call('GET', 'nope')).status, 404);
  assert.equal((await call('POST', 'login', { body: { id: MASTER, password: 'x'.repeat(9000) } })).status, 400);
});
