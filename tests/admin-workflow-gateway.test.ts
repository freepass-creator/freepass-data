import { describe, expect, it } from 'vitest';
import { createConsumerGateway, parseConsumerBindings, type ConsumerBinding } from '../src/api/consumer-gateway.js';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import type { AdminWorkflowStore } from '../src/ports/admin-workflow.js';

const token = 'admin-workflow-token-0123456789abcdef';
const binding: ConsumerBinding = {
  id: 'freepass-admin-catalog',
  projectionId: 'admin-catalog',
  token,
  capabilities: ['catalog', 'admin-workflow'],
};
const headers = { authorization: `Bearer ${token}` };

function app(store: AdminWorkflowStore) {
  const logs = new MemoryDataAccessLogStore();
  return {
    logs,
    app: createConsumerGateway(
      new MemoryDataStore(),
      [binding],
      new DataAccessGateway(logs),
      undefined,
      undefined,
      store,
    ),
  };
}

describe('Admin workflow consumer gateway', () => {
  it('limits admin-workflow capability to the Admin consumer', () => {
    expect(() => parseConsumerBindings(JSON.stringify([{
      id: 'erp-com',
      projectionId: 'erp-public',
      token,
      capabilities: ['admin-workflow'],
    }]))).toThrow('requires freepass-admin-catalog');
  });

  it('authenticates and audits bounded workflow reads', async () => {
    let reads = 0;
    const store: AdminWorkflowStore = {
      async read(spec) {
        reads += 1;
        return {
          schema: 'freepass-data.admin-workflow-read/v1',
          docs: spec.kind === 'doc' ? [{ id: spec.id, data: { ok: true } }] : [],
          digest: 'a'.repeat(64),
        };
      },
      async commit() { throw new Error('not used'); },
    };
    const { app: server, logs } = app(store);

    expect((await server.inject({
      method: 'POST',
      url: '/v1/consumers/freepass-admin-catalog/admin-workflow/read',
      payload: { kind: 'doc', resource: 'settlementRows', id: 'row-1' },
    })).statusCode).toBe(401);
    expect(reads).toBe(0);

    const response = await server.inject({
      method: 'POST',
      url: '/v1/consumers/freepass-admin-catalog/admin-workflow/read',
      headers,
      payload: { kind: 'doc', resource: 'settlementRows', id: 'row-1' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().docs[0]).toEqual({ id: 'row-1', data: { ok: true } });
    expect(logs.events.map((event) => [event.mode, event.phase])).toEqual([
      ['READ', 'DENIED'],
      ['READ', 'STARTED'],
      ['READ', 'SUCCEEDED'],
    ]);
    await server.close();
  });

  it('routes writes through Data Access and returns authority receipt', async () => {
    let commits = 0;
    const store: AdminWorkflowStore = {
      async read() { throw new Error('not used'); },
      async commit(consumerId, request) {
        commits += 1;
        expect(consumerId).toBe('freepass-admin-catalog');
        return {
          schema: 'freepass-data.admin-workflow-receipt/v1',
          authority: 'FREEPASS_DATA',
          consumerId,
          operationId: request.operationId,
          requestDigest: 'b'.repeat(64),
          mutationCount: request.mutations.length,
          committedAt: '2026-09-27T00:00:00.000Z',
          receiptDigest: 'c'.repeat(64),
          idempotent: false,
        };
      },
    };
    const { app: server, logs } = app(store);
    const response = await server.inject({
      method: 'POST',
      url: '/v1/consumers/freepass-admin-catalog/admin-workflow/commit',
      headers,
      payload: {
        operationId: 'op-1',
        actor: 'tester',
        purpose: 'test workflow write',
        expectations: [],
        mutations: [{
          op: 'update',
          resource: 'settlementRows',
          id: 'row-1',
          data: { paper: true },
        }],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ authority: 'FREEPASS_DATA', operationId: 'op-1', mutationCount: 1 });
    expect(commits).toBe(1);
    expect(logs.events.map((event) => [event.mode, event.phase])).toEqual([
      ['WRITE', 'STARTED'],
      ['WRITE', 'SUCCEEDED'],
    ]);
    await server.close();
  });
});
