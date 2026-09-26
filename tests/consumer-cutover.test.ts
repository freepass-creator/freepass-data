import { describe, expect, it } from 'vitest';
import {
  CONSUMER_SWITCH_REGISTRY,
  evaluateConsumerCutover,
  findConsumerSwitch,
  type ConsumerSwitchRegistration
} from '../src/domain/consumer-cutover.js';

function readyRegistration(
  stage: ConsumerSwitchRegistration['stage']
): ConsumerSwitchRegistration {
  return {
    consumerId: 'test-consumer',
    project: 'Test',
    repository: 'test/repo',
    domains: ['catalog'],
    stage,
    activeReadOwner: 'legacy',
    targetReadOwner: 'freepass-data',
    switchKey: 'FREEPASS_DATA_TEST_READ_MODE',
    evidence: {
      contractReady: true,
      authenticationVerified: true,
      legacyReadVerified: true,
      freepassReadVerified: true,
      parityVerified: true,
      fallbackVerified: true,
      productionReadbackVerified: true,
      approvedRelease: {
        projectionId: 'erp-public',
        releaseId: 'rel_test',
        manifestId: 'manifest_test',
        inputDigest: 'input_digest_test',
        dataDigest: 'data_digest_test',
        observedAt: '2026-09-25T00:00:00.000Z'
      }
    },
    holdReasons: []
  };
}

describe('consumer cutover registry', () => {
  it('registers each currently identified consumer separately', () => {
    expect(CONSUMER_SWITCH_REGISTRY.map((item) => item.consumerId)).toEqual([
      'erp-com-public-catalog',
      'erp-whitelabel-catalogs',
      'freepass-admin-catalog',
      'freepass-sales-catalog',
      'freepass-estimate-catalog',
      'kakao-ops-catalog',
      'google-sheets-f01',
      'google-sheets-f86'
    ]);
    expect(new Set(CONSUMER_SWITCH_REGISTRY.map((item) => item.switchKey)).size)
      .toBe(CONSUMER_SWITCH_REGISTRY.length);
  });

  it('does not allow stages to be skipped', () => {
    const decision = evaluateConsumerCutover(
      readyRegistration('LEGACY_DIRECT'),
      'SHADOW_READ'
    );
    expect(decision.allowed).toBe(false);
    expect(decision.blockers).toContain(
      'stage skip is forbidden: LEGACY_DIRECT -> SHADOW_READ'
    );
  });

  it('requires authenticated dual reads before shadow mode', () => {
    const registration = readyRegistration('OBSERVE');
    registration.evidence.authenticationVerified = false;
    registration.evidence.freepassReadVerified = false;

    const decision = evaluateConsumerCutover(registration, 'SHADOW_READ');
    expect(decision.allowed).toBe(false);
    expect(decision.blockers).toEqual([
      'missing evidence: authenticationVerified',
      'missing evidence: freepassReadVerified'
    ]);
  });

  it('requires an exact approved FreePass Data release before parity can be accepted', () => {
    const registration = readyRegistration('SHADOW_READ');
    registration.evidence.approvedRelease = null;

    const decision = evaluateConsumerCutover(registration, 'PARITY_VERIFIED');
    expect(decision.allowed).toBe(false);
    expect(decision.blockers).toEqual([
      'missing evidence: approvedRelease'
    ]);
  });

  it('rejects malformed approved release evidence fail-closed', () => {
    const registration = readyRegistration('SHADOW_READ');
    registration.evidence.approvedRelease!.observedAt = 'not-a-date';

    const decision = evaluateConsumerCutover(registration, 'PARITY_VERIFIED');
    expect(decision.allowed).toBe(false);
    expect(decision.blockers).toEqual([
      'invalid approvedRelease: observedAt'
    ]);
  });

  it('requires parity, recovery and production readback before the final switch', () => {
    const registration = readyRegistration('PARITY_VERIFIED');
    registration.evidence.fallbackVerified = false;
    registration.evidence.productionReadbackVerified = false;

    const decision = evaluateConsumerCutover(registration, 'FREEPASS_DATA_READ');
    expect(decision.allowed).toBe(false);
    expect(decision.blockers).toEqual([
      'missing evidence: fallbackVerified',
      'missing evidence: productionReadbackVerified'
    ]);
  });

  it('allows one verified stage transition', () => {
    expect(
      evaluateConsumerCutover(
        readyRegistration('PARITY_VERIFIED'),
        'FREEPASS_DATA_READ'
      )
    ).toEqual({
      allowed: true,
      from: 'PARITY_VERIFIED',
      to: 'FREEPASS_DATA_READ',
      blockers: []
    });
  });

  it('records Admin as integrated while keeping runtime cutover evidence on HOLD', () => {
    const admin = findConsumerSwitch('freepass-admin-catalog');
    expect(admin).not.toBeNull();
    expect(admin?.evidence.contractReady).toBe(true);
    expect(admin?.stage).toBe('OBSERVE');
    expect(admin?.holdReasons).toEqual([
      'Admin consumer authentication and production FreePass Data readback are not verified',
      'Policy parity and production persistence are not verified'
    ]);
  });

  it('keeps the current real consumers blocked from final cutover', () => {
    for (const registration of CONSUMER_SWITCH_REGISTRY) {
      const decision = evaluateConsumerCutover(registration, 'FREEPASS_DATA_READ');
      expect(decision.allowed, registration.consumerId).toBe(false);
    }
  });

  it('finds a switch by stable consumer id', () => {
    expect(findConsumerSwitch('freepass-sales-catalog')?.project).toBe('FreePass Sales');
    expect(findConsumerSwitch('missing')).toBeNull();
  });
});
