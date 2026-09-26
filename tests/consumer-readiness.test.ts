import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import readinessSchema from '../contracts/consumer-readiness-v1.schema.json' with { type: 'json' };
import {
  CONSUMER_READINESS_CONTRACT_VERSION,
  CONSUMER_READINESS_SCHEMA_VERSION,
  readConsumerReadiness
} from '../src/application/consumer-readiness.js';
import type { DataAccessEvent } from '../src/domain/data-access.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validate = ajv.compile(readinessSchema);

const INPUT = 'a'.repeat(64);
const DATA = 'b'.repeat(64);

const policy = {
  assessedAt: '2026-09-26T09:05:00.000Z',
  maxAgeMs: 10 * 60_000,
  maxFutureSkewMs: 0,
  eventLimit: 1000
};

function erpEvent(
  phase: DataAccessEvent['phase'] = 'SUCCEEDED',
  overrides: Partial<DataAccessEvent> = {}
): DataAccessEvent {
  const base: DataAccessEvent = {
    contractVersion: 'data-access-event-v1',
    eventId: 'evt_erp_1',
    operationId: 'op_erp_1',
    mode: 'READ',
    phase,
    operation: 'READ_CONSUMER_CATALOG',
    actor: { id: 'consumer:erp-com', kind: 'SERVICE' },
    clientId: 'erp-com',
    purpose: 'read approved catalog projection through FreePass Data',
    resource: {
      kind: 'PROJECTION',
      name: 'erp-public',
      projectionId: 'erp-public'
    },
    startedAt: '2026-09-26T09:00:00.000Z',
    occurredAt: '2026-09-26T09:00:01.000Z',
    ...(phase === 'SUCCEEDED' ? {
      result: {
        count: 100,
        digest: DATA,
        inputDigest: INPUT,
        releaseId: 'rel_erp_ready',
        manifestId: 'manifest_erp_ready',
        revision: 10
      }
    } : {})
  };
  return { ...base, ...overrides };
}

function entry(
  report: Awaited<ReturnType<typeof readConsumerReadiness>>,
  consumerId: string
) {
  const value = report.consumers.find((item) => item.consumerId === consumerId);
  if (!value) throw new Error('consumer not found');
  return value;
}

describe('consumer cutover readiness', () => {
  it('starts fail-closed with all consumers on HOLD when no runtime or Sheet proof exists', async () => {
    const report = await readConsumerReadiness(
      new MemoryDataAccessLogStore(),
      new MemoryDataStore(),
      policy
    );

    expect(report.contractVersion).toBe(CONSUMER_READINESS_CONTRACT_VERSION);
    expect(report.schemaVersion).toBe(CONSUMER_READINESS_SCHEMA_VERSION);
    expect(report.counts).toEqual({
      readyForNextStage: 0,
      hold: 8,
      final: 0
    });
    expect(report.readyTransitions).toEqual([]);
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it('marks ERP.com ready for OBSERVE -> SHADOW_READ only after a fresh successful authenticated read', async () => {
    const logs = new MemoryDataAccessLogStore();
    await logs.appendDataAccessEvent(erpEvent());

    const report = await readConsumerReadiness(
      logs,
      new MemoryDataStore(),
      policy
    );
    const erp = entry(report, 'erp-com-public-catalog');

    expect(erp).toMatchObject({
      readiness: 'READY_FOR_NEXT_STAGE',
      currentStage: 'OBSERVE',
      nextStage: 'SHADOW_READ',
      transitionAllowed: true,
      healthStatus: 'DEGRADED',
      evidenceSource: 'GATEWAY_RUNTIME',
      evidenceState: 'SUCCEEDED',
      releaseId: 'rel_erp_ready',
      missingEvidence: [],
      blockers: [],
      requiredActions: []
    });
    expect(report.readyTransitions).toContainEqual({
      consumerId: 'erp-com-public-catalog',
      from: 'OBSERVE',
      to: 'SHADOW_READ'
    });
    expect(report.counts.readyForNextStage).toBe(1);
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it('returns ERP.com to HOLD when a newer authentication denial becomes the latest fact', async () => {
    const logs = new MemoryDataAccessLogStore();
    await logs.appendDataAccessEvent(erpEvent());
    await logs.appendDataAccessEvent(erpEvent('DENIED', {
      eventId: 'evt_erp_2',
      operationId: 'op_erp_2',
      occurredAt: '2026-09-26T09:04:00.000Z',
      reasonCode: 'UNAUTHORIZED'
    }));

    const erp = entry(
      await readConsumerReadiness(logs, new MemoryDataStore(), policy),
      'erp-com-public-catalog'
    );

    expect(erp.readiness).toBe('HOLD');
    expect(erp.requiredActions).toEqual(expect.arrayContaining([
      'PROVISION_CONSUMER_AUTH',
      'VERIFY_FREEPASS_READ',
      'FIX_RUNTIME_AUTHENTICATION'
    ]));
    expect(erp.blockers).toEqual(expect.arrayContaining([
      'missing evidence: authenticationVerified',
      'missing evidence: freepassReadVerified',
      'RUNTIME_CONSUMER_READ_DENIED:UNAUTHORIZED'
    ]));
  });

  it('does not call Sales or Estimate ready while their product-main consumer contracts are not ready', async () => {
    const report = await readConsumerReadiness(
      new MemoryDataAccessLogStore(),
      new MemoryDataStore(),
      policy
    );

    const sales = entry(report, 'freepass-sales-catalog');
    const estimate = entry(report, 'freepass-estimate-catalog');

    expect(sales).toMatchObject({
      readiness: 'HOLD',
      evidenceSource: 'NOT_IMPLEMENTED',
      requiredActions: expect.arrayContaining([
        'IMPLEMENT_CONSUMER_CONTRACT'
      ])
    });
    expect(estimate).toMatchObject({
      readiness: 'HOLD',
      evidenceSource: 'GATEWAY_RUNTIME',
      evidenceState: 'UNOBSERVED',
      requiredActions: expect.arrayContaining([
        'IMPLEMENT_CONSUMER_CONTRACT',
        'GENERATE_RUNTIME_READ_EVIDENCE'
      ])
    });
  });

  it('keeps White Label aggregate and Sheets on their dedicated evidence actions', async () => {
    const report = await readConsumerReadiness(
      new MemoryDataAccessLogStore(),
      new MemoryDataStore(),
      policy
    );

    expect(entry(report, 'erp-whitelabel-catalogs')).toMatchObject({
      readiness: 'HOLD',
      requiredActions: expect.arrayContaining([
        'VERIFY_WHITELABEL_IDENTITIES'
      ])
    });

    for (const consumerId of ['google-sheets-f01', 'google-sheets-f86']) {
      expect(entry(report, consumerId)).toMatchObject({
        readiness: 'HOLD',
        evidenceSource: 'SHEET_DELIVERY',
        requiredActions: expect.arrayContaining([
          'RECORD_SHEET_DELIVERY_EVIDENCE'
        ])
      });
    }
  });

  it('pins schema identity to runtime constants', () => {
    expect(readinessSchema.properties.contractVersion.const)
      .toBe(CONSUMER_READINESS_CONTRACT_VERSION);
    expect(readinessSchema.properties.schemaVersion.const)
      .toBe(CONSUMER_READINESS_SCHEMA_VERSION);
  });
});
