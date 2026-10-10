import { describe, expect, it, vi } from 'vitest';
import { createSonogongErpReader, SONOGONG_READER_POLICY as policy } from '../src/adapters/sonogong-erp-reader.js';
import { sonogongSourceAdapter } from '../src/adapters/supplier-source-capture.js';
import { collectSupplierSource } from '../src/domain/source-intake.js';
import { runSonogongCollection } from '../src/jobs/collect-sonogong.js';
import { compareSonogongDeposits } from '../src/domain/sonogong-deposit-comparison.js';

// All values below are fabricated; no operational fixture or account is used.
const sentinel = 'SYNTHETIC_SECRET_SENTINEL';
const bucket = 'LOW_SONOKONG' as const;
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const row = (id = 'fake-item') => ({ id, carNumber: 'SYNTHETIC-VEHICLE', carSource: 'SON_NO_KONG' });
const estimate = (extra = {}) => ({ estimateType: 'SUBSCRIBE_RETURN', creditType: 'LOW', monthly24: 400_000,
  securityDepositAmount: 0, ...extra });
const detail = (id = 'fake-item') => ({ ...row(id), estimates: [estimate()] });

function fixture(hook?: (url: URL, init: RequestInit) => Response | undefined | Promise<Response | undefined>) {
  let clock = Date.parse('2026-10-10T00:00:00Z');
  const sleeps: number[] = [], starts: number[] = [];
  let logins = 0, active = 0, peak = 0;
  const fakeFetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    active++; peak = Math.max(active, peak); starts.push(clock);
    try {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/auth/login')) {
        logins++;
        const jwt = `fake.${Buffer.from(JSON.stringify({ exp: Math.floor(clock / 1000) + 7200 })).toString('base64url')}.${sentinel}`;
        return (await hook?.(u, init ?? {})) ?? json({ data: { accessToken: jwt } });
      }
      const custom = await hook?.(u, init ?? {});
      if (custom) return custom;
      if (u.pathname.endsWith('/list')) return json({ success: true, data: { data: [row()], attrs: { totalCount: 1, currentPage: 1 } } });
      return json({ success: true, data: detail(decodeURIComponent(u.pathname.split('/').at(-1)!)) });
    } finally { active--; }
  }) as unknown as typeof fetch;
  const reader = createSonogongErpReader({ accountJson: async () => JSON.stringify({ id: 'fake-id', password: sentinel }),
    fetch: fakeFetch, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; } });
  return { reader, fakeFetch, sleeps, starts, now: () => clock, advance: (ms: number) => { clock += ms; },
    stats: () => ({ logins, peak }) };
}

