import { describe, expect, it } from 'vitest';
import {
  buildConsumerRuntimeEvidenceReport
} from '../src/application/consumer-runtime-evidence.js';
import type { DataAccessEvent } from '../src/domain/data-access.js';

const INPUT = 'a'.repeat(64);
const DATA = 'b'.repeat(64);

function event(overrides: Partial<DataAccessEvent> = {}): DataAccessEvent {
  return {
    contractVersion: 'data-access-event-v1',
    eventId: 'evt_1',
    operationId: 'op_1',
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
    startedAt: '2026-09-26T08:00:00.000Z',
    occurredAt: '2026-09-26T08:00:01.000Z',
    result: {
      count: 100,
      digest: DATA,
      inputDigest: INPUT,
      releaseId: 'rel_erp_1',
      manifestId: 'manifest_erp_1',
      revision: 7
    },
    ...overrides
  };
}

const policy = {
  assessedAt: '2026-09-26T08:05:00.000Z',
  maxAgeMs: 10 * 60_000,
  maxFutureSkewMs: 0,
  eventLimit: 1000
};

function consumer(
  report: ReturnType<typeof buildConsumerRuntimeEvidenceReport>,
  id: string
) {
  const value = report.consumers.find((item) => item.consumerId === id);
  if (!value) throw new Error('consumer not found');
  return value;
}

