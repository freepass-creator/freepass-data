import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import schema from '../contracts/data-access-event.v1.schema.json' with { type: 'json' };
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';

const addFormats = (
  typeof addFormatsModule === 'function'
    ? addFormatsModule
    : (addFormatsModule as unknown as { default: FormatsPlugin }).default
) as FormatsPlugin;

describe('data-access-event-v1 contract', () => {
  it('validates events emitted by the gateway', async () => {
    const store = new MemoryDataAccessLogStore();
    let id = 0;
    const access = new DataAccessGateway(
      store,
      () => '2026-09-25T12:00:00.000Z',
      () => `event_${++id}`
    );

    await access.read({
      context: {
        actor: { id: 'service:contract-test', kind: 'SERVICE' },
        clientId: 'test-contract',
        purpose: 'validate access event schema'
      },
      operation: 'READ_CATALOG',
      resource: {
        kind: 'PROJECTION',
        name: 'erp-public',
        projectionId: 'erp-public'
      },
      summarize: () => ({
        count: 1,
        digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      })
    }, async () => ({ ok: true }));

    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(store.events).toHaveLength(2);
    for (const event of store.events) {
      expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it('rejects raw error text and unversioned event shapes by schema', () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate({
      eventId: 'event',
      operationId: 'operation',
      mode: 'READ',
      phase: 'FAILED',
      operation: 'READ_CATALOG',
      actor: { id: 'service:test', kind: 'SERVICE' },
      clientId: 'test',
      purpose: 'test',
      resource: { kind: 'PROJECTION', name: 'erp-public' },
      reasonCode: 'FAILED',
      errorMessage: 'private backend detail',
      startedAt: '2026-09-25T12:00:00.000Z',
      occurredAt: '2026-09-25T12:00:00.000Z'
    })).toBe(false);
  });
});
