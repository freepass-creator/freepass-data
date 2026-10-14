import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessFreshness, parseFreshnessExempt } from '../src/application/source-freshness.js';
import { runUnattended, unattendedPreflight, runtimeCli, type UnattendedProbes } from '../src/runtime/source-cycle-runtime.js';

const now = Date.parse('2026-10-13T12:00:00.000Z');
const beat = (source: string, minutesAgo: number, extra: Record<string, unknown> = {}) => JSON.stringify({ source, failures: 0, stopped: false,
  error: null, lastAttemptAt: new Date(now - minutesAgo * 60_000).toISOString(), lastCompleteAt: new Date(now - minutesAgo * 60_000).toISOString(),
  readCount: 10, heldCount: 0, sourceCount: 10, ...extra });

describe('source freshness (대표 2026-10-13: 원천 신선도는 기록으로만 판단)', () => {
  it('a listed known false positive is reported separately only while STALE and under 24 hours; it never hides STOPPED or older ages', () => {
    const lines = [beat('RP012', 300), beat('RP023', 1500), beat('RP031', 300, { stopped: true, failures: 3, error: 'X' }), beat('RP004', 10)];
    const r = assessFreshness(lines, [], { now, maxAgeMinutes: 120, knownFalsePositive: ['RP012', 'RP023', 'RP031'] });
    expect(r.knownFalsePositive).toEqual(['RP012:300m']);
    expect(r.unhealthy).toEqual(['RP023:STALE', 'RP031:STOPPED']);
    expect(r.escalate).toEqual(['RP023:STALE:1500m']);
    expect(r.fresh).toBe(1);
  });
  it('a source not completed for 6 hours or more is listed for escalation even while its soft hold is not a failure', () => {
    const r = assessFreshness([beat('RP031', 359, { error: 'IANCAR_ONE_DETAIL_SOURCE_DRIFT' }), beat('RP012', 361, { error: 'IANCAR_ONE_DETAIL_SOURCE_DRIFT' }),
      beat('RP004', 30)], [], { now, maxAgeMinutes: 120 });
    expect(r.unhealthy).toEqual(['RP012:STALE', 'RP031:STALE']);
    expect(r.escalate).toEqual(['RP012:STALE:361m']);
    expect(assessFreshness([beat('RP031', 200)], [], { now, escalateAfterMinutes: 180 }).escalate).toEqual(['RP031:STALE:200m']);
  });
  it('latest heartbeat per source decides; within max age is FRESH', () => {
    const r = assessFreshness([beat('RP004', 300), beat('RP004', 30), beat('RP006', 90)], [], { now, maxAgeMinutes: 120 });
    expect(r.status).toBe('HEALTHY'); expect(r.fresh).toBe(2); expect(r.sources.map(s => s.ageMinutes)).toEqual([30, 90]);
  });
  it('stale, stopped, error, never-completed and missing expected sources are unhealthy', () => {
    const r = assessFreshness([beat('RP004', 200), beat('RP006', 10, { stopped: true, failures: 3, error: 'SOURCE_HTTP_503' }),
      beat('RP012', 10, { error: 'SOURCE_INCOMPLETE' }), beat('RP023', 10, { lastCompleteAt: null })],
      [JSON.stringify({ source: 'RP006', reason: 'STOPPED:SOURCE_HTTP_503', at: new Date(now - 5 * 60_000).toISOString() })],
      { now, maxAgeMinutes: 120, expect: ['RP099'] });
    expect(r.unhealthy).toEqual(['RP004:STALE', 'RP006:STOPPED', 'RP012:ERROR', 'RP023:NEVER_COMPLETED', 'RP099:MISSING']);
    expect(r.sources.find(s => s.source === 'RP006')!.alerts).toEqual(['STOPPED:SOURCE_HTTP_503']);
  });
  it('only= judges just the sources this run reads, so an excluded source cannot stay UNHEALTHY forever', () => {
    const lines = [beat('RP004', 10), beat('RP031', 500, { stopped: true, failures: 3 })];
    expect(assessFreshness(lines, [], { now }).unhealthy).toEqual(['RP031:STOPPED']);
    const scoped = assessFreshness(lines, [], { now, only: ['RP004'] });
    expect(scoped.status).toBe('HEALTHY'); expect(scoped.sources.map(s => s.source)).toEqual(['RP004']);
    expect(assessFreshness(lines, [], { now, only: ['RP004', 'RP099'] }).unhealthy).toEqual(['RP099:MISSING']);
  });
  it('ignores malformed lines and old alerts', () => {
    const r = assessFreshness(['not json', beat('RP004', 5)], ['{"source":"RP004","reason":"OLD","at":"2026-10-01T00:00:00.000Z"}'], { now });
    expect(r.status).toBe('HEALTHY'); expect(r.sources[0]!.alerts).toEqual([]);
  });
});

