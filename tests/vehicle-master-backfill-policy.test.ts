import { describe, expect, it } from 'vitest';
import {
  VEHICLE_MASTER_BACKFILL_SOURCES,
  vehicleMasterBackfillPolicy,
} from '../src/domain/vehicle-master-backfill.js';

describe('vehicle master backfill source policy', () => {
  it('covers current/recent sources plus a deep historical source', () => {
    expect(VEHICLE_MASTER_BACKFILL_SOURCES.map((x) => x.key)).toEqual([
      'MANUFACTURER',
      'CARNOON',
      'DANAWA',
      'CARISYOU',
      'WIKICAR',
    ]);
    expect(vehicleMasterBackfillPolicy('CARNOON').historicalCoverage).toBe('RECENT');
    expect(vehicleMasterBackfillPolicy('DANAWA').historicalCoverage).toBe('RECENT');
    expect(vehicleMasterBackfillPolicy('CARISYOU').historicalCoverage).toBe('DEEP');
  });

  it('keeps WikiCar discovery-only and outside canonical corroboration', () => {
    const policy = vehicleMasterBackfillPolicy('WIKICAR');
    expect(policy.discoveryOnly).toBe(true);
    expect(policy.countsAsCanonicalCorroboration).toBe(false);
  });

  it('keeps manufacturer evidence at highest priority even without a generic inventory URL', () => {
    const policy = vehicleMasterBackfillPolicy('MANUFACTURER');
    expect(policy.priority).toBe(100);
    expect(policy.discoveryUrl).toBeNull();
    expect(policy.countsAsCanonicalCorroboration).toBe(true);
  });
});
