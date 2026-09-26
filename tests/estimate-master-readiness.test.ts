import { describe, expect, it } from 'vitest';
import { assessEstimateMasterReadiness } from '../src/application/estimate-master-readiness.js';

const digest = 'a'.repeat(64);
const at = '2026-09-26T11:00:00.000Z';

describe('Estimate master readiness', () => {
  it('is BLOCKED when no canonical trim can become ACTIVE', () => {
    const value = assessEstimateMasterReadiness({
      summary: {
        total: 2, active: 0, hold: 2, activeRate: 0,
        inputDigest: digest,
        holdReasons: [
          { reason: 'PRODUCT_ID_BRIDGE_UNVERIFIED', count: 2 },
          { reason: 'COLOR_DOMAIN_UNVERIFIED', count: 2 },
        ],
      },
    }, at);
    expect(value.status).toBe('BLOCKED');
    expect(value.activeReleaseAuthorized).toBe(false);
    expect(value.blockers).toEqual(expect.arrayContaining([
      'NO_ACTIVE_ESTIMATE_MASTER_RECORDS',
      'PRODUCT_ID_BRIDGE_UNVERIFIED',
      'COLOR_DOMAIN_UNVERIFIED',
    ]));
  });

  it('is DEGRADED when only part of the canonical set is ready', () => {
    const value = assessEstimateMasterReadiness({
      summary: {
        total: 4, active: 3, hold: 1, activeRate: 0.75,
        inputDigest: digest,
        holdReasons: [{ reason: 'PRICE_BASIS_UNVERIFIED', count: 1 }],
      },
    }, at);
    expect(value.status).toBe('DEGRADED');
    expect(value.blockers).toContain('PARTIAL_ESTIMATE_MASTER_HOLD');
  });

  it('is READY only when every record is ACTIVE, without authorizing publication', () => {
    const value = assessEstimateMasterReadiness({
      summary: {
        total: 4, active: 4, hold: 0, activeRate: 1,
        inputDigest: digest, holdReasons: [],
      },
    }, at);
    expect(value.status).toBe('READY');
    expect(value.blockers).toEqual([]);
    expect(value.activeReleaseAuthorized).toBe(false);
    expect(value.publicationImplemented).toBe(false);
  });

  it('rejects internally inconsistent counts', () => {
    expect(() => assessEstimateMasterReadiness({
      summary: {
        total: 2, active: 2, hold: 1, activeRate: 1,
        inputDigest: digest, holdReasons: [],
      },
    }, at)).toThrow('ESTIMATE_MASTER_READINESS_INVALID');
  });
});