describe('Sonogong ERP reader: offline transport contract', () => {
  it('reuses memory token, refreshes before expiry, preserves estimates and original envelopes', async () => {
    const f = fixture();
    const first = await f.reader.readBucket(bucket);
    expect(first.records[0]?.detail).toEqual(detail());
    expect(first.records[0]?.detailResponse).toEqual({ success: true, data: detail() });
    await f.reader.readBucket('LOW_TCAR');
    expect(f.stats().logins).toBe(1);
    f.advance(7200_000);
    await f.reader.readBucket(bucket);
    expect(f.stats().logins).toBe(2);
  });
  it('single-flight login and globally bounded concurrency/interval even with concurrent bucket calls', async () => {
    const f = fixture(async () => { await Promise.resolve(); return undefined; });
    await Promise.all([f.reader.readBucket(bucket), f.reader.readBucket('LOW_TCAR')]);
    expect(f.stats().logins).toBe(1);
    expect(f.stats().peak).toBeLessThanOrEqual(2);
    expect(f.stats().peak).toBe(policy.concurrency);
    expect(f.starts.slice(1).every((v, i) => v - f.starts[i]! >= policy.minIntervalMs)).toBe(true);
  });
  it('retries 401 once with a fresh token', async () => {
    let denied = false;
    const f = fixture(u => {
      if (u.pathname.endsWith('/list') && !denied) { denied = true; return json({ error: sentinel }, 401); }
    });
    await f.reader.readBucket(bucket);
    expect(f.stats().logins).toBe(2);
    const repeated = fixture(u => u.pathname.endsWith('/list') ? json({ error: sentinel }, 401) : undefined);
    await expect(repeated.reader.readBucket(bucket)).rejects.toThrow('SONOGONG_AUTH_FAILED');
    expect(repeated.stats().logins).toBe(2);
  });
  it('collects every page and does not normalize numeric strings', async () => {
    const f = fixture(u => {
      if (u.pathname.endsWith('/list')) {
        const page = Number(u.searchParams.get('page'));
        return json({ data: { data: [row(`fake-${page}`)], attrs: { totalCount: 2, currentPage: page } } });
      }
      if (u.pathname.includes('/view/')) return json({ data: { ...row(u.pathname.split('/').at(-1)),
        estimates: [estimate({ monthly24: '400000', securityDepositAmount: null })] } });
    });
    const result = await f.reader.readBucket(bucket);
    expect(result.complete).toBe(true);
    expect(result.records).toHaveLength(2);
    expect(result.listResponses).toHaveLength(2);
    expect(result.records[1]?.detail?.estimates).toEqual([estimate({ monthly24: '400000', securityDepositAmount: null })]);
  });
  it('marks individual detail failure PARTIAL/HOLD and never writes or retires', async () => {
    const f = fixture(u => u.pathname.includes('/view/') ? json({ message: sentinel }, 404) : undefined);
    const ingest = vi.fn();
    const result = await runSonogongCollection({ args: [], env: {}, reader: f.reader, now: f.now, ingest });
    expect(result).toMatchObject({ status: 'HOLD', coverage: 'PARTIAL', writeExecuted: false, retirementAuthorized: false });
    expect(result.buckets.every(b => b.detailFailure === 1)).toBe(true);
    expect(ingest).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });
  it.each([429, 500, 503])('bounds %i backoff and stops with a fixed HOLD error', async status => {
    const f = fixture(u => u.pathname.endsWith('/list') ? json({ error: sentinel }, status) : undefined);
    await expect(f.reader.readBucket(bucket)).rejects.toThrow('SONOGONG_RETRY_EXHAUSTED');
    expect(vi.mocked(f.fakeFetch).mock.calls).toHaveLength(1 + policy.maxRetries + 1);
    expect(f.sleeps.filter(ms => ms >= policy.backoffMs)).toEqual([500, 1000, 2000]);
  });
  it('exhausted detail backoff is HOLD, not an empty successful bucket', async () => {
    const f = fixture(u => u.pathname.includes('/view/') ? json({}, 503) : undefined);
    await expect(f.reader.readBucket(bucket)).rejects.toThrow('SONOGONG_RETRY_EXHAUSTED');
  });
  it('recovers from a transient server failure', async () => {
    let count = 0;
    const f = fixture(u => u.pathname.endsWith('/list') && count++ === 0 ? json({}, 503) : undefined);
    expect((await f.reader.readBucket(bucket)).complete).toBe(true);
  });
  it('rejects stale flag, old source clock, cached HTTP age, and malformed source time', async () => {
    for (const fields of [{ stale: true }, { syncedAt: '2020-01-01T00:00:00Z' }, { syncedAt: sentinel }]) {
      const f = fixture(u => u.pathname.endsWith('/list') ? json({ ...fields, data: { data: [row()], attrs: { totalCount: 1 } } }) : undefined);
      await expect(f.reader.readBucket(bucket)).rejects.toThrow(/SONOGONG_(STALE|SOURCE_TIME_INVALID)/);
    }
    const f = fixture(u => u.pathname.endsWith('/list') ? new Response(JSON.stringify({ data: {} }), { headers: { age: '7200' } }) : undefined);
    await expect(f.reader.readBucket(bucket)).rejects.toThrow('SONOGONG_STALE');
  });
  it('rejects malformed pagination, duplicate IDs, empty truncation and detail limit', async () => {
    for (const data of [
      { data: [row()], attrs: {} },
      { data: [row(), row()], attrs: { totalCount: 2 } },
      { data: [], attrs: { totalCount: 1 } },
      { data: [], attrs: { totalCount: policy.maxDetails + 1 } },
    ]) {
      const f = fixture(u => u.pathname.endsWith('/list') ? json({ data }) : undefined);
      await expect(f.reader.readBucket(bucket)).rejects.toThrow(/SONOGONG_(INVALID_RESPONSE|LIMIT)/);
    }
  });
  it('does not leak credentials or transport/body/cookie sentinels in errors; redirects are disabled', async () => {
    const f = fixture((u, init) => {
      expect(init.redirect).toBe('error');
      expect(u.origin).toBe(policy.origin);
      expect(init.signal).toBeDefined();
      if (u.pathname.endsWith('/list')) throw new Error(sentinel);
      return undefined;
    });
    try { await f.reader.readBucket(bucket); throw new Error('EXPECTED_FAILURE'); }
    catch (error) {
      expect(String(error)).toContain('SONOGONG_TRANSPORT_FAILED');
      expect(String(error)).not.toContain(sentinel);
      expect((error as Error).cause).toBeUndefined();
    }
    const auth = fixture(u => u.pathname.endsWith('/login') ? json({ message: sentinel }, 403) : undefined);
    await expect(auth.reader.readBucket(bucket)).rejects.toThrow('SONOGONG_AUTH_FAILED');
  });
  it('refuses --apply-raw without approval before any read', async () => {
    const f = fixture();
    await expect(runSonogongCollection({ args: ['--apply-raw'], env: {}, reader: f.reader })).rejects.toThrow('SONOGONG_RAW_APPROVAL_REQUIRED');
    expect(f.fakeFetch).not.toHaveBeenCalled();
  });
  it('rejects invalid account JSON and invalid/expired tokens without leaking their content', async () => {
    for (const accountJson of ['', sentinel, JSON.stringify({ id: sentinel })]) {
      const send = vi.fn();
      const reader = createSonogongErpReader({ accountJson, fetch: send });
      await expect(reader.readBucket(bucket)).rejects.toThrow('SONOGONG_ACCOUNT_REQUIRED');
      expect(send).not.toHaveBeenCalled();
    }
    for (const accessToken of [sentinel, `fake.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.fake`]) {
      const f = fixture(u => u.pathname.endsWith('/login') ? json({ data: { accessToken } }) : undefined);
      await expect(f.reader.readBucket(bucket)).rejects.toThrow('SONOGONG_AUTH_FAILED');
    }
  });
  it('bounds endless small pages and rejects changed counts', async () => {
    const f = fixture(u => {
      if (!u.pathname.endsWith('/list')) return undefined;
      const page = Number(u.searchParams.get('page'));
      return json({ data: { data: [row(`fake-${page}`)], attrs: { totalCount: 101, currentPage: page } } });
    });
    await expect(f.reader.readBucket(bucket)).rejects.toThrow('SONOGONG_LIMIT');
    expect(vi.mocked(f.fakeFetch).mock.calls).toHaveLength(policy.maxPages + 1);
    const changing = fixture(u => {
      if (!u.pathname.endsWith('/list')) return undefined;
      const page = Number(u.searchParams.get('page'));
      return json({ data: { data: [row(`fake-${page}`)], attrs: { totalCount: page + 1, currentPage: page } } });
    });
    await expect(changing.reader.readBucket(bucket)).rejects.toThrow('SONOGONG_INVALID_RESPONSE');
  });
  it('preserves empty bucket envelopes in RAW alongside nonempty buckets', async () => {
    const f = fixture(u => u.pathname.endsWith('/list') && u.searchParams.get('carSource') === 'LOW_TCAR'
      ? json({ data: { data: [], attrs: { totalCount: 0, currentPage: 1 } } }) : undefined);
    const batch = await sonogongSourceAdapter({ expectedFreshnessSeconds: policy.freshnessSeconds, readBucket: f.reader.readBucket }).read();
    const envelopes = batch.records[0]!.payload.bucketListResponses as Array<{ bucket: string; responses: unknown[] }>;
    expect(envelopes).toHaveLength(3);
    expect(envelopes[2]?.responses).toEqual([{ data: { data: [], attrs: { totalCount: 0, currentPage: 1 } } }]);
    expect(batch.records[1]!.payload.bucketListResponses).toBeUndefined();
  });
  it('uses existing injected ingestion once only when explicitly approved and complete', async () => {
    const f = fixture(), ingest = vi.fn(async () => undefined);
    const result = await runSonogongCollection({ args: ['--apply-raw', '--compare-deposits'],
      env: { SONOGONG_RAW_INGEST_APPROVED: 'true' }, reader: f.reader, now: f.now, ingest });
    expect(result.writeExecuted).toBe(true);
    expect(ingest).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC-VEHICLE');
    expect(JSON.stringify(result)).not.toContain(sentinel);
    const failed = fixture(u => u.pathname.includes('/view/') ? json({}, 404) : undefined);
    await expect(runSonogongCollection({ args: ['--apply-raw'], env: { SONOGONG_RAW_INGEST_APPROVED: 'true' },
      reader: failed.reader, now: failed.now, ingest })).rejects.toThrow('SONOGONG_SOURCE_NOT_READY');
    expect(ingest).toHaveBeenCalledOnce();
  });
  it('keeps missing estimates partial and applies common freshness at end of capture', async () => {
    const missing = fixture(u => u.pathname.includes('/view/') ? json({ data: row() }) : undefined);
    expect((await missing.reader.readBucket(bucket)).complete).toBe(false);
    const f = fixture();
    const adapter = sonogongSourceAdapter({ expectedFreshnessSeconds: policy.freshnessSeconds, readBucket: f.reader.readBucket });
    const { evidence } = await collectSupplierSource(adapter, new Date(f.now() + 7200_000).toISOString());
    expect(evidence.issues).toContain('SOURCE_STALE');
  });
});

