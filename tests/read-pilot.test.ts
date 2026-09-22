import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkReadPilot, type ReadPilotInput, type PilotRow } from '../src/migration/read-pilot.js';

const now = '2026-09-21T10:00:00Z';
function fixture(): ReadPilotInput {
  const observation = {
    sourceId: 'synthetic-source', sourceRevision: 'revision-1', scope: 'synthetic-scope',
    observedAt: '2026-09-21T09:59:00Z', complete: true, evidenceRef: 'synthetic://observation'
  };
  const row: PilotRow = {
    productId: 'product-a', vehicleId: 'asset-a', offerId: 'offer-a', supplierId: 'supplier-a',
    termKey: '24-return', termMonths: 24, commercialType: 'USED_RENT', status: 'AVAILABLE',
    listable: true, monthlyRent: 500000, currency: 'KRW', depositState: 'ZERO',
    depositAmount: 0, mileageLimitKmPerYear: 20000
  };
  const snapshot = { ...observation, mapperVersion: 'synthetic/v1', expectedRowCount: 1, rows: [row] };
  return JSON.parse(JSON.stringify({
    version: 'read-pilot/v1', consumerId: 'ERP_COM', maxAgeMs: 300000,
    upstream: snapshot, legacy: snapshot,
    freepass: { ...snapshot, release: { releaseId: 'synthetic-release', schemaVersion: 'catalog/v1',
      inputDigest: 'a'.repeat(64), dataDigest: 'b'.repeat(64), activatedAt: '2026-09-21T09:58:00Z' } }
  }));
}

