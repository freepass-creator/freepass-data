import { describe, expect, it } from 'vitest';
import type { Firestore } from 'firebase-admin/firestore';
import { createConsumerGateway, type ConsumerBinding } from '../src/api/consumer-gateway.js';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import {
  AdminWorkflowReplacementDropsFieldsError,
  adminWorkflowStore,
} from '../src/infra/admin-workflow-firestore.js';
import {
  assertAdminWorkflowCommitRequest,
  droppedTopLevelFields,
  type AdminWorkflowCommitRequest,
  type AdminWorkflowMutation,
} from '../src/domain/admin-workflow.js';
import type { AdminWorkflowStore } from '../src/ports/admin-workflow.js';
import { FIRESTORE_COLLECTIONS } from '../src/infra/firestore-layout.js';

const C = FIRESTORE_COLLECTIONS.legacyAdminWorkflow;

type Write = { op: string; path: string; data: Record<string, unknown>; merge?: boolean };

/** Minimal transactional Firestore double: enough for doc reads and writes. */
function fakeFirestore(initial: Record<string, Record<string, unknown>>) {
  const docs = new Map(Object.entries(initial));
  const writes: Write[] = [];
  const ref = (path: string) => ({ path });
  const db = {
    collection: (name: string) => ({ doc: (id: string) => ref(`${name}/${id}`) }),
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>) {
      const pending: Write[] = [];
      const tx = {
        async get({ path }: { path: string }) {
          if (pending.length) throw new Error('read after write');
          const data = docs.get(path);
          return { id: path.split('/').pop(), exists: data !== undefined, data: () => data };
        },
        set({ path }: { path: string }, data: Record<string, unknown>, options?: { merge?: boolean }) {
          pending.push({ op: 'set', path, data, ...(options?.merge ? { merge: true } : {}) });
        },
        update({ path }: { path: string }, data: Record<string, unknown>) { pending.push({ op: 'update', path, data }); },
        create({ path }: { path: string }, data: Record<string, unknown>) { pending.push({ op: 'create', path, data }); },
      };
      const result = await fn(tx);
      writes.push(...pending);
      return result;
    },
  };
  return { db: db as unknown as Firestore, writes };
}

const request = (mutations: AdminWorkflowMutation[]): AdminWorkflowCommitRequest => ({
  operationId: 'op-replace',
  actor: 'freepass-admin-runtime',
  purpose: 'replacement write test',
  expectations: [],
  mutations,
});
const dataWrites = (writes: Write[]) => writes.filter((write) => !write.path.startsWith(`${C.receipts}/`));

