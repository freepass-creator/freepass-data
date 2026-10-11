import { describe, expect, it } from 'vitest';
import { projectAdminWorkflowCurrentFacts } from '../src/application/settlement-ledger-view.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import receiptSchema from '../contracts/admin-workflow-receipt-v2.schema.json' with { type: 'json' };
import { createConsumerGateway, parseConsumerBindings, type ConsumerBinding } from '../src/api/consumer-gateway.js';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import type { AdminWorkflowStore } from '../src/ports/admin-workflow.js';
import {
  ADMIN_WORKFLOW_RESOURCES,
  ADMIN_WORKFLOW_RESOURCE_POLICIES,
  adminWorkflowSemanticOwners,
} from '../src/domain/admin-workflow.js';

const token = 'admin-workflow-token-0123456789abcdef';
const binding: ConsumerBinding = {
  id: 'freepass-admin-catalog',
  projectionId: 'admin-catalog',
  token,
  capabilities: ['catalog', 'admin-workflow'],
};
const headers = { authorization: `Bearer ${token}` };
const addFormats = (
  typeof addFormatsModule === 'function'
    ? addFormatsModule
    : (addFormatsModule as unknown as { default: FormatsPlugin }).default
) as FormatsPlugin;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateReceipt = ajv.compile(receiptSchema);

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
  it('preserves the timestamp object atom and explicitly locates unsupported objects in raw docs', () => {
    const timestamp = { _seconds: 1790000000, _nanoseconds: 123000000 };
    const facts = projectAdminWorkflowCurrentFacts({ kind: 'doc', resource: 'settlementRows', id: 'same-id' }, {
      schema: 'freepass-data.admin-workflow-read/v1', digest: 'a'.repeat(64), docs: [{ id: 'same-id', data: { createdAt: timestamp, claimWritten: { unsupported: true } } }],
    }).records[0]!.facts;
    expect(facts.createdAt).toMatchObject({ state: 'RECORDED', sourceField: 'createdAt', sourceValue: timestamp, sourceValueLocation: 'INLINE' });
    expect(facts.claimSupply).toMatchObject({ value: null, state: 'INVALID', sourceValue: null, sourceValueLocation: 'RAW_DOCS' });
  });
  it('keeps contract axes and explicit unverified links without deriving a settlement amount or actor', () => {
    const data = { source_intake_id: 'intake-id', contract_status: '계약대기', sign_status: 'source-sign', rent_month_snapshot: '48', agent_code: 'agent', updated_at: 0, created_by: 'unverified-actor-field' };
    const current = projectAdminWorkflowCurrentFacts({ kind: 'doc', resource: 'contracts', id: 'contract-id', view: 'current-facts/v1' }, {
      schema: 'freepass-data.admin-workflow-read/v1', digest: 'b'.repeat(64), docs: [{ id: 'contract-id', data }],
    });
    expect(current.completeness).toBe('DOCUMENT_READ');
    expect(current.records[0]).toMatchObject({ recordId: 'contract-id', link: { state: 'RECORDED_UNVERIFIED', targetId: 'intake-id' }, facts: {
      contractStatus: { value: '계약대기' }, signStatus: { value: 'source-sign' }, termMonths: { value: 48, state: 'RECORDED', sourceValue: '48' },
      responsibleCode: { value: 'agent' }, createdBy: { value: null, state: 'UNKNOWN', reason: 'UNAVAILABLE_IN_THIS_SOURCE' },
    } });
    expect(current.records[0]!.facts.claimSupply).toMatchObject({ value: null, state: 'UNKNOWN', reason: 'UNAVAILABLE_IN_THIS_SOURCE', sourceField: null });
    expect(projectAdminWorkflowCurrentFacts({ kind: 'doc', resource: 'contracts', id: 'missing' }, { schema: 'freepass-data.admin-workflow-read/v1', digest: 'b'.repeat(64), docs: [] }).records).toEqual([]);
  });
  it('does not infer timezone, links from another identifier, or malformed numeric values', () => {
    const result = { schema: 'freepass-data.admin-workflow-read/v1' as const, digest: 'c'.repeat(64), docs: [{ id: 'raw-id', data: {
      createdAt: '2026-10-11 09:00:00', updatedAt: '2026-10-11T09:00:00+09:00', claimWritten: '1,200,000', payWritten: '1,20', contractNo: 'number-only',
    } }] };
    const p = projectAdminWorkflowCurrentFacts({ kind: 'doc', resource: 'settlementRows', id: 'raw-id' }, result).records[0]!;
    expect(p.facts.createdAt).toMatchObject({ value: null, reason: 'SOURCE_TIMEZONE_MISSING' });
    expect(p.facts.updatedAt!.value).toBe('2026-10-11T00:00:00.000Z');
    expect(p.facts.claimSupply).toMatchObject({ value: 1200000, sourceValue: '1,200,000' });
    expect(p.facts.paySupply).toMatchObject({ value: null, reason: 'SOURCE_TYPE_NOT_SUPPORTED', sourceValue: '1,20' });
    expect(p.link).toMatchObject({ state: 'UNLINKED', basis: 'EXPLICIT_DOCUMENT_ID_ONLY', otherRecordedIdentifier: 'number-only' });
  });
  it('adds optional current facts without changing raw docs, zero, BT or source IDs', async () => {
    const data = { code: 'original', claimWritten: 0, payWritten: null, sourceReceiptClaim: 123, calculationBasis: '  basis\n ', updatedAt: 0, claimStage: 'source-stage' };
    let reads = 0;
    const store: AdminWorkflowStore = {
      async read() { reads++; return { schema: 'freepass-data.admin-workflow-read/v1', docs: [{ id: 'same-id', data }], digest: 'a'.repeat(64) }; },
      async commit() { throw new Error('WRITES_FORBIDDEN'); },
    };
    const { app: server } = app(store);
    const url = '/v1/consumers/freepass-admin-catalog/admin-workflow/read';
    const payload = { kind: 'query', resource: 'settlementRows', limit: 1, view: 'current-facts/v1' };
    expect((await server.inject({ method: 'POST', url, payload })).statusCode).toBe(401);
    expect(reads).toBe(0);
    const response = await server.inject({ method: 'POST', url, headers, payload });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.docs).toEqual([{ id: 'same-id', data }]);
    expect(body.digest).toBe('a'.repeat(64));
    expect(body.currentFacts.completeness).toBe('LIMIT_REACHED');
    expect(body.currentFacts.records[0]).toMatchObject({ recordId: 'same-id', link: { state: 'UNLINKED', targetId: null }, facts: {
      claimSupply: { value: 0, state: 'RECORDED' }, paySupply: { value: null, state: 'UNKNOWN' },
      recordedClaimSupply: { value: 123, state: 'RECORDED' }, confirmedClaimSupply: { value: null, state: 'UNKNOWN' },
      calculationBasis: { value: data.calculationBasis }, createdBy: { value: null, state: 'UNKNOWN' },
      claimStage: { value: 'source-stage' }, updatedAt: { value: null, reason: 'SOURCE_TIMESTAMP_UNIT_UNVERIFIED', sourceValue: 0 },
    } });
    for (const invalid of [{ ...payload, limit: undefined }, { ...payload, view: 'bad' }, { ...payload, resource: 'products' }]) {
      expect((await server.inject({ method: 'POST', url, headers, payload: invalid })).statusCode).toBe(400);
    }
    await server.close();
  });
  it('does not guess timestamp units or recover unsafe amounts, and distinguishes unsupported link values', () => {
    for (const value of [1790000000, 0]) {
      const row = projectAdminWorkflowCurrentFacts({ kind: 'doc', resource: 'settlementRows', id: 'id' }, {
        schema: 'freepass-data.admin-workflow-read/v1', digest: 'd'.repeat(64), docs: [{ id: 'id', data: { updatedAt: value, contractId: 12, claimWritten: Number.MAX_SAFE_INTEGER + 1 } }],
      }).records[0]!;
      expect(row.facts.updatedAt).toMatchObject({ value: null, reason: 'SOURCE_TIMESTAMP_UNIT_UNVERIFIED', sourceValue: value });
      expect(row.facts.claimSupply).toMatchObject({ value: null, reason: 'SOURCE_TYPE_NOT_SUPPORTED' });
      expect(row.link).toMatchObject({ state: 'UNLINKED', reason: 'EXPLICIT_LINK_TYPE_NOT_SUPPORTED', sourceValue: 12 });
    }
    expect(() => projectAdminWorkflowCurrentFacts({ kind: 'doc', resource: 'products', id: 'id' }, {
      schema: 'freepass-data.admin-workflow-read/v1', digest: 'd'.repeat(64), docs: [],
    })).toThrow('INVALID_ADMIN_WORKFLOW_VIEW');
  });
  it('classifies every resource and preserves all semantic owners in a mixed atomic command', () => {
    expect(Object.keys(ADMIN_WORKFLOW_RESOURCE_POLICIES).sort())
      .toEqual(Object.keys(ADMIN_WORKFLOW_RESOURCES).sort());
    expect(adminWorkflowSemanticOwners({
      operationId: 'mixed-owner-operation',
      actor: 'freepass-admin-runtime',
      purpose: 'contract acceptance and settlement lock in one transaction',
      expectations: [],
      mutations: [
        { op: 'update', resource: 'contracts', id: 'contract-1', data: { accepted: true } },
        { op: 'update', resource: 'settlementRows', id: 'row-1', data: { locked: true } },
      ],
    })).toEqual(['FREEPASS_ADMIN_APPLICATION_CONTRACT', 'FREEPASS_DATA_SETTLEMENT']);
  });

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

  it('routes writes through Data Access and distinguishes execution from semantic authority', async () => {
    let commits = 0;
    const store: AdminWorkflowStore = {
      async read() { throw new Error('not used'); },
      async commit(consumerId, request) {
        commits += 1;
        expect(consumerId).toBe('freepass-admin-catalog');
        return {
          schema: 'freepass-data.admin-workflow-receipt/v2',
          authority: 'FREEPASS_DATA_ACCESS_GATEWAY',
          authorityRole: 'EXECUTION_GATEWAY',
          semanticOwners: ['FREEPASS_DATA_SETTLEMENT'],
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
    expect(response.json()).toMatchObject({
      authority: 'FREEPASS_DATA_ACCESS_GATEWAY',
      authorityRole: 'EXECUTION_GATEWAY',
      semanticOwners: ['FREEPASS_DATA_SETTLEMENT'],
      operationId: 'op-1',
      mutationCount: 1,
    });
    expect(validateReceipt(response.json()), JSON.stringify(validateReceipt.errors)).toBe(true);
    expect(commits).toBe(1);
    expect(logs.events.map((event) => [event.mode, event.phase])).toEqual([
      ['WRITE', 'STARTED'],
      ['WRITE', 'SUCCEEDED'],
    ]);
    await server.close();
  });

  it('keeps Catalog source resources read-only through the Admin workflow gateway', async () => {
    let commits = 0;
    const store: AdminWorkflowStore = {
      async read() { throw new Error('not used'); },
      async commit() {
        commits += 1;
        throw new Error('must not execute');
      },
    };
    const { app: server, logs } = app(store);
    const response = await server.inject({
      method: 'POST',
      url: '/v1/consumers/freepass-admin-catalog/admin-workflow/commit',
      headers,
      payload: {
        operationId: 'op-catalog-write',
        actor: 'tester',
        purpose: 'must use Catalog commands instead',
        expectations: [],
        mutations: [{
          op: 'update',
          resource: 'products',
          id: 'product-1',
          data: { status: 'changed' },
        }],
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: 'ADMIN_WORKFLOW_RESOURCE_READ_ONLY' });
    expect(commits).toBe(0);
    expect(logs.events.map((event) => [event.mode, event.phase, event.reasonCode])).toEqual([
      ['WRITE', 'DENIED', 'ADMIN_WORKFLOW_RESOURCE_READ_ONLY'],
    ]);
    await server.close();
  });
});