describe('consumer runtime evidence overlay', () => {
  it('promotes a fresh authenticated catalog success into runtime read evidence', () => {
    const report = buildConsumerRuntimeEvidenceReport([event()], policy);
    const erp = consumer(report, 'erp-com-public-catalog');

    expect(erp.runtime).toMatchObject({
      source: 'GATEWAY',
      state: 'SUCCEEDED',
      clientId: 'erp-com',
      approvedRelease: {
        projectionId: 'erp-public',
        releaseId: 'rel_erp_1',
        manifestId: 'manifest_erp_1',
        inputDigest: INPUT,
        dataDigest: DATA,
        observedAt: '2026-09-26T08:00:01.000Z'
      }
    });
    expect(erp.staticEvidence).toMatchObject({
      authenticationVerified: false,
      freepassReadVerified: false,
      approvedRelease: null
    });
    expect(erp.effectiveEvidence).toMatchObject({
      authenticationVerified: true,
      freepassReadVerified: true,
      approvedRelease: {
        releaseId: 'rel_erp_1'
      }
    });
    expect(erp.nextTransition).toMatchObject({
      from: 'OBSERVE',
      to: 'SHADOW_READ',
      allowed: true,
      blockers: []
    });
  });

  it('uses the latest terminal runtime fact and blocks after a newer denial', () => {
    const success = event();
    const denied = event({
      eventId: 'evt_2',
      operationId: 'op_2',
      phase: 'DENIED',
      occurredAt: '2026-09-26T08:04:00.000Z',
      result: undefined,
      reasonCode: 'UNAUTHORIZED'
    });

    const erp = consumer(
      buildConsumerRuntimeEvidenceReport([success, denied], policy),
      'erp-com-public-catalog'
    );

    expect(erp.runtime).toMatchObject({
      state: 'DENIED',
      reasonCode: 'UNAUTHORIZED',
      blockers: ['RUNTIME_CONSUMER_READ_DENIED:UNAUTHORIZED']
    });
    expect(erp.effectiveEvidence.authenticationVerified).toBe(false);
    expect(erp.effectiveEvidence.freepassReadVerified).toBe(false);
    expect(erp.nextTransition?.allowed).toBe(false);
    expect(erp.nextTransition?.blockers).toEqual(expect.arrayContaining([
      'missing evidence: authenticationVerified',
      'missing evidence: freepassReadVerified',
      'RUNTIME_CONSUMER_READ_DENIED:UNAUTHORIZED'
    ]));
  });

  it('does not promote stale or future-dated runtime evidence', () => {
    const stale = consumer(
      buildConsumerRuntimeEvidenceReport([
        event({ occurredAt: '2026-09-26T07:00:00.000Z' })
      ], policy),
      'erp-com-public-catalog'
    );
    expect(stale.runtime.state).toBe('STALE');
    expect(stale.effectiveEvidence.freepassReadVerified).toBe(false);

    const future = consumer(
      buildConsumerRuntimeEvidenceReport([
        event({ occurredAt: '2026-09-26T08:06:00.000Z' })
      ], policy),
      'erp-com-public-catalog'
    );
    expect(future.runtime.state).toBe('FUTURE');
    expect(future.effectiveEvidence.freepassReadVerified).toBe(false);
  });

  it('fails closed when a successful event lacks complete release evidence', () => {
    const incomplete = event({
      result: {
        count: 100,
        digest: DATA,
        releaseId: 'rel_erp_1',
        manifestId: 'manifest_erp_1',
        revision: 7
      }
    });
    const erp = consumer(
      buildConsumerRuntimeEvidenceReport([incomplete], policy),
      'erp-com-public-catalog'
    );

    expect(erp.runtime).toMatchObject({
      state: 'FAILED',
      reasonCode: 'INCOMPLETE_RELEASE_EVIDENCE',
      blockers: ['RUNTIME_CONSUMER_RELEASE_EVIDENCE_INCOMPLETE']
    });
    expect(erp.effectiveEvidence.approvedRelease).toBeNull();
  });

  it('does not promote an aggregate White Label from one tenant identity', () => {
    const whiteLabel = event({
      eventId: 'evt_wl',
      operationId: 'op_wl',
      actor: { id: 'consumer:whitelabel-alpha', kind: 'SERVICE' },
      clientId: 'whitelabel-alpha'
    });

    const aggregate = consumer(
      buildConsumerRuntimeEvidenceReport([whiteLabel], policy),
      'erp-whitelabel-catalogs'
    );

    expect(aggregate.runtime).toMatchObject({
      state: 'AGGREGATE_REQUIRES_IDENTITIES',
      observedClientIds: ['whitelabel-alpha'],
      blockers: ['WHITELABEL_AGGREGATE_REQUIRES_ALL_REGISTERED_IDENTITIES']
    });
    expect(aggregate.effectiveEvidence.authenticationVerified).toBe(false);
    expect(aggregate.effectiveEvidence.freepassReadVerified).toBe(false);
  });

  it('keeps Sheet consumers on their dedicated durable delivery evidence source', () => {
    const report = buildConsumerRuntimeEvidenceReport([], policy);
    for (const id of ['google-sheets-f01', 'google-sheets-f86']) {
      const sheet = consumer(report, id);
      expect(sheet.runtime).toMatchObject({
        source: 'SHEET_DELIVERY_EVIDENCE',
        state: 'SEPARATE_EVIDENCE_SOURCE',
        blockers: []
      });
    }
  });

  it('does not invent Estimate runtime proof merely because its integration branch exists', () => {
    const estimate = consumer(
      buildConsumerRuntimeEvidenceReport([], policy),
      'freepass-estimate-catalog'
    );

    expect(estimate.stage).toBe('LEGACY_DIRECT');
    expect(estimate.staticEvidence.contractReady).toBe(false);
    expect(estimate.runtime.state).toBe('UNOBSERVED');
    expect(estimate.effectiveEvidence.contractReady).toBe(false);
    expect(estimate.nextTransition).toMatchObject({
      from: 'LEGACY_DIRECT',
      to: 'OBSERVE',
      allowed: true
    });
  });

  it('reports an incomplete latest operation instead of trusting an older success', () => {
    const started: DataAccessEvent = event({
      eventId: 'evt_3',
      operationId: 'op_3',
      phase: 'STARTED',
      occurredAt: '2026-09-26T08:04:30.000Z',
      result: undefined
    });
    const erp = consumer(
      buildConsumerRuntimeEvidenceReport([event(), started], policy),
      'erp-com-public-catalog'
    );

    expect(erp.runtime).toMatchObject({
      state: 'INCOMPLETE',
      blockers: ['LATEST_RUNTIME_OPERATION_INCOMPLETE']
    });
    expect(erp.nextTransition?.allowed).toBe(false);
  });
});
