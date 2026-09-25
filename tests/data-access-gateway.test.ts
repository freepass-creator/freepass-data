import { describe, expect, it } from 'vitest';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { DataAccessAuditUnavailableError } from '../src/domain/data-access.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';

const context = {
  actor: { id: 'service:test-consumer', kind: 'SERVICE' as const },
  clientId: 'test-consumer',
  purpose: 'test catalog read',
  requestId: 'req_test'
};

const resource = {
  kind: 'PROJECTION' as const,
  name: 'erp-public',
  projectionId: 'erp-public'
};

function gateway(store = new MemoryDataAccessLogStore()) {
  let seq = 0;
  return {
    store,
    access: new DataAccessGateway(
      store,
      () => '2026-09-25T11:30:00.000Z',
      () => `id_${++seq}`
    )
  };
}

describe('DataAccessGateway', () => {
  it('records STARTED and SUCCEEDED before returning a read result', async () => {
    const { store, access } = gateway();
    const result = await access.read({
      context,
      operation: 'READ_CATALOG',
      resource,
      summarize: (value: { rows: unknown[]; releaseId: string }) => ({
        count: value.rows.length,
        releaseId: value.releaseId,
        digest: 'safe-result-digest'
      })
    }, async () => ({
      rows: [{ privateValue: 'must-not-be-logged' }],
      releaseId: 'rel_test'
    }));

    expect(result.rows).toHaveLength(1);
    expect(store.events.map((event) => event.phase)).toEqual(['STARTED', 'SUCCEEDED']);
    expect(store.events[0]!.operationId).toBe(store.events[1]!.operationId);
    expect(store.events[1]!.result).toEqual({
      count: 1,
      releaseId: 'rel_test',
      digest: 'safe-result-digest'
    });
    expect(JSON.stringify(store.events)).not.toContain('must-not-be-logged');
  });

  it('records failure without copying the thrown message when no safe code exists', async () => {
    const { store, access } = gateway();
    await expect(access.read({
      context,
      operation: 'READ_CATALOG',
      resource
    }, async () => {
      throw new Error('sensitive backend detail');
    })).rejects.toThrow('sensitive backend detail');

    expect(store.events.map((event) => event.phase)).toEqual(['STARTED', 'FAILED']);
    expect(store.events[1]!.reasonCode).toBe('UNCLASSIFIED_ACCESS_FAILURE');
    expect(JSON.stringify(store.events)).not.toContain('sensitive backend detail');
  });

  it('does not touch the underlying data source when STARTED audit persistence fails', async () => {
    let touched = false;
    const access = new DataAccessGateway({
      async appendDataAccessEvent() {
        throw new Error('audit unavailable');
      }
    });

    await expect(access.read({
      context,
      operation: 'READ_CATALOG',
      resource
    }, async () => {
      touched = true;
      return {};
    })).rejects.toBeInstanceOf(DataAccessAuditUnavailableError);

    expect(touched).toBe(false);
  });

  it('records write intent and completion around a command boundary', async () => {
    const { store, access } = gateway();
    const receipt = await access.write({
      context: {
        ...context,
        actor: { id: 'service:freepass-data', kind: 'SERVICE' as const },
        purpose: 'apply reviewed catalog command'
      },
      operation: 'WRITE_CATALOG_COMMAND',
      resource: {
        kind: 'COMMAND',
        name: 'UPDATE_OFFER_PRICE',
        entityType: 'offer',
        entityId: 'offer_1'
      },
      requestDigest: 'request-digest',
      summarize: (value: { revision: number }) => ({ revision: value.revision })
    }, async () => ({ revision: 2 }));

    expect(receipt.revision).toBe(2);
    expect(store.events.map((event) => [event.mode, event.phase])).toEqual([
      ['WRITE', 'STARTED'],
      ['WRITE', 'SUCCEEDED']
    ]);
    expect(store.events[1]!.result?.revision).toBe(2);
  });

  it('records denied attempts without running a data operation', async () => {
    const { store, access } = gateway();
    await access.deny('READ', {
      context,
      operation: 'READ_CATALOG',
      resource
    }, 'UNAUTHORIZED');

    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({
      mode: 'READ',
      phase: 'DENIED',
      reasonCode: 'UNAUTHORIZED'
    });
  });
});
