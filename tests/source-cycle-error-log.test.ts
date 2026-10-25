import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm as removePath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyCycleState, type CycleCommands, type CycleControl } from '../src/application/source-cycle.js';
import { sourceCyclePlugin } from '../src/adapters/source-cycle-plugins.js';
import { runSourceCycle, maskDiagnosticText } from '../src/jobs/source-cycle.js';

const dirs: string[] = [];
const saved = process.env.SOURCE_CYCLE_PRIVATE_DIR;
afterEach(async () => {
  if (saved === undefined) delete process.env.SOURCE_CYCLE_PRIVATE_DIR; else process.env.SOURCE_CYCLE_PRIVATE_DIR = saved;
  for (const d of dirs.splice(0)) await removePath(d, { recursive: true, force: true });
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'cycle-err-'));
  dirs.push(dir); process.env.SOURCE_CYCLE_PRIVATE_DIR = dir;
  return dir;
}
function harness(fail: () => never) {
  let state = emptyCycleState(); const alerts: string[] = [];
  const ctrl: CycleControl = {
    async acquire() { return async () => {}; }, async load() { return structuredClone(state); },
    async save(_id, s) { state = structuredClone(s); }, heartbeat: vi.fn(async () => {}), async alert(_id, r) { alerts.push(r); },
  };
  const commands = { async list() { return fail(); } } as unknown as CycleCommands;
  const read = async () => ({ observedAt: '2026-10-12T00:00:00.000Z', complete: true, completedScopes: ['inventory'], visibilityComplete: true, heldCount: 0, rows: [] });
  const plugin = sourceCyclePlugin({ sourceId: 'RP023', kind: 'IRON', scopes: ['inventory'], maxDowngradeRatio: 0.5 }, read, () => '2026-10-12T00:00:00.000Z');
  return { ctrl, commands, plugin, alerts, get state() { return state; } };
}

describe('CYCLE_ERROR 진단 로그', () => {
  it('코드 형식 예외는 기존 동작 그대로이고 로그를 쓰지 않는다', async () => {
    const dir = await setup();
    const h = harness(() => { throw new Error('SOME_CODE'); });
    const r = await runSourceCycle(h.plugin, h.commands, h.ctrl, {});
    expect(r.summary).toContain('회차 보류 SOME_CODE');
    await expect(readFile(join(dir, 'cycle-errors.jsonl'), 'utf8')).rejects.toThrow();
  });
  it('비코드 예외는 CYCLE_ERROR 로 보고하고 단계·이름·메시지·스택을 한 줄 JSON 으로 남긴다', async () => {
    const dir = await setup();
    const h = harness(() => { throw new TypeError('x is not a function token=abc123 user a@b.com ' + 'z'.repeat(400)); });
    const r = await runSourceCycle(h.plugin, h.commands, h.ctrl, {});
    expect(r.summary).toContain('회차 보류 CYCLE_ERROR (연속 1)');
    expect(h.state.error).toBe('CYCLE_ERROR'); expect(h.state.failures).toBe(1);
    const lines = (await readFile(join(dir, 'cycle-errors.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    const row = JSON.parse(lines[0]!);
    expect(row).toMatchObject({ sourceId: 'RP023', stage: 'PLAN', errorName: 'TypeError' });
    expect(Date.parse(row.at)).toBeGreaterThan(0);
    expect(row.message.length).toBeLessThanOrEqual(300);
    expect(row.message).not.toContain('abc123'); expect(row.message).not.toContain('a@b.com');
    expect(row.stack.length).toBeLessThanOrEqual(5);
  });
  it('마스킹 함수가 토큰·키·이메일을 가린다', () => {
    const s = maskDiagnosticText('Bearer abc.def password: "hunter2" mail me@x.org https://h/?key=SECRET1&a=1 AIzaSyA1234567890abcdef');
    for (const bad of ['abc.def', 'hunter2', 'me@x.org', 'SECRET1', 'AIzaSyA1234567890']) expect(s).not.toContain(bad);
  });
  it('로그 쓰기가 실패해도 본 동작(보고·상태)은 같다', async () => {
    const dir = await setup();
    await writeFile(join(dir, 'blocker'), '');
    process.env.SOURCE_CYCLE_PRIVATE_DIR = join(dir, 'blocker', 'nested');   // 파일 아래 디렉터리 → 생성 실패
    const h = harness(() => { throw new Error('plain message'); });
    const r = await runSourceCycle(h.plugin, h.commands, h.ctrl, {});
    expect(r.summary).toContain('회차 보류 CYCLE_ERROR (연속 1)');
    expect(h.alerts).toContain('CYCLE_ERROR');
  });
});
