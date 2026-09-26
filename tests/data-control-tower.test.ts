import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from '../contracts/freepass-data-control-tower-v1.schema.json' with { type: 'json' };
import {
  buildDataControlTower,
  DATA_CONTROL_TOWER_CONTRACT_VERSION,
  DATA_CONTROL_TOWER_SCHEMA_VERSION,
  type DataControlTowerInput
} from '../src/application/data-control-tower.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validate = ajv.compile(schema);

function input(): DataControlTowerInput {
  return {
    auditSchedule: {
      version: 'erp5-audit-schedule-health/1',
      configured: true,
      status: 'DEGRADED',
      reason: 'AUDIT_GAP_EXCEEDED',
      currentReadTime: '2026-09-26T10:00:00.000Z',
      previousReadTime: '2026-09-26T07:00:00.000Z',
      gapMinutes: 180,
      maxGapMinutes: 90
    },
    sourceInventory: {
      version: 'erp5-source-inventory/1',
      source: {
        projectId: 'freepasserp5',
        databaseId: '(default)',
        collections: {
          products: 321,
          policy: 17
        },
        readTime: '2026-09-26T10:00:00.000Z',
        digest: 'a'.repeat(64),
        coverage: 'FULL_SAME_READ_ONLY_TRANSACTION'
      },
      authority: {
        canonicalWriteAuthorized: false,
        destructiveActionAuthorized: false,
        activeReleaseAuthorized: false,
        publicationDecision: 'HOLD',
        publicationHoldReasons: [
          'REVIEW_APPROVALS_NOT_INCLUDED',
          'CANONICAL_RELEASE_NOT_BUILT'
        ]
      },
      runId: '12345-1'
    },
    consumerHealth: {
      configured: true,
      status: 'BLOCKED',
      generatedAt: '2026-09-26T10:00:01.000Z',
      counts: {
        HEALTHY: 0,
        DEGRADED: 1,
        BLOCKED: 7
      }
    },
    consumerReadiness: {
      configured: true,
      status: 'BLOCKED',
      generatedAt: '2026-09-26T10:00:02.000Z',
      counts: {
        readyForNextStage: 1,
        hold: 7,
        final: 0
      },
      readyTransitions: [
        {
          consumerId: 'erp-com-public-catalog',
          from: 'OBSERVE',
          to: 'SHADOW_READ'
        }
      ]
    },
    sheetHealth: {
      configured: true,
      status: 'BLOCKED',
      generatedAt: '2026-09-26T10:00:03.000Z'
    }
  };
}

describe('FreePass Data control tower', () => {
  it('preserves each operational axis and exposes operator counts without inventing one aggregate verdict', () => {
    const report = buildDataControlTower(input());

    expect(report.contractVersion)
      .toBe(DATA_CONTROL_TOWER_CONTRACT_VERSION);
    expect(report.schemaVersion)
      .toBe(DATA_CONTROL_TOWER_SCHEMA_VERSION);
    expect(report.runId).toBe('12345-1');
    expect(report.axes.sourceObservation).toMatchObject({
      status: 'OBSERVED',
      products: 321,
      policies: 17
    });
    expect(report.axes.auditFreshness).toMatchObject({
      status: 'DEGRADED',
      reason: 'AUDIT_GAP_EXCEEDED',
      gapMinutes: 180
    });
    expect(report.axes.publication).toMatchObject({
      decision: 'HOLD',
      activeReleaseAuthorized: false,
      canonicalWriteAuthorized: false
    });
    expect(report.operatorSummary).toEqual({
      readyTransitionCount: 1,
      consumerBlockedCount: 7,
      readinessHoldCount: 7,
      auditGapMinutes: 180,
      publicationHoldReasonCount: 2
    });
    expect(report.attention).toEqual(expect.arrayContaining([
      'AUDIT_SCHEDULE_DEGRADED',
      'PUBLICATION_HOLD',
      'CONSUMER_HEALTH_BLOCKED',
      'CONSUMER_READINESS_HOLD',
      'SHEET_HEALTH_BLOCKED'
    ]));
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it('keeps missing policies explicit instead of fabricating health counts', () => {
    const value = input();
    value.auditSchedule = {
      ...value.auditSchedule,
      configured: false,
      status: 'BLOCKED',
      reason: 'ERP5_AUDIT_MAX_GAP_MINUTES_NOT_CONFIGURED',
      gapMinutes: null,
      maxGapMinutes: null
    };
    value.consumerHealth = {
      configured: false,
      status: 'BLOCKED',
      reason: 'CONSUMER_HEALTH_MAX_AGE_MINUTES_NOT_CONFIGURED'
    };
    value.consumerReadiness = {
      configured: false,
      status: 'BLOCKED',
      reason: 'CONSUMER_READINESS_MAX_AGE_MINUTES_NOT_CONFIGURED'
    };
    value.sheetHealth = {
      configured: false,
      status: 'BLOCKED',
      reason: 'SHEET_EVIDENCE_MAX_AGE_MINUTES_NOT_CONFIGURED'
    };

    const report = buildDataControlTower(value);

    expect(report.operatorSummary).toMatchObject({
      readyTransitionCount: 0,
      consumerBlockedCount: null,
      readinessHoldCount: null,
      auditGapMinutes: null
    });
    expect(report.attention).toEqual(expect.arrayContaining([
      'AUDIT_SCHEDULE_BLOCKED',
      'HEALTH_POLICY_NOT_CONFIGURED',
      'READINESS_POLICY_NOT_CONFIGURED',
      'SHEET_POLICY_NOT_CONFIGURED',
      'PUBLICATION_HOLD'
    ]));
    expect(validate(report), JSON.stringify(validate.errors)).toBe(true);
  });

  it('fails closed when configured consumer totals are not the full registry coverage', () => {
    const value = input();
    value.consumerHealth.counts = {
      HEALTHY: 0,
      DEGRADED: 1,
      BLOCKED: 6
    };

    expect(() => buildDataControlTower(value))
      .toThrow('INVALID_CONTROL_TOWER_CONSUMER_HEALTH_COUNTS');
  });

  it('pins schema identity to runtime constants', () => {
    expect(schema.properties.contractVersion.const)
      .toBe(DATA_CONTROL_TOWER_CONTRACT_VERSION);
    expect(schema.properties.schemaVersion.const)
      .toBe(DATA_CONTROL_TOWER_SCHEMA_VERSION);
  });
});
