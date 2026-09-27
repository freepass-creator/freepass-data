import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accountView,
  APPLICATION,
  canEnter,
  decisionRecord,
  normalizeAccountId,
  pendingRecord
} from '../dashboard/api/_lib/authority.mjs';

const MASTER = 'pyh@teamjpk.com';

test('ids collapse to one identity and non-addresses are refused', () => {
  assert.equal(normalizeAccountId('  PYH@TeamJPK.com '), MASTER);
  for (const bad of ['operator1', '', 'ab', null, 42, 'a b@x.com', '@nope.com', 'x'.repeat(200), 'a@b']) {
    assert.equal(normalizeAccountId(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('a fresh account is pending with no grant', () => {
  const record = pendingRecord('staff@teamjpk.com', MASTER, 't0');
  assert.equal(record.status, 'PENDING');
  assert.deepEqual(record.grants, []);
  assert.equal(record.approvedBy, null);
  assert.equal(canEnter(accountView(record, MASTER)), false);
});

test('the master is approved and granted by definition', () => {
  const record = pendingRecord(MASTER, MASTER, 't0');
  assert.equal(record.status, 'APPROVED');
  const view = accountView(record, MASTER);
  assert.equal(view.role, 'MASTER');
  assert.equal(canEnter(view), true);

  // Even a record stored as pending must still resolve to an approved master.
  const stale = accountView({ id: MASTER, status: 'PENDING', grants: [], createdAt: 't0' }, MASTER);
  assert.equal(stale.status, 'APPROVED');
  assert.equal(canEnter(stale), true);
});

test('approval alone is not entry: the grant is separate', () => {
  const approvedElsewhere = { id: 'staff@teamjpk.com', status: 'APPROVED', grants: ['freepass-admin'], createdAt: 't0' };
  const view = accountView(approvedElsewhere, MASTER);
  assert.equal(view.status, 'APPROVED');
  assert.equal(canEnter(view, APPLICATION), false, 'no grant for this application means no entry');
  assert.equal(canEnter(view, 'freepass-admin'), true);
});

test('a decision records who granted it and revocation removes the grant', () => {
  const approved = decisionRecord('APPROVED', MASTER, 't1');
  assert.deepEqual(approved.grants, [APPLICATION]);
  assert.equal(approved.approvedBy, MASTER);
  assert.equal(canEnter(accountView({ id: 'staff@teamjpk.com', createdAt: 't0', ...approved }, MASTER)), true);

  const rejected = decisionRecord('REJECTED', MASTER, 't2');
  assert.deepEqual(rejected.grants, []);
  assert.equal(rejected.approvedBy, null);
  assert.equal(canEnter(accountView({ id: 'staff@teamjpk.com', createdAt: 't0', ...rejected }, MASTER)), false);
});

test('an unregistered or malformed account cannot enter', () => {
  assert.equal(accountView(null, MASTER), null);
  assert.equal(canEnter(null), false);
  assert.equal(canEnter(accountView({ id: 'x@y.com', status: 'APPROVED', grants: 'not-an-array' }, MASTER)), false);
});

test('no authority record carries a credential', () => {
  const record = pendingRecord(MASTER, MASTER, 't0');
  const serialized = JSON.stringify({ record, view: accountView(record, MASTER), decision: decisionRecord('APPROVED', MASTER) });
  for (const forbidden of ['password', 'passwordHash', 'scrypt', 'secret', 'token']) {
    assert.equal(serialized.includes(forbidden), false, `${forbidden} must never appear in an authority record`);
  }
});