describe('offline consumer read pilot', () => {
  it('compares supplied evidence only, never authorizes a cutover', () => {
    const input = fixture();
    // Ensure independently mutable snapshots, as a real separate observation would be.
    input.freepass.rows = structuredClone(input.freepass.rows);
    const result = checkReadPilot(input, now);
    expect(result.status).toBe('SNAPSHOT_MATCH');
    expect(result.cutoverAuthorized).toBe(false);
    expect(result.scope).toBe('OFFLINE_SUPPLIED_EVIDENCE_ONLY');
    expect(result.evidenceDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ['vehicleId', 'asset-b'], ['supplierId', 'supplier-b'], ['termMonths', 36],
    ['commercialType', 'OGONG_SUBSCRIPTION'], ['status', 'RESERVED'], ['listable', false],
    ['monthlyRent', 510000], ['mileageLimitKmPerYear', 30000]
  ])('detects field drift in %s without printing values', (field, value) => {
    const input = fixture();
    input.freepass.rows = structuredClone(input.freepass.rows);
    Object.assign(input.freepass.rows[0]!, { [field]: value });
    const result = checkReadPilot(input, now);
    expect(result.status).toBe('MISMATCH');
    expect(result.differences[0]!.fields).toContain(field);
    expect(JSON.stringify(result)).not.toContain('asset-a');
  });

  it('detects price term omissions and additions, not just product counts', () => {
    const input = fixture();
    input.freepass.rows = [{ ...input.freepass.rows[0]!, termKey: '36-return', termMonths: 36 }];
    const result = checkReadPilot(input, now);
    expect(result.status).toBe('MISMATCH');
    expect(result.differences.flatMap(item => item.fields).sort()).toEqual(['EXTRA_VS_UPSTREAM', 'MISSING_VS_UPSTREAM']);
  });

  it.each(['upstream', 'legacy', 'freepass'] as const)('rejects duplicate and empty %s observations', name => {
    const input = fixture();
    input[name].rows = [input[name].rows[0]!, input[name].rows[0]!];
    input[name].expectedRowCount = 2;
    expect(checkReadPilot(input, now).reasons).toContain(`${name}:DUPLICATE_ROW_KEY`);
    input[name].rows = [];
    input[name].expectedRowCount = 0;
    expect(checkReadPilot(input, now).status).toBe('HOLD');
  });

  it.each(['upstream', 'legacy', 'freepass'] as const)('requires fresh complete %s evidence', name => {
    const input = fixture();
    input[name].complete = false;
    expect(checkReadPilot(input, now).status).toBe('HOLD');
    input[name].complete = true;
    for (const value of ['invalid', '2026-09-20T09:59:00Z', '2026-09-21T10:01:00Z']) {
      input[name].observedAt = value;
      expect(checkReadPilot(input, now).status).toBe('HOLD');
    }
  });

  it('holds even when both downstream snapshots agree with the same stale upstream revision', () => {
    const input = fixture();
    input.upstream.sourceRevision = 'revision-2';
    expect(checkReadPilot(input, now).reasons).toContain('legacy:UPSTREAM_sourceRevision_MISMATCH');
  });

  it('detects both downstreams carrying the same wrong price despite matching revision labels', () => {
    const input = fixture();
    input.legacy.rows[0]!.monthlyRent = 600000;
    input.freepass.rows[0]!.monthlyRent = 600000;
    const result = checkReadPilot(input, now);
    expect(result.status).toBe('MISMATCH');
    expect(result.differences.map(item => item.target)).toEqual(['legacy', 'freepass']);
  });

  it('detects the same omitted row in both downstreams', () => {
    const input = fixture();
    input.upstream.rows.push({ ...input.upstream.rows[0]!, productId: 'product-b', listable: false });
    input.upstream.expectedRowCount = 2;
    expect(checkReadPilot(input, now).differences).toHaveLength(2);
  });

  it.each(['sourceId', 'scope', 'sourceRevision'] as const)('requires identical %s', field => {
    const input = fixture();
    input.freepass[field] = 'different';
    expect(checkReadPilot(input, now).status).toBe('HOLD');
  });

  it.each([
    { depositState: 'UNKNOWN', depositAmount: null }, { depositState: 'ZERO', depositAmount: 1 },
    { depositState: 'KNOWN', depositAmount: null }, { mileageLimitKmPerYear: null },
    { monthlyRent: null }, { commercialType: 'UNKNOWN' }, { status: 'UNKNOWN' }
  ])('does not turn unknown/contradictory commercial facts into parity', mutation => {
    const input = fixture();
    Object.assign(input.legacy.rows[0]!, mutation);
    expect(checkReadPilot(input, now).status).toBe('HOLD');
  });

  it('detects known deposit difference', () => {
    const input = fixture();
    input.freepass.rows = [{ ...input.freepass.rows[0]!, depositState: 'KNOWN', depositAmount: 1000000 }];
    expect(checkReadPilot(input, now).differences[0]!.fields).toEqual(['depositState', 'depositAmount']);
  });

  it('rejects unsupported field loss rather than silently ignoring it', () => {
    const input = fixture();
    Object.assign(input.legacy.rows[0]!, { returnCondition: 'not-yet-mapped' });
    expect(checkReadPilot(input, now).status).toBe('HOLD');
  });

  it('requires release evidence, valid policy and actual rows', () => {
    for (const raw of [null, {}, { ...fixture(), maxAgeMs: 0 }, { ...fixture(), maxAgeMs: '300000' }]) {
      expect(checkReadPilot(raw, now).status).toBe('HOLD');
    }
    const input = fixture();
    input.freepass.release.dataDigest = '';
    expect(checkReadPilot(input, now).status).toBe('HOLD');
    input.freepass.release.dataDigest = 'b'.repeat(64);
    input.freepass.release.activatedAt = '2026-09-21T09:59:30Z';
    expect(checkReadPilot(input, now).status).toBe('HOLD');
    input.freepass.expectedRowCount = 2;
    expect(checkReadPilot(input, now).status).toBe('HOLD');
  });

  it('rejects whitespace identity aliases and impossible timestamps', () => {
    const input = fixture();
    input.legacy.rows[0]!.productId = ' product-a';
    expect(checkReadPilot(input, now).status).toBe('HOLD');
    expect(checkReadPilot(fixture(), '2026-02-30T10:00:00Z').status).toBe('HOLD');
  });

  it('rejects JSON array coercion into enums and release digests', () => {
    const input = fixture();
    Object.assign(input, { consumerId: ['ERP_COM'] });
    expect(checkReadPilot(input, now).status).toBe('HOLD');
    const deposit = fixture();
    Object.assign(deposit.legacy.rows[0]!, { depositState: ['ZERO'], depositAmount: 999999 });
    expect(checkReadPilot(deposit, now).status).toBe('HOLD');
    const release = fixture();
    Object.assign(release.freepass.release, { dataDigest: ['b'.repeat(64)] });
    expect(checkReadPilot(release, now).status).toBe('HOLD');
  });

  it('does not merge supplier/vehicle differences into a silently surviving duplicate', () => {
    const input = fixture();
    input.upstream.rows.push({ ...input.upstream.rows[0]!, supplierId: 'supplier-b', vehicleId: 'asset-b' });
    input.upstream.expectedRowCount = 2;
    expect(checkReadPilot(input, now).reasons).toContain('upstream:DUPLICATE_ROW_KEY');
  });

  it('preserves explicit zero rent rather than treating zero as missing', () => {
    const input = fixture();
    for (const name of ['upstream', 'legacy', 'freepass'] as const) input[name].rows[0]!.monthlyRent = 0;
    expect(checkReadPilot(input, now).status).toBe('SNAPSHOT_MATCH');
  });
});

describe('read pilot CLI', () => {
  it.each(['match', 'mismatch', 'hold', 'malformed'] as const)('returns the correct %s exit without starting Firestore', mode => {
    const directory = mkdtempSync(join(tmpdir(), 'freepass-read-pilot-'));
    const file = join(directory, 'evidence.json');
    try {
      const input = fixture();
      for (const name of ['upstream', 'legacy', 'freepass'] as const) {
        input[name].observedAt = new Date(Date.now() - 1000).toISOString();
      }
      input.freepass.release.activatedAt = new Date(Date.now() - 2000).toISOString();
      if (mode === 'mismatch') input.freepass.rows[0]!.monthlyRent += 1;
      if (mode === 'hold') input.upstream.complete = false;
      writeFileSync(file, mode === 'malformed' ? '{invalid' : JSON.stringify(input));
      const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/jobs/check-read-pilot.ts', file], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 10000,
        env: { ...process.env, FREEPASS_DATA_DRIVER: 'firestore', FIREBASE_PROJECT_ID: 'invalid-synthetic-no-access' }
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(mode === 'match' ? 0 : mode === 'mismatch' ? 1 : 2);
      if (mode !== 'malformed') expect(JSON.parse(result.stdout).cutoverAuthorized).toBe(false);
      else expect(result.stderr).toContain('HOLD');
    } finally {
      unlinkSync(file);
      rmdirSync(directory);
    }
  });
});