describe('Sonogong deposit cross table', () => {
  it('compares source vs current rules per term, separating rent/subscriptions without individual values', async () => {
    const f = fixture(u => {
      if (u.pathname.includes('/view/')) return json({ data: { ...detail(), estimates: [
        estimate(), estimate({ securityDepositAmount: 800_000 }),
        estimate({ estimateType: 'SUBSCRIBE_BUYOUT', securityDepositAmount: null }),
        estimate({ monthly24: 'bad', securityDepositAmount: 0 }),
        estimate({ creditType: 'UNKNOWN' }),
      ] } });
    });
    const batch = await sonogongSourceAdapter({ expectedFreshnessSeconds: policy.freshnessSeconds, readBucket: f.reader.readBucket }).read();
    const report = compareSonogongDeposits(batch);
    expect(report.groups.SUBSCRIBE_RETURN.crossTable.ZERO.POSITIVE).toBe(3);
    expect(report.groups.SUBSCRIBE_RETURN.crossTable.POSITIVE.POSITIVE).toBe(3);
    expect(report.groups.SUBSCRIBE_RETURN.crossTable.ZERO.UNKNOWN).toBe(3);
    expect(report.groups.SUBSCRIBE_RETURN.mismatches).toBe(3);
    expect(report.groups.SUBSCRIBE_BUYOUT.crossTable.MISSING.POSITIVE).toBe(3);
    expect(report.excludedEstimates).toBe(3);
    expect(JSON.stringify(report)).not.toContain('800000');
    // Fabricated rent-shaped identity, never an operational plate.
    for (const r of batch.records) {
      (r.payload.list as Record<string, unknown>).carNumber = 'SYNTHETIC-허' + '0000';
      (r.payload.detail as Record<string, unknown>).estimates = [
        estimate({ estimateType: 'RENT_RETURN', securityDepositAmount: 200_000 }),
        estimate({ estimateType: 'RENT_BUYOUT', securityDepositAmount: 0 }),
        estimate({ estimateType: 'RENT_RETURN', securityDepositAmount: null }),
      ];
    }
    const rent = compareSonogongDeposits(batch).groups.USED_RENT;
    expect(rent.crossTable.POSITIVE.POSITIVE).toBe(3);
    expect(rent.crossTable.ZERO.UNKNOWN).toBe(3);
    expect(rent.crossTable.MISSING.UNKNOWN).toBe(3);
    expect(rent.mismatches).toBe(0);
    expect(rent.incomparable).toBe(6);
  });
});
