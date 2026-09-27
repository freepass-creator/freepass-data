import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const MASTER = 'pyh@teamjpk.com';
process.env.DASHBOARD_MASTER_ID = MASTER;
process.env.DASHBOARD_FIREBASE_WEB_API_KEY = 'test-web-key';
process.env.DASHBOARD_FIREBASE_AUTH_DOMAIN = 'test.firebaseapp.com';
process.env.DASHBOARD_FIREBASE_PROJECT_ID = 'test-project';

const accounts = new Map();
/** Stands in for Firebase: "token" → the identity it verifies to, or null. */
const tokens = new Map();

mock.module('../dashboard/api/_lib/identity.mjs', {
  namedExports: {
    verifyBearer: async (header) => {
      const match = /^Bearer (.+)$/.exec(String(header ?? '').trim());
      return match ? (tokens.get(match[1]) ?? null) : null;
    }
  }
});

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

function call(method, path, { token, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    headers: token ? { authorization: `Bearer ${token}` } : {},
    query: { path: path.split('/') },
    async *[Symbol.asyncIterator]() { yield* chunks; }
  };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      end(text) { resolve({ status: this.statusCode, body: text ? JSON.parse(text) : {} }); }
    };
    handler(req, res);
  });
}

const signedIn = (email, { verified = true } = {}) => {
  const token = `tok-${email}-${verified}`;
  tokens.set(token, { uid: `uid-${email}`, email, emailVerified: verified });
  return token;
};

async function masterToken() {
  const token = signedIn(MASTER);
  await call('POST', 'register', { token });
  return token;
}

test.beforeEach(() => {
  accounts.clear();
  tokens.clear();
});

test('the master registers and is approved without anyone approving it', async () => {
  const token = signedIn(MASTER);
  const created = await call('POST', 'register', { token });
  assert.equal(created.status, 201);
  assert.equal(created.body.account.status, 'APPROVED');
  assert.equal(created.body.account.role, 'MASTER');
  assert.equal((await call('GET', 'audit', { token })).status, 200);
});

test('a new account is pending and reads nothing until the master approves', async () => {
  const master = await masterToken();
  const staff = signedIn('staff@teamjpk.com');

  const registered = await call('POST', 'register', { token: staff });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.account.status, 'PENDING');

  const blocked = await call('GET', 'audit', { token: staff });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, 'APPROVAL_PENDING');

  assert.equal((await call('POST', 'accounts/decide', {
    token: master,
    body: { id: 'staff@teamjpk.com', decision: 'APPROVED' }
  })).status, 200);

  const allowed = await call('GET', 'audit', { token: staff });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.snapshot.source.projectId, 'freepasserp5');
});

test('revoking an account takes its access away again', async () => {
  const master = await masterToken();
  const staff = signedIn('staff@teamjpk.com');
  await call('POST', 'register', { token: staff });
  await call('POST', 'accounts/decide', { token: master, body: { id: 'staff@teamjpk.com', decision: 'APPROVED' } });
  assert.equal((await call('GET', 'audit', { token: staff })).status, 200);

  await call('POST', 'accounts/decide', { token: master, body: { id: 'staff@teamjpk.com', decision: 'REJECTED' } });
  assert.equal((await call('GET', 'audit', { token: staff })).status, 403);
});

test('an unverified email cannot register, read or claim the master id', async () => {
  const unverified = signedIn(MASTER, { verified: false });
  for (const [method, path] of [['POST', 'register'], ['GET', 'me'], ['GET', 'audit'], ['GET', 'accounts']]) {
    const res = await call(method, path, { token: unverified });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.body.error, 'EMAIL_NOT_VERIFIED');
  }
  assert.equal(accounts.size, 0, 'nothing may be written for an unverified address');
});