describe('Admin workflow whole-document replacement keeps stored fields', () => {
  it('lists only top-level fields missing from the replacement', () => {
    expect(droppedTopLevelFields({ a: 1, b: null, c: { x: 1 } }, { a: 2, b: null, c: {} })).toEqual([]);
    expect(droppedTopLevelFields({ a: 1, b: 2, c: 3 }, { a: 1 })).toEqual(['b', 'c']);
  });

  it('rejects a replacement that shares its document with another mutation', () => {
    expect(() => assertAdminWorkflowCommitRequest(request([
      { op: 'update', resource: 'settlementInvoices', id: 'inv-1', data: { extra: true } },
      { op: 'set', resource: 'settlementInvoices', id: 'inv-1', data: { total: 1 } },
    ]))).toThrow('INVALID_ADMIN_WORKFLOW_REPLACEMENT_NOT_EXCLUSIVE');
    expect(() => assertAdminWorkflowCommitRequest(request([
      { op: 'update', resource: 'settlementRows', id: 'row-1', data: { a: 1 } },
      { op: 'update', resource: 'settlementRows', id: 'row-1', data: { b: 1 } },
      { op: 'set', resource: 'settlementRows', id: 'row-2', data: { a: 1 }, merge: true },
      { op: 'set', resource: 'settlementRows', id: 'row-2', data: { b: 1 }, merge: true },
    ]))).not.toThrow();
  });

  it('allows an invoice reissue that spreads the stored invoice and appends history', async () => {
    const invoices = C.settlementInvoices;
    const stored = { invoiceNo: 'S-1', supply: 100, vat: 10, response: { ok: true }, link: 'l' };
    const next = { ...stored, supply: 200, vat: 20, response: null, history: [{ supply: 100, vat: 10 }] };
    const { db, writes } = fakeFirestore({ [`${invoices}/inv-1`]: stored });
    await adminWorkflowStore(db).commit('freepass-admin-catalog', request([
      { op: 'set', resource: 'settlementInvoices', id: 'inv-1', data: next },
    ]));
    expect(dataWrites(writes)).toEqual([{ op: 'set', path: `${invoices}/inv-1`, data: next }]);
  });

  it('allows an event rerun with the same top-level keys and a first write to a new document', async () => {
    const events = C.esignEvents;
    const event = { contractId: 'c-1', sessionId: 's-1', type: 'contract_cancelled', by: 'a', at: 1, detail: { reason: 'r' } };
    const { db, writes } = fakeFirestore({ [`${events}/evt-1`]: event });
    await adminWorkflowStore(db).commit('freepass-admin-catalog', request([
      { op: 'set', resource: 'esignEvents', id: 'evt-1', data: { ...event, at: 2 } },
      { op: 'set', resource: 'esignEvents', id: 'evt-new', data: { contractId: 'c-2' } },
    ]));
    expect(dataWrites(writes).map((write) => write.path)).toEqual([`${events}/evt-1`, `${events}/evt-new`]);
  });

  it('refuses the whole command when a replacement drops a stored field, including keys lost as undefined', async () => {
    const rows = C.settlementRows;
    const contracts = C.contracts;
    const { db, writes } = fakeFirestore({ [`${rows}/row-1`]: { code: 'row-1', amount: 5, contractNo: 'C-1' } });
    // JSON transport drops undefined values before the gateway sees them.
    const data = JSON.parse(JSON.stringify({ code: 'row-1', amount: 6, contractNo: undefined }));
    const failure = await adminWorkflowStore(db).commit('freepass-admin-catalog', request([
      { op: 'update', resource: 'contracts', id: 'contract-1', data: { touched: true } },
      { op: 'set', resource: 'settlementRows', id: 'row-1', data },
    ])).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AdminWorkflowReplacementDropsFieldsError);
    expect(failure).toMatchObject({ code: 'ADMIN_WORKFLOW_REPLACEMENT_DROPS_FIELDS', resource: 'settlementRows', droppedFields: ['contractNo'] });
    expect(writes.filter((write) => write.path.startsWith(contracts) || write.path.startsWith(rows))).toEqual([]);
  });
});

describe('Admin workflow gateway replacement responses', () => {
  const token = 'admin-workflow-token-0123456789abcdef';
  const binding: ConsumerBinding = { id: 'freepass-admin-catalog', projectionId: 'admin-catalog', token, capabilities: ['catalog', 'admin-workflow'] };
  const serve = (store: AdminWorkflowStore) => createConsumerGateway(
    new MemoryDataStore(), [binding], new DataAccessGateway(new MemoryDataAccessLogStore()), undefined, undefined, store,
  );
  const commit = (server: ReturnType<typeof serve>, mutations: AdminWorkflowMutation[]) => server.inject({
    method: 'POST',
    url: '/v1/consumers/freepass-admin-catalog/admin-workflow/commit',
    headers: { authorization: `Bearer ${token}` },
    payload: request(mutations),
  });

  it('answers 409 with the dropped field names', async () => {
    const server = serve({
      async read() { throw new Error('not used'); },
      async commit() { throw new AdminWorkflowReplacementDropsFieldsError('settlementRows', ['contractNo']); },
    });
    const response = await commit(server, [{ op: 'set', resource: 'settlementRows', id: 'row-1', data: { code: 'row-1' } }]);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: 'ADMIN_WORKFLOW_REPLACEMENT_DROPS_FIELDS', resource: 'settlementRows', droppedFields: ['contractNo'] });
    await server.close();
  });

  it('answers 400 before any write when a replacement is not exclusive', async () => {
    let commits = 0;
    const server = serve({
      async read() { throw new Error('not used'); },
      async commit() { commits += 1; throw new Error('must not execute'); },
    });
    const response = await commit(server, [
      { op: 'update', resource: 'settlementRows', id: 'row-1', data: { a: 1 } },
      { op: 'set', resource: 'settlementRows', id: 'row-1', data: { b: 1 } },
    ]);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'INVALID_ADMIN_WORKFLOW_REPLACEMENT_NOT_EXCLUSIVE' });
    expect(commits).toBe(0);
    await server.close();
  });
});
