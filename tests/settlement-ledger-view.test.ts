import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import schema from '../contracts/settlement-ledger-view-v1.schema.json' with { type: 'json' };
import schemaV2 from '../contracts/settlement-ledger-view-v2.schema.json' with { type: 'json' };
import { createConsumerGateway, parseConsumerBindings, type ConsumerBinding } from '../src/api/consumer-gateway.js';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { readSettlementLedgerView, projectSettlementReconciliation, projectSettlementLedgerRecord } from '../src/application/settlement-ledger-view.js';
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
  calculationBasis: '  사람이 입력한 기준료 × 기간 + 추가금\n  원문 공백 보존  ',
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
  it('projects ISO timestamp source dates without breaking either response schema or changing raw evidence', async () => {
    const raw = { ...rowData, billedAt: '2026-09-08T18:46:31.427Z', deliveredAt: '2026-09-08T01:46:31+09:00', invoiceAt: '2026-02-30', receivedAt: 'unknown' };
    const row = projectSettlementLedgerRecord('date-test', raw);
    expect(row.progress).toMatchObject({ billedAt: '2026-09-09', deliveredAt: '2026-09-08', invoiceAt: null });
    expect(row.identity.receivedAt).toBeNull();
    expect(projectSettlementLedgerRecord('equivalent', { ...raw, billedAt: '2026-09-09T03:46:31.427+09:00' }).progress.billedAt).toBe(row.progress.billedAt);
    expect(projectSettlementLedgerRecord('invalid-time', { ...raw, billedAt: '2026-09-08T24:00:00Z' }).progress.billedAt).toBeNull();
    const evidence = projectSettlementReconciliation(raw);
    expect(evidence.audit.dateSourceValues).toEqual(expect.arrayContaining([{ field: 'billedAt', rawValue: raw.billedAt }, { field: 'invoiceAt', rawValue: raw.invoiceAt }]));
    const ajv = new Ajv2020({ strict: false }); addFormats(ajv);
    const store: AdminWorkflowStore = {
      async read(spec) { return { schema: 'freepass-data.admin-workflow-read/v1', docs: spec.resource === 'settlementRows' ? [{ id: 'date-test', data: raw }] : [], digest: 'e'.repeat(64) }; },
      async commit() { throw new Error('WRITES_FORBIDDEN'); },
    };
    for (const version of [1, 2] as const) {
      const response = await readSettlementLedgerView(store, 'kakao-ops', { kind: 'doc', id: 'date-test', viewVersion: version });
      expect(ajv.compile(version === 1 ? schema : schemaV2)(response)).toBe(true);
    }
  });
  it('distinguishes matching monthly IDs/supply from missing VAT evidence and withholds uncertain eligibility totals', async () => {
    const store: AdminWorkflowStore = {
      async read(spec) {
        const docs = spec.resource === 'settlementRows'
          ? [{ id: 'one', data: { billMonth: '2026-09', sourceReceiptClaim: 100, sourceReceiptPay: 80, cancelled: false } }]
          : [{ id: 'rules', data: { monthlyReceiptSummaries: { '2026-09': { entryIds: ['one'], claimAmount: 100, payAmount: 80 } } } }];
        return { schema: 'freepass-data.admin-workflow-read/v1', docs, digest: 'd'.repeat(64) };
      }, async commit() { throw new Error('WRITES_FORBIDDEN'); },
    };
    const result = await readSettlementLedgerView(store, 'kakao-ops', { kind: 'query', viewVersion: 2, filters: [{ field: 'billMonth', value: '2026-09' }] });
    expect(result.meta.snapshotSummary).toMatchObject({
      completeness: 'ELIGIBILITY_UNKNOWN', uncertainEligibilityIds: ['one'], totals: { recordedClaim: { knownSubtotal: 100, supply: null, vat: { missingCount: 1, amount: null } } },
      storedSummaryComparison: { state: 'UNAVAILABLE', components: { ids: 'MATCH', supply: 'MATCH', vat: 'UNKNOWN', total: 'UNKNOWN' } },
    });
  });
  it('reads immutable cash and audit records using the existing identity, never treating agent as author', async () => {
    const store: AdminWorkflowStore = {
      async read(spec) {
        const docs = spec.resource === 'settlementRows'
          ? [{ id: 'row', data: { ...rowData, cancelled: false, settleExclude: false, createdAt: { seconds: 1756684800 }, agent: '영업담당' } }]
          : spec.resource === 'settlementEvents'
            ? [{ id: 'events', data: { aud_one: { at: 1756684800000, by: '실제작성자', field: '청구', from: 0, to: 100 }, metadata: { secret: 'excluded' } } }]
            : [{ id: 'cash', data: { code: 'stl_demo', axis: '공급사', kind: '수금', amount: 100, day: '2026-09-01', by: '실제처리자', createdAt: 1756684800000 } }];
        if (spec.resource === 'settlementEvents') expect(spec).toMatchObject({ id: '12가3456_2026-09-01' });
        if (spec.resource === 'settlementCashEvents') expect(spec).toMatchObject({ filters: [{ field: 'code', value: 'stl_demo' }] });
        return { schema: 'freepass-data.admin-workflow-read/v1', docs, digest: 'c'.repeat(64) };
      },
      async commit() { throw new Error('WRITES_FORBIDDEN'); },
    };
    const result = await readSettlementLedgerView(store, 'kakao-ops', { kind: 'doc', id: 'row', viewVersion: 2 });
    const detail = result.data[0]!.reconciliation!;
    expect(detail.audit).toMatchObject({ createdBy: null, createdAt: '2025-09-01T00:00:00.000Z', historyState: 'READ', history: [{ by: '실제작성자', from: 0, to: 100 }] });
    expect(detail.audit.history).toHaveLength(1);
    expect(detail.cash.eventsState).toBe('READ');
    expect(detail.cash.events[0]).toMatchObject({ amount: 100, by: '실제처리자' });
    expect(detail.cash.claim.amount).toBeNull();
    const ajv = new Ajv2020({ strict: false }); addFormats(ajv);
    expect(ajv.compile(result.schema.endsWith('/v2') ? schemaV2 : schema)(result)).toBe(true);
  });
  it('keeps recorded, written, calculated, confirmed and cash facts separate, preserving genuine zero', () => {
    const result = projectSettlementReconciliation({
      sourceReceiptClaim: 2300189, sourceReceiptClaimVat: 230019, sourceReceiptClaimGross: 2530208,
      claimWritten: 0, collectedAmt: 0, agent: '영업담당', createdAt: '2026-09-01',
      supplierOk: true, claimStage: '확인', vatIncluded: true,
    });
    expect(result.recorded.claim).toMatchObject({ supply: 2300189, vat: 230019, total: 2530208 });
    expect(result.written.claim).toMatchObject({ supply: 0, vat: null, total: null });
    expect(result.calculated.claim.supply).toBeNull();
    expect(result.confirmed.claim.supply).toBeNull();
    expect(result.cash.claim).toEqual({ amount: 0, at: null, reportedComplete: null });
    expect(result.cash.verification).toBe('RECORDED_UNVERIFIED');
    expect(result.audit.createdBy).toBeNull();
    expect(result.audit.businessDate).toBeNull();
    expect(result.audit.historyState).toBe('IDENTITY_MISSING');
  });

  it('returns opt-in V2 totals from exactly the returned snapshot, excludes cancellations, and flags incomplete sums', async () => {
    const rows = [
      { id: 'one', data: { ...rowData, cancelled: false, settleExclude: false, sourceReceiptClaim: 2300189, claimWritten: 0 } },
      { id: 'two', data: { ...rowData, cancelled: false, settleExclude: false, sourceReceiptClaim: 371620, claimWritten: 517380 } },
      { id: 'cancelled', data: { ...rowData, cancelled: true, sourceReceiptClaim: 99999999 } },
    ];
    const store: AdminWorkflowStore = {
      async read() { return { schema: 'freepass-data.admin-workflow-read/v1', docs: rows, digest: 'b'.repeat(64) }; },
      async commit() { throw new Error('WRITES_FORBIDDEN'); },
    };
    const result = await readSettlementLedgerView(store, 'kakao-ops', {
      kind: 'query', viewVersion: 2, filters: [{ field: 'billMonth', value: '2026-09' }], limit: 3,
    });
    expect(result.schema).toBe('freepass-data.settlement-ledger/v2');
    expect(result.meta.sourceFreshness).toEqual({ state: 'UNVERIFIED', reason: 'SOURCE_NOT_VERIFIED_BY_THIS_READ' });
    expect(result.meta.snapshotSummary).toMatchObject({
      scope: 'MONTH', completeness: 'LIMIT_REACHED', entryIds: ['one', 'two'], excludedIds: ['cancelled'],
      totals: {
        recordedClaim: { knownSubtotal: 2671809, missingCount: 0, supply: null },
        writtenClaim: { knownSubtotal: 517380, missingCount: 0, supply: null },
        calculatedClaim: { knownSubtotal: 0, missingCount: 2, supply: null },
      },
    });
    const ajv = new Ajv2020({ strict: false }); addFormats(ajv);
    expect(ajv.compile(result.schema.endsWith('/v2') ? schemaV2 : schema)(result)).toBe(true);
    const legacy = await readSettlementLedgerView(store, 'kakao-ops', { kind: 'doc', id: 'one' });
    expect(legacy.schema).toBe('freepass-data.settlement-ledger/v1');
    expect(legacy.data[0]).not.toHaveProperty('reconciliation');
    expect(legacy.meta).not.toHaveProperty('snapshotSummary');
    expect(legacy.meta).not.toHaveProperty('sourceFreshness');
    expect(() => assertSettlementLedgerReadRequest({ kind: 'doc', id: 'one', viewVersion: 3 })).toThrow();
  });
  it('projects FreePass Data settlement facts without guessing missing booleans or money', async () => {
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
        calculationBasis: rowData.calculationBasis,
      },
      source: { authority: 'FREEPASS_DATA_SETTLEMENT', documentId: '12가3456_2026-09-01' },
    });
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    expect(ajv.compile(result.schema.endsWith('/v2') ? schemaV2 : schema)(result)).toBe(true);
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
      meta: { consumerId: 'kakao-ops', authority: 'FREEPASS_DATA_SETTLEMENT', count: 1 },
    });
    expect(logs.events.map((event) => [event.mode, event.phase])).toEqual([
      ['READ', 'DENIED'],
      ['READ', 'STARTED'],
      ['READ', 'SUCCEEDED'],
    ]);
    const extended = await app.inject({
      method: 'POST', url: '/v1/consumers/kakao-ops/settlement-ledger/read', headers,
      payload: { kind: 'doc', id: '12가3456_2026-09-01', viewVersion: 2 },
    });
    expect(extended.statusCode).toBe(200);
    expect(extended.json()).toMatchObject({
      schema: 'freepass-data.settlement-ledger/v2',
      meta: { snapshotSummary: { scope: 'FILTERED', uncertainEligibilityIds: ['12가3456_2026-09-01'], totals: { writtenClaim: { knownSubtotal: 1100000, supply: null } } } },
    });
    await app.close();
  });
});

