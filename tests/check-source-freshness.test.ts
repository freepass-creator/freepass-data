import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error plain ESM script without type declarations
import { assessFreshness, freshnessCli } from '../scripts/check-source-freshness.mjs';

const now = Date.parse('2026-10-13T12:00:00.000Z');
const beat = (source: string, minutesAgo: number, extra: Record<string, unknown> = {}) => JSON.stringify({ source, failures: 0, stopped: false,
  error: null, lastAttemptAt: new Date(now - minutesAgo * 60_000).toISOString(), lastCompleteAt: new Date(now - minutesAgo * 60_000).toISOString(),
  readCount: 10, heldCount: 0, sourceCount: 10, ...extra });

describe('source freshness watchdog (대표 2026-10-13: 원천 신선도를 근거로 관리)', () => {
  it('latest heartbeat per source decides; within max age is FRESH', () => {
    const r = assessFreshness([beat('RP004', 300), beat('RP004', 30), beat('RP006', 90)], [], { now, maxAgeMinutes: 120 });
    expect(r.status).toBe('HEALTHY'); expect(r.fresh).toBe(2); expect(r.sources.map((s: any) => s.ageMinutes)).toEqual([30, 90]);
  });
  it('stale, stopped, error, never-completed and missing expected sources are unhealthy', () => {
    const r = assessFreshness([beat('RP004', 200), beat('RP006', 10, { stopped: true, failures: 3, error: 'SOURCE_HTTP_503' }),
      beat('RP012', 10, { error: 'SOURCE_INCOMPLETE' }), beat('RP023', 10, { lastCompleteAt: null })],
      [JSON.stringify({ source: 'RP006', reason: 'STOPPED:SOURCE_HTTP_503', at: new Date(now - 5 * 60_000).toISOString() })],
      { now, maxAgeMinutes: 120, expect: ['RP099'] });
    expect(r.status).toBe('UNHEALTHY');
    expect(r.unhealthy).toEqual(['RP004:STALE', 'RP006:STOPPED', 'RP012:ERROR', 'RP023:NEVER_COMPLETED', 'RP099:MISSING']);
    expect(r.sources.find((s: any) => s.source === 'RP006').alerts).toEqual(['STOPPED:SOURCE_HTTP_503']);
  });
  it('ignores malformed lines and old alerts', () => {
    const r = assessFreshness(['not json', beat('RP004', 5)], ['{"source":"RP004","reason":"OLD","at":"2026-10-01T00:00:00.000Z"}'], { now });
    expect(r.status).toBe('HEALTHY'); expect(r.sources[0].alerts).toEqual([]);
  });
  it('CLI reads the private directory and treats a missing file as no heartbeat', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'freshness-'));
    expect((await freshnessCli(['--dir', dir, '--expect', 'RP004'], {})).unhealthy).toEqual(['RP004:MISSING']);
    await writeFile(join(dir, 'heartbeats.jsonl'), beat('RP004', 1) + '\n');
    const r = await freshnessCli(['--dir', dir, '--max-age-minutes', '120'], {});
    expect(r.sources).toHaveLength(1); expect(r.sources[0].source).toBe('RP004');
    await expect(freshnessCli(['--dir', dir, '--max-age-minutes', '0'], {})).rejects.toThrow('MAX_AGE_INVALID');
  });
});
