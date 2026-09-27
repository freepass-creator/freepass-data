import { describe, expect, it } from 'vitest';
import { createBusinessGateway, type BusinessConsumerBinding } from '../src/api/business-gateway.js';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';

const token = 'business-test-token-0123456789abcdef';
const binding: BusinessConsumerBinding = {
  id: 'freepass-admin',
  token,
  read: true,
  write: true,
};

describe('business access gateway', () => {
  it('authenticates before touching the business store', async () => {
    let reads = 0;
    let writes = 0;
    const store = {
      read: async () => {
        reads += 1;
        return {
          contract: 'freepass-data.business-read/v1' as const,
          consumerId: 'freepass-admin',
          resource: 'admin.contract',
          data: [],
          readAt: '2026-09-27T00:00:00.000Z',
        };
      },
      write: async () => {
        writes += 1;
        return {
          contract: 'freepass-data.business-write-receipt/v1' as const,
          consumerId: 'freepass-admin',
          commandId: 'cmd-1',
          idempotencyKey: 'idem-1',
          status: 'COMMITTED' as const,
          operationCount: 1,
          committedAt: '2026-09-27T00:00:00.000Z',
        };
      },
    };
    const logs = new MemoryDataAccessLogStore();
    const app = createBusinessGateway(store, [binding], new DataAccessGateway(logs));

    expect((await app.inject({ url: '/v1/business/freepass-admin/admin.contract' })).statusCode).toBe(401);
    expect((await app.inject({
      method: 'POST',
      url: '/v1/business/freepass-admin/commands',
      payload: {
        commandId: 'cmd-1',
        idempotencyKey: 'idem-1',
        reason: 'test',
        operations: [{ resource: 'admin.contract', action: 'PATCH', id: 'C1', data: { status: 'x' } }],
      },
    })).statusCode).toBe(401);
    expect(reads).toBe(0);
    expect(writes).toBe(0);
    expect(logs.events.every((event) => event.phase === 'DENIED')).toBe(true);
    await app.close();
  });

  it('audits authenticated read and write through FreePass Data', async () => {
    const store = {
      read: async () => ({
        contract: 'freepass-data.business-read/v1' as const,
        consumerId: 'freepass-admin',
        resource: 'admin.contract',
        data: [{ id: 'C1', status: 'active' }],
        readAt: '2026-09-27T00:00:00.000Z',
      }),
      write: async (input: any) => ({
        contract: 'freepass-data.business-write-receipt/v1' as const,
        consumerId: input.consumerId,
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        status: 'COMMITTED' as const,
        operationCount: input.operations.length,
        committedAt: '2026-09-27T00:00:00.000Z',
      }),
    };
    const logs = new MemoryDataAccessLogStore();
    const app = createBusinessGateway(store, [binding], new DataAccessGateway(logs));
    const headers = { authorization: `Bearer ${token}` };

    const read = await app.inject({
      url: '/v1/business/freepass-admin/admin.contract',
      headers,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data).toHaveLength(1);

    const write = await app.inject({
      method: 'POST',
      url: '/v1/business/freepass-admin/commands',
      headers,
      payload: {
        commandId: 'cmd-1',
        idempotencyKey: 'idem-1',
        reason: 'cancel contract after domain validation',
        operations: [{ resource: 'admin.contract', action: 'PATCH', id: 'C1', data: { contract_status: '계약취소' } }],
      },
    });
    expect(write.statusCode).toBe(200);
    expect(write.json()).toMatchObject({
      contract: 'freepass-data.business-write-receipt/v1',
      status: 'COMMITTED',
    });

    expect(logs.events.map((event) => [event.mode, event.phase])).toEqual([
      ['READ', 'STARTED'],
      ['READ', 'SUCCEEDED'],
      ['WRITE', 'STARTED'],
      ['WRITE', 'SUCCEEDED'],
    ]);
    await app.close();
  });

  it('keeps consumer capabilities separate', async () => {
    const readOnly: BusinessConsumerBinding = {
      id: 'erp-com',
      token: token + '2',
      read: true,
      write: false,
    };
    const store = {
      read: async () => ({
        contract: 'freepass-data.business-read/v1' as const,
        consumerId: 'erp-com',
        resource: 'erp.product',
        data: [],
        readAt: '2026-09-27T00:00:00.000Z',
      }),
      write: async () => { throw new Error('must not run'); },
    };
    const app = createBusinessGateway(
      store,
      [readOnly],
      new DataAccessGateway(new MemoryDataAccessLogStore()),
    );
    const result = await app.inject({
      method: 'POST',
      url: '/v1/business/erp-com/commands',
      headers: { authorization: `Bearer ${token}2` },
      payload: {
        commandId: 'cmd',
        idempotencyKey: 'idem',
        reason: 'test',
        operations: [{ resource: 'erp.product', action: 'PATCH', id: 'P1', data: {} }],
      },
    });
    expect(result.statusCode).toBe(403);
    await app.close();
  });
});