test('no token and a token Firebase refuses are both turned away', async () => {
  await masterToken();
  for (const token of [undefined, 'unknown-token']) {
    for (const [method, path] of [['GET', 'audit'], ['GET', 'me'], ['GET', 'accounts'], ['POST', 'register']]) {
      const res = await call(method, path, { token });
      assert.equal(res.status, 401, `${method} ${path} with ${String(token)}`);
      assert.equal(res.body.error, 'SIGN_IN_REQUIRED');
    }
  }
});

test('a member cannot list or approve, and cannot approve itself', async () => {
  const master = await masterToken();
  const staff = signedIn('staff@teamjpk.com');
  await call('POST', 'register', { token: staff });
  await call('POST', 'accounts/decide', { token: master, body: { id: 'staff@teamjpk.com', decision: 'APPROVED' } });

  assert.equal((await call('GET', 'accounts', { token: staff })).status, 403);
  const escalation = await call('POST', 'accounts/decide', {
    token: staff,
    body: { id: 'staff@teamjpk.com', decision: 'APPROVED' }
  });
  assert.equal(escalation.status, 403);
  assert.equal(escalation.body.error, 'MASTER_ONLY');
});

test('the master cannot be demoted through the decision endpoint', async () => {
  const master = await masterToken();
  const attempt = await call('POST', 'accounts/decide', { token: master, body: { id: MASTER, decision: 'REJECTED' } });
  assert.equal(attempt.status, 400);
  assert.equal((await call('GET', 'audit', { token: master })).status, 200);
});

test('re-registering cannot reset an existing authority record', async () => {
  const master = await masterToken();
  const staff = signedIn('staff@teamjpk.com');
  await call('POST', 'register', { token: staff });
  await call('POST', 'accounts/decide', { token: master, body: { id: 'staff@teamjpk.com', decision: 'REJECTED' } });

  const again = await call('POST', 'register', { token: staff });
  assert.equal(again.status, 200);
  assert.equal(again.body.account.status, 'REJECTED', 'a rejected account must not be able to re-register itself clean');
  assert.equal((await call('GET', 'audit', { token: staff })).status, 403);
});

test('a signed-in stranger with no record cannot read data', async () => {
  await masterToken();
  const stranger = signedIn('stranger@elsewhere.com');
  const res = await call('GET', 'audit', { token: stranger });
  assert.equal(res.status, 403);
  assert.equal(res.body.status, 'UNREGISTERED');
});

test('decisions reject unknown accounts and malformed input', async () => {
  const master = await masterToken();
  assert.equal((await call('POST', 'accounts/decide', { token: master, body: { id: 'ghost@teamjpk.com', decision: 'APPROVED' } })).status, 404);
  for (const body of [{ id: 'staff@teamjpk.com', decision: 'MAYBE' }, { id: 'not-an-email', decision: 'APPROVED' }, {}]) {
    assert.equal((await call('POST', 'accounts/decide', { token: master, body })).status, 400, JSON.stringify(body));
  }
});

test('no response carries a credential and the web config grants nothing', async () => {
  const master = await masterToken();
  const config = await call('GET', 'config');
  assert.equal(config.status, 200);
  assert.equal(config.body.firebase.apiKey, 'test-web-key');
  assert.equal(JSON.stringify(config.body).includes('private_key'), false);

  for (const res of [
    await call('GET', 'me', { token: master }),
    await call('GET', 'accounts', { token: master }),
    await call('GET', 'audit', { token: master })
  ]) {
    const text = JSON.stringify(res.body);
    for (const forbidden of ['passwordHash', 'scrypt', 'private_key', 'serviceAccount']) {
      assert.equal(text.includes(forbidden), false, forbidden);
    }
  }
});

test('unknown routes and oversized bodies fail closed', async () => {
  const master = await masterToken();
  assert.equal((await call('GET', 'nope', { token: master })).status, 404);
  assert.equal((await call('POST', 'accounts/decide', { token: master, body: { id: 'x'.repeat(9000) } })).status, 400);
});
