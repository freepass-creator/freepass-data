import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deprecatedConfigNotices, runUnattended, type UnattendedProbes } from '../src/runtime/source-cycle-runtime.js';

// 폐기된 SOURCE_CYCLE_AUTOPLUS_HOMEPAGE_WRITE 는 조용히 관측 전용으로 바뀌면 안 된다(Codex 독립 검토 2026-10-15).
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const dir = async () => { const d = await mkdtemp(join(tmpdir(), 'deprecated-config-')); dirs.push(d); return d; };
const probes: UnattendedProbes = { gwsBin: () => null, gcloudToken: async () => 'synthetic' };

describe('폐기 설정 알림', () => {
  it('names the situation: write-blocking (sheet write not set) vs ignored with sheet write kept', () => {
    expect(deprecatedConfigNotices({})).toEqual([]);
    expect(deprecatedConfigNotices({ SOURCE_CYCLE_AUTOPLUS_HOMEPAGE_WRITE: '' })).toEqual([]);
    expect(deprecatedConfigNotices({ SOURCE_CYCLE_AUTOPLUS_HOMEPAGE_WRITE: '1' }))
      .toEqual([{ code: 'DEPRECATED_AUTOPLUS_HOMEPAGE_WRITE_RP023_OBSERVATION_ONLY', blocksWrites: true }]);
    expect(deprecatedConfigNotices({ SOURCE_CYCLE_AUTOPLUS_HOMEPAGE_WRITE: '1', SOURCE_CYCLE_AUTOPLUS_SHEET: '1' }))
      .toEqual([{ code: 'DEPRECATED_AUTOPLUS_HOMEPAGE_WRITE_IGNORED_SHEET_WRITE_KEPT', blocksWrites: false }]);
  });

  it('an unattended run records the notice and an alert, and fails loudly when RP023 writes would silently stop', async () => {
    const d = await dir();
    const record = await runUnattended([], { SOURCE_CYCLE_PRIVATE_DIR: d, SOURCE_CYCLE_SOURCES: 'IANCAR', FIREBASE_PROJECT_ID: 'synthetic-test',
      SOURCE_CYCLE_AUTOPLUS_HOMEPAGE_WRITE: '1' }, [], probes);
    expect(record.configNotices).toEqual(['DEPRECATED_AUTOPLUS_HOMEPAGE_WRITE_RP023_OBSERVATION_ONLY']);
    expect(record.exit).toBe(1);
    const alerts = (await readFile(join(d, 'alerts.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    expect(alerts.some(a => a.reason === 'DEPRECATED_AUTOPLUS_HOMEPAGE_WRITE_RP023_OBSERVATION_ONLY')).toBe(true);
 }, 30_000);

  it('with the sheet write on, the legacy variable is only a notice (exit unaffected by it)', async () => {
    const d = await dir();
    const record = await runUnattended([], { SOURCE_CYCLE_PRIVATE_DIR: d, SOURCE_CYCLE_SOURCES: 'F05', FIREBASE_PROJECT_ID: 'synthetic-test',
      SOURCE_CYCLE_AUTOPLUS_HOMEPAGE_WRITE: '1', SOURCE_CYCLE_AUTOPLUS_SHEET: '1' }, [], probes);
    expect(record.configNotices).toEqual(['DEPRECATED_AUTOPLUS_HOMEPAGE_WRITE_IGNORED_SHEET_WRITE_KEPT']);
    // 사전점검(gws 없음)이 실패해 exit 1 이지만, 그 원인은 사전점검이다 — 알림 자체가 쓰기를 막지 않았다.
    expect(record.preflight?.length).toBeGreaterThan(0);
 }, 30_000);
});