describe('unattended run record and preflight (사고: 예약 환경에 시트 읽기 경로·토큰 없어 원천 14개가 AUTH_FAILED)', () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
  const privateDir = async () => { const d = await mkdtemp(join(tmpdir(), 'unattended-')); dirs.push(d); return d; };
  const probes = (over: Partial<UnattendedProbes> = {}): UnattendedProbes => ({ gwsBin: () => 'gws', gcloudToken: async () => 'synthetic', ...over });

  it('reports every missing prerequisite by code and never starts a cycle', async () => {
    const none = probes({ gwsBin: () => null, gcloudToken: async () => { throw new Error('no login'); } });
    expect(await unattendedPreflight({}, ['F05', 'AICA'], none))
      .toEqual(['PREFLIGHT_GWS_MISSING', 'PREFLIGHT_SHEETS_TRANSPORT_UNSET', 'PREFLIGHT_GCLOUD_TOKEN_MISSING']);
    expect(await unattendedPreflight({ SHEETS_TRANSPORT: 'gws' }, ['F05'], probes())).toEqual([]);
    expect(await unattendedPreflight({}, ['IANCAR'], probes())).toEqual([]);      // 시트 원천이 없으면 gws·전송 설정은 요구하지 않음
  });
  it('a known exemption removes a stale source from unhealthy/escalate without a time cap, and lifts when the replacement source completes cleanly', () => {
    const stale = [beat('RP012', 600), beat('RP013', 10)];                              // RP012 10시간 전 = escalate 대상이지만 알려진 예외
    const exempt = [{ source: 'RP012', reason: 'SONOGONG_LOCKED', liftWhenCompleted: 'RP040' }];
    const base = assessFreshness(stale, [], { now });
    expect(base).toMatchObject({ status: 'UNHEALTHY', unhealthy: ['RP012:STALE'] });
    expect(base.escalate).toHaveLength(1);
    const withExempt = assessFreshness(stale, [], { now, exempt });
    expect(withExempt).toMatchObject({ status: 'HEALTHY', unhealthy: [], escalate: [], fresh: 1 });
    expect(withExempt.exempt).toEqual(['RP012:SONOGONG_LOCKED:STALE:600m']);
    // 대체 원천(RP040)이 실패 없이 첫 완료 → 예외 해제, RP012 는 다시 감시된다
    const replaced = assessFreshness([...stale, beat('RP040', 5)], [], { now, exempt });
    expect(replaced.exempt).toEqual([]);
    expect(replaced.unhealthy).toContain('RP012:STALE');
    // 대체 원천이 실패 중이면 해제되지 않는다
    const failing = assessFreshness([...stale, beat('RP040', 5, { failures: 1 })], [], { now, exempt });
    expect(failing.exempt).toHaveLength(1);
  });
  it('the exemption setting is parsed strictly: malformed entries are ignored and never widen what is excluded', () => {
    expect(parseFreshnessExempt('RP012=SONOGONG_LOCKED>RP040, RP034=EXCLUDED_BY_DECISION')).toEqual([
      { source: 'RP012', reason: 'SONOGONG_LOCKED', liftWhenCompleted: 'RP040' }, { source: 'RP034', reason: 'EXCLUDED_BY_DECISION' }]);
    expect(parseFreshnessExempt('*=ALL,rp012=low,RP012=bad reason,RP012')).toEqual([]);
    expect(parseFreshnessExempt(undefined)).toEqual([]);
  });
  it('a failed preflight writes one run record and one RUNNER alert, exit 1, no source touched', async () => {
    const dir = await privateDir();
    const record = await runUnattended([], { SOURCE_CYCLE_PRIVATE_DIR: dir, SOURCE_CYCLE_SOURCES: 'F05' }, [], probes({ gwsBin: () => null }));
    expect(record).toMatchObject({ exit: 1, preflight: ['PREFLIGHT_GWS_MISSING', 'PREFLIGHT_SHEETS_TRANSPORT_UNSET'] });
    expect(record.reports).toBeUndefined();
    const runs = (await readFile(join(dir, 'unattended-runs.jsonl'), 'utf8')).trim().split('\n');
    expect(runs).toHaveLength(1); expect(JSON.parse(runs[0]!).preflight).toContain('PREFLIGHT_GWS_MISSING');
    expect(JSON.parse((await readFile(join(dir, 'alerts.jsonl'), 'utf8')).trim()).source).toBe('RUNNER');
  });
  it('a configuration error is recorded as a safe code, not thrown into the scheduler', async () => {
    const dir = await privateDir();
    const record = await runUnattended([], { SOURCE_CYCLE_PRIVATE_DIR: dir, SOURCE_CYCLE_SOURCES: 'IANCAR', SOURCE_CYCLE_DOWNGRADE_FLOOR: '99',
      FIREBASE_PROJECT_ID: 'synthetic-test' }, [], probes());
    expect(record).toMatchObject({ exit: 1, error: 'CYCLE_CONFIG_INVALID' });
  });
  it('a rollback argument can never be mixed into an unattended run', async () => {
    const env = { FIREBASE_PROJECT_ID: 'synthetic-test', SOURCE_CYCLE_SOURCES: 'IANCAR', SOURCE_CYCLE_PRIVATE_DIR: await privateDir(), SOURCE_CYCLE_UNATTENDED: '1' };
    await expect(runtimeCli(['--unattended', '--rollback', 'k'], env)).rejects.toThrow('UNATTENDED_ARGS_INVALID');
  });
});
