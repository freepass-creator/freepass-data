import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import schema from '../contracts/settlement-ledger-view-v1.schema.json' with { type: 'json' };
import { createConsumerGateway, parseConsumerBindings, type ConsumerBinding } from '../src/api/consumer-gateway.js';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { readSettlementLedgerView } from '../src/application/settlement-ledger-view.js';
import { assertSettlementLedgerReadRequest } from '../src/domain/settlement-ledger-view.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import type { AdminWorkflowStore } from '../src/ports/admin-workflow.js';

const token = 'kakao-settlement-token-0123456789abcdef';
const binding: ConsumerBinding = {
  id: 'kakao-ops',
  projectionId: 'erp-public',
  token,
  capabilities: ['settlement-ledger-read'],
};
const headers = { authorization: `Bearer ${token}` };
const addFormats = (
  typeof addFormatsModule === 'function'
    ? addFormatsModule
    : (addFormatsModule as unknown as { default: FormatsPlugin }).default
) as FormatsPlugin;

const rowData = {
  code: 'stl_demo',
  plate: '12가3456',
  receivedAt: '2026-09-01',
  customer: '홍길동',
  supplier: '공급사A',
  channel: '채널A',
  model: 'EV6',
  product: '장기렌트',
  paper: true,
  delivered: true,
  deliveredAt: '2026-09-05',
  cancelled: false,
  billed: true,
  billMonth: '2026-09',
  claimStage: '확인',
  payStage: '통보',
  claimWritten: 1_100_000,
  payWritten: 800_000,
  supplierRate: 0.0325,
  agentRate: 500_000,
};

function workflowStore(): AdminWorkflowStore {
  return {
    async read(spec) {
      expect(spec.resource).toBe('settlementRows');
      return {
        schema: 'freepass-data.admin-workflow-read/v1',
        docs: [{ id: '12가3456_2026-09-01', data: rowData }],
        digest: 'a'.repeat(64),
      };
    },
    async commit() { throw new Error('not used'); },
  };
}

describe('settlement ledger data product', () => {
  it('projects Admin-owned facts without guessing missing booleans or money', async () => {
    const store = workflowStore();
    const result = await readSettlementLedgerView(
      store,
      'kakao-ops',
      { kind: 'query', filters: [{ field: 'plate', value: '12가3456' }] },
      '2026-09-28T01:00:00.000Z',
    );

    expect(result.data[0]).toMatchObject({
      ledgerId: 'stl_demo',
      identity: { vehicleNumber: '12가3456', receivedAt: '2026-09-01' },
      progress: {
        delivered: true,
        billingMonth: '2026-09',
        collected: null,
        paid: null,
      },
      money: {
        claimAmount: 1_100_000,
        payAmount: 800_000,
        supplierFeeRaw: 0.0325,
        channelFeeRaw: 500_000,
      },
      source: { authority: 'FREEPASS_ADMIN_SETTLEMENT', documentId: '12가3456_2026-09-01' },
    });
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    expect(ajv.compile(schema)(result)).toBe(true);
  });

  it('allows agent plus customer lookup but blocks either personal field alone', () => {
    expect(() => assertSettlementLedgerReadRequest({ kind: 'query', filters: [] }))
      .toThrow('SETTLEMENT_LEDGER_QUERY_REQUIRES_FILTER');
    expect(() => assertSettlementLedgerReadRequest({
      kind: 'query',
      filters: [
        { field: 'agent', value: '영업자A' },
        { field: 'customer', value: '고객A' },
      ],
    })).not.toThrow();
    expect(() => assertSettlementLedgerReadRequest({
      kind: 'query', filters: [{ field: 'customer', value: '홍길동' }],
    })).toThrow('SETTLEMENT_LEDGER_PERSON_LOOKUP_REQUIRES_AGENT_AND_CUSTOMER');
    expect(() => assertSettlementLedgerReadRequest({
      kind: 'query', filters: [{ field: 'agent', value: '영업자A' }],
    })).toThrow('SETTLEMENT_LEDGER_PERSON_LOOKUP_REQUIRES_AGENT_AND_CUSTOMER');
  });

  it('allows explicit Kakao read capability but never grants Admin workflow writes', () => {
    const [parsed] = parseConsumerBindings(JSON.stringify([binding]));
    expect(parsed).toBeDefined();
    if (!parsed) throw new Error('EXPECTED_PARSED_BINDING');
    expect(parsed.capabilities).toEqual(['settlement-ledger-read']);
    expect(() => parseConsumerBindings(JSON.stringify([{
      ...binding,
      capabilities: ['admin-workflow'],
    }]))).toThrow('Admin workflow capability requires freepass-admin-catalog');
  });

  it('authenticates, capability-checks and audits the consumer route', async () => {
    const logs = new MemoryDataAccessLogStore();
    const app = createConsumerGateway(
      new MemoryDataStore(),
      [binding],
      new DataAccessGateway(logs),
      undefined,
      undefined,
      workflowStore(),
    );

    const denied = await app.inject({
      method: 'POST',
      url: '/v1/consumers/kakao-ops/settlement-ledger/read',
      payload: { kind: 'query', filters: [{ field: 'plate', value: '12가3456' }] },
    });
    expect(denied.statusCode).toBe(401);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/consumers/kakao-ops/settlement-ledger/read',
      headers,
      payload: { kind: 'query', filters: [{ field: 'plate', value: '12가3456' }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      schema: 'freepass-data.settlement-ledger/v1',
      meta: { consumerId: 'kakao-ops', authority: 'FREEPASS_ADMIN_SETTLEMENT', count: 1 },
    });
    expect(logs.events.map((event) => [event.mode, event.phase])).toEqual([
      ['READ', 'DENIED'],
      ['READ', 'STARTED'],
      ['READ', 'SUCCEEDED'],
    ]);
    await app.close();
  });
});
