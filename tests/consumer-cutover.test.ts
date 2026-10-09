import { describe, expect, it } from 'vitest';
import {
  CONSUMER_SWITCH_REGISTRY,
  evaluateConsumerCutover,
  findConsumerSwitch,
  type ConsumerCutoverStage,
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

  it('never allows a migration bridge release to authorize final cutover', () => {
    const registration = readyRegistration('PARITY_VERIFIED');
    registration.evidence.approvedRelease = {
      ...registration.evidence.approvedRelease!,
      projectionId: 'sheet-publication-bridge'
    };

    const decision = evaluateConsumerCutover(
      registration,
      'FREEPASS_DATA_READ'
    );

    expect(decision.allowed).toBe(false);
    expect(decision.blockers).toContain(
      'migration bridge release cannot authorize final cutover'
    );
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

  it('keeps compatibility readback separate from ERP Canonical cutover evidence', () => {
    const erp = findConsumerSwitch('erp-com-public-catalog');
    expect(erp).not.toBeNull();
    expect(erp?.stage).toBe('OBSERVE');
    expect(erp?.evidence.contractReady).toBe(true);
    expect(erp?.evidence.authenticationVerified).toBe(false);
    expect(erp?.evidence.freepassReadVerified).toBe(false);
    expect(erp?.activeReadOwner).toBe('freepasserp5/products-policy');
    expect(erp?.holdReasons).toEqual([
      '2026-10-09T08:16:43.179Z: erp-com catalog-compat returned 200 with FREEPASS_DATA_COMPATIBILITY_BRIDGE; this is not Canonical or downstream cutover evidence',
      '2026-10-09: authenticated erp-com catalog returned 503; downstream active read mode and same-product/term parity remain unverified',
      '2026-10-09T08:27:51.878Z: ERP public feed retained 3890 UNKNOWN deposit terms as numeric zero without depositState; 752 omitted basic keys have equal-rent composite terms and are aliases, not missing distinct offers',
      'non-empty ACTIVE erp-public release parity and shadow latency require production evidence'
    ]);
  });

  it('keeps Estimate contractReady false until its canonical integration line is merged to product main', () => {
    const estimate = findConsumerSwitch('freepass-estimate-catalog');
    expect(estimate).not.toBeNull();
    expect(estimate?.stage).toBe('LEGACY_DIRECT');
    expect(estimate?.evidence.contractReady).toBe(false);
    expect(estimate?.holdReasons).toEqual([
      'Estimate FreePass Data integration is implemented on the canonical integration line but not merged to Estimate product main',
      'real ACTIVE estimate-newcar-master readback and cutover proof are not production-verified',
      'quote calculation and provider ownership must remain in Estimate'
    ]);
  });

  it('records Admin as integrated while keeping runtime cutover evidence on HOLD', () => {
    const admin = findConsumerSwitch('freepass-admin-catalog');
    expect(admin).not.toBeNull();
    expect(admin?.evidence.contractReady).toBe(true);
    expect(admin?.evidence.legacyReadVerified).toBe(true);
    expect(admin?.stage).toBe('OBSERVE');
    expect(admin?.holdReasons).toEqual([
      'Admin consumer authentication and production FreePass Data readback are not verified',
      'Admin intake-critical shadow parity remains incomplete; latest I-01 hardening PR is not merged to Admin main'
    ]);
  });

  it('never registers a current stage that its own minimum evidence cannot support', () => {
    for (const registration of CONSUMER_SWITCH_REGISTRY) {
      const current = evaluateConsumerCutover(registration, registration.stage);
      expect(current.allowed, registration.consumerId).toBe(true);
      expect(current.blockers, registration.consumerId).toEqual([]);
    }
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

  it('does not promote compatibility or reference observations into shadow or final cutover', () => {
    for (const id of ['erp-com-public-catalog', 'erp-whitelabel-catalogs', 'kakao-ops-catalog']) {
      const registration = findConsumerSwitch(id)!;
      expect(registration.evidence.approvedRelease).toBeNull();
      expect(registration.evidence.freepassReadVerified).toBe(false);
      expect(evaluateConsumerCutover(registration, 'SHADOW_READ').allowed).toBe(false);
      expect(evaluateConsumerCutover(registration, 'FREEPASS_DATA_READ').allowed).toBe(false);
    }
    const kakao = findConsumerSwitch('kakao-ops-catalog')!;
    expect(kakao.holdReasons.some(reason => reason.includes('REFERENCE_ONLY/HOLD'))).toBe(true);
    expect(kakao.holdReasons.some(reason => reason.includes('token is not provisioned'))).toBe(false);
  });

  it('retains F86 only as historical evidence after the current publication target changed', () => {
    const f86 = findConsumerSwitch('google-sheets-f86')!;
    expect(f86.holdReasons.some(reason => reason.includes('not an active product publication target'))).toBe(true);
    expect(evaluateConsumerCutover(f86, 'FREEPASS_DATA_READ').allowed).toBe(false);
  });

  it('fails closed on unsupported stages rather than treating index -1 as a valid transition', () => {
    const registration = readyRegistration('OBSERVE');
    expect(evaluateConsumerCutover(registration, 'ACTIVE' as ConsumerCutoverStage)).toMatchObject({
      allowed: false, blockers: ['invalid consumer cutover stage']
    });
    registration.stage = 'ACTIVE' as ConsumerCutoverStage;
    expect(evaluateConsumerCutover(registration, 'LEGACY_DIRECT').allowed).toBe(false);
  });
});
