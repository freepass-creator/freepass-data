import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import healthSchema from '../contracts/consumer-health-v1.schema.json' with { type: 'json' };
import {
  CONSUMER_HEALTH_CONTRACT_VERSION,
  CONSUMER_HEALTH_SCHEMA_VERSION,
  readConsumerHealth
} from '../src/application/consumer-health.js';
import type { DataAccessEvent } from '../src/domain/data-access.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validate = ajv.compile(healthSchema);

const INPUT = 'a'.repeat(64);
const DATA = 'b'.repeat(64);

function erpSuccess(): DataAccessEvent {
  return {
    contractVersion: 'data-access-event-v1',
    eventId: 'evt_erp_success',
    operationId: 'op_erp_success',
    mode: 'READ',
    phase: 'SUCCEEDED',
    operation: 'READ_CONSUMER_CATALOG',
    actor: { id: 'consumer:erp-com', kind: 'SERVICE' },
    clientId: 'erp-com',
    purpose: 'read approved catalog projection through FreePass Data',
    resource: {
      kind: 'PROJECTION',
      name: 'erp-public',
      projectionId: 'erp-public'
    },
    result: {
      count: 100,
      digest: DATA,
      inputDigest: INPUT,
      releaseId: 'rel_erp_health',
      manifestId: 'manifest_erp_health',
      revision: 10
    },
    startedAt: '2026-09-26T09:00:00.000Z',
    occurredAt: '2026-09-26T09:00:01.000Z'
  };
}

const policy = {
  assessedAt: '2026-09-26T09:05:00.000Z',
  maxAgeMs: 10 * 60_000,
  maxFutureSkewMs: 0,
  eventLimit: 1000
};

describe('unified consumer health', () => {
  it('emits one schema-valid report for every registered consumer', async () => {
    const logs = new MemoryDataAccessLogStore();
    const sheets = new MemoryDataStore();

    const report = await readConsumerHealth(logs, sheets, policy);

    expect(report.contractVersion).toBe(CONSUMER_HEALTH_CONTRACT_VERSION);
    expect(report.schemaVersion).toBe(CONSUMER_HEALTH_SCHEMA_VERSION);
    expect(report.status).toBe('BLOCKED');
    expect(report.consumers).toHaveLength(8);
    expect(new Set(report.consumers.map((item) => item.consumerId))).toEqual(
      new Set([
        'erp-com-public-catalog',
        'erp-whitelabel-catalogs',
        'freepass-admin-catalog',
        'freepass-sales-catalog',
        'freepass-estimate-catalog',
        'kakao-ops-catalog',
        'google-sheets-f01',
        'google-sheets-f86'
      ])
    );
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it('shows a fresh ERP.com gateway read as DEGRADED and ready for SHADOW_READ', async () => {
    const logs = new MemoryDataAccessLogStore();
    await logs.appendDataAccessEvent(erpSuccess());

    const report = await readConsumerHealth(
      logs,
      new MemoryDataStore(),
      policy
    );
    const erp = report.consumers.find(
      (item) => item.consumerId === 'erp-com-public-catalog'
    )!;

    expect(erp).toMatchObject({
      status: 'DEGRADED',
      currentStage: 'OBSERVE',
      nextStage: 'SHADOW_READ',
      evidence: {
        source: 'GATEWAY_RUNTIME',
        state: 'SUCCEEDED',
        eventId: 'evt_erp_success',
        releaseAuthority: 'CANONICAL_ACTIVE',
        projectionId: 'erp-public',
        releaseId: 'rel_erp_health',
        manifestId: 'manifest_erp_health',
        authenticated: true,
        freepassReadVerified: true,
        productionReadbackVerified: false
      },
      nextTransition: {
        allowed: true,
        from: 'OBSERVE',
        to: 'SHADOW_READ',
        blockers: []
      },
      blockers: []
    });
    expect(erp.staticHoldReasons.length).toBeGreaterThan(0);
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it('keeps White Label aggregate, unimplemented Sales and unobserved Estimate explicitly BLOCKED', async () => {
    const report = await readConsumerHealth(
      new MemoryDataAccessLogStore(),
      new MemoryDataStore(),
      policy
    );
    const byId = new Map(report.consumers.map((item) => [item.consumerId, item]));

    expect(byId.get('erp-whitelabel-catalogs')).toMatchObject({
      status: 'BLOCKED',
      evidence: {
        source: 'WHITELABEL_AGGREGATE',
        state: 'AGGREGATE_REQUIRES_IDENTITIES'
      }
    });
    expect(byId.get('freepass-sales-catalog')).toMatchObject({
      status: 'BLOCKED',
      evidence: {
        source: 'NOT_IMPLEMENTED',
        state: 'NOT_IMPLEMENTED'
      }
    });
    expect(byId.get('freepass-estimate-catalog')).toMatchObject({
      status: 'BLOCKED',
      evidence: {
        source: 'GATEWAY_RUNTIME',
        state: 'UNOBSERVED'
      }
    });
  });

  it('uses dedicated Sheet delivery health rather than generic access logs for F01/F86', async () => {
    const report = await readConsumerHealth(
      new MemoryDataAccessLogStore(),
      new MemoryDataStore(),
      policy
    );

    for (const id of ['google-sheets-f01', 'google-sheets-f86']) {
      const sheet = report.consumers.find((item) => item.consumerId === id)!;
      expect(sheet).toMatchObject({
        status: 'BLOCKED',
        evidence: {
          source: 'SHEET_DELIVERY',
          state: 'UNOBSERVED',
          eventId: null,
          receiptId: null
        }
      });
      expect(sheet.blockers).toEqual(
        expect.arrayContaining([
          'missing evidence: authenticationVerified',
          'missing evidence: freepassReadVerified'
        ])
      );
    }
  });

  it('pins schema identity to runtime contract constants', () => {
    expect(healthSchema.properties.contractVersion.const)
      .toBe(CONSUMER_HEALTH_CONTRACT_VERSION);
    expect(healthSchema.properties.schemaVersion.const)
      .toBe(CONSUMER_HEALTH_SCHEMA_VERSION);
  });
});
