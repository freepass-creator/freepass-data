import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { controlStore, firestoreCycleControl, readCycleWriter, setCycleWriter, writerGuard } from '../src/infra/source-cycle-control-firestore.js';
import { fileCycleControl } from '../src/adapters/source-cycle-control.js';
import { fileRunnerFiles, firestoreRunnerFiles } from '../src/infra/runner-files.js';
import { emptyCycleState } from '../src/ports/source-cycle.js';
import { runHandover } from '../src/jobs/source-cycle-handover.js';
import { stableDigest } from '../src/shared/stable-digest.js';

/** Firestore REST 의 이 모듈들이 쓰는 부분만 흉내 낸다: GET·POST(documentId, 있으면 409)·PATCH(updateTime 조건, 다르면 412). DELETE 는 없다. */
export function fakeFirestore() {
  const docs = new Map<string, { updateTime: string; fields: Record<string, unknown> }>();
  const methods: string[] = [];
  let clock = 0;
  const fetcher = (async (input: string, init: RequestInit) => {
    const url = new URL(input), method = init.method ?? 'GET'; methods.push(method);
    const tail = decodeURIComponent(url.pathname.split('/source_cycle_control')[1] ?? '');
    const reply = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
    const doc = (id: string) => ({ name: `projects/p/databases/(default)/documents/source_cycle_control/${id}`, ...docs.get(id)! });
    if (method === 'GET') { const id = tail.slice(1); return docs.has(id) ? reply(200, doc(id)) : reply(404); }
    if (method === 'POST') {
      const id = url.searchParams.get('documentId')!;
      if (docs.has(id)) return reply(409);
      docs.set(id, { updateTime: `t${++clock}`, fields: JSON.parse(String(init.body)).fields }); return reply(200, doc(id));
    }
    if (method === 'PATCH') {
      const id = tail.slice(1), want = url.searchParams.get('currentDocument.updateTime');
      if (want !== null && docs.get(id)?.updateTime !== want) return reply(412);
      docs.set(id, { updateTime: `t${++clock}`, fields: JSON.parse(String(init.body)).fields }); return reply(200, doc(id));
    }
    return reply(405);
  }) as unknown as typeof fetch;
  return { docs, methods, fetcher };
}
const env = { FIREBASE_PROJECT_ID: 'freepasserp5' } as NodeJS.ProcessEnv;
type Fs = ReturnType<typeof fakeFirestore>;
const storeOf = (fs: Fs) => ({ env, fetcher: fs.fetcher, token: async () => 'synthetic' });
const make = (fs: Fs, over: Partial<Parameters<typeof firestoreCycleControl>[0]> = {}) =>
  firestoreCycleControl({ ...storeOf(fs), heartbeat: async () => undefined, ...over });
const handTo = async (fs: Fs, source: string, writer: 'B3Q' | 'ACTIONS') => {
  const store = controlStore(storeOf(fs));
  expect(await setCycleWriter(store, source, await readCycleWriter(store, source), writer, {})).toBe(true);
};
const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const tempDir = async () => { const d = await mkdtemp(join(tmpdir(), 'handover-')); dirs.push(d); return d; };

describe('write ownership (Codex P1-①): B3Q and Actions can never both write one source', () => {
  it('defaults to B3Q; the other runner is refused at lock time and again right before every product write', async () => {
    const fs = fakeFirestore(), store = controlStore(storeOf(fs));
    expect((await readCycleWriter(store, 'RP031')).writer).toBe('B3Q');
    await expect(writerGuard(store, 'B3Q')('RP031')).resolves.toBeUndefined();
    await expect(writerGuard(store, 'ACTIONS')('RP031')).rejects.toThrow('WRITER_NOT_OWNER');
    expect(await make(fs).acquire('RP031')).toBeNull();                          // Actions 는 소유자가 아니면 회차를 돌리지 않는다
    await handTo(fs, 'RP031', 'ACTIONS');
    await expect(writerGuard(store, 'B3Q')('RP031')).rejects.toThrow('WRITER_NOT_OWNER');   // 넘긴 뒤 B3Q 의 쓰기는 막힌다
    expect(await make(fs).acquire('RP031')).toBeTypeOf('function');
  });
  it('an unknown owner value blocks both runners', async () => {
    const fs = fakeFirestore(), store = controlStore(storeOf(fs));
    await store.create(store.id('owner', 'RP031'), { kind: 'OWNER', source: 'RP031', writer: 'SOMEONE' });
    for (const me of ['B3Q', 'ACTIONS'] as const) await expect(writerGuard(store, me)('RP031')).rejects.toThrow('WRITER_NOT_OWNER');
  });
});

describe('Firestore cycle lease + fencing (Codex P1-②)', () => {
  it('only one runner holds a source lease; release marks RELEASED (never deletes)', async () => {
    const fs = fakeFirestore();
    await handTo(fs, 'RP012', 'ACTIONS'); await handTo(fs, 'RP031', 'ACTIONS');
    const a = make(fs), b = make(fs);
    const releaseA = await a.acquire('RP012');
    expect(releaseA).toBeTypeOf('function');
    expect(await b.acquire('RP012')).toBeNull();
    expect(await b.acquire('RP031')).toBeTypeOf('function');
    await releaseA!();
    expect(await b.acquire('RP012')).toBeTypeOf('function');
    await expect(releaseA!()).rejects.toThrow('CYCLE_LOCK_OWNER_CHANGED');
    expect(fs.methods).not.toContain('DELETE');
  });

  it('expired leases are NOT taken over by default; explicit takeover fences the old runner out of product writes', async () => {
    const fs = fakeFirestore();
    await handTo(fs, 'RP012', 'ACTIONS');
    let t = Date.parse('2026-10-14T00:00:00Z');
    const old = make(fs, { now: () => t });
    await old.acquire('RP012');                                                   // 해제 없이 멈춘 옛 실행기
    await expect(old.fence('RP012')).resolves.toBeUndefined();
    t += 61 * 60_000;
    expect(await make(fs, { now: () => t }).acquire('RP012')).toBeNull();          // 기본: 인수하지 않음
    expect([...fs.docs.values()].some(d => JSON.stringify(d.fields).includes('DEAD_LOCK_HELD'))).toBe(true);
    const fresh = make(fs, { now: () => t, takeOverExpired: true });
    expect(await fresh.acquire('RP012')).toBeTypeOf('function');
    await expect(old.fence('RP012')).rejects.toThrow('LEASE_LOST');                 // 옛 실행기는 더 쓰지 못한다
    await expect(fresh.fence('RP012')).resolves.toBeUndefined();
    await handTo(fs, 'RP012', 'B3Q');
    await expect(fresh.fence('RP012')).rejects.toThrow('WRITER_NOT_OWNER');         // 소유권이 바뀌면 잠금이 있어도 멈춘다
  });

  it('round-trips validated cycle state and refuses a corrupted one', async () => {
    const fs = fakeFirestore(), c = make(fs);
    expect(await c.load('RP012')).toEqual(emptyCycleState());
    const state = { ...emptyCycleState(), failures: 1, error: 'SOURCE_STALE', lastAttemptAt: '2026-10-14T00:00:00.000Z' };
    await c.save('RP012', state);
    expect(await c.load('RP012')).toEqual(state);
    await expect(c.save('RP012', { ...state, failures: 3, stopped: false })).rejects.toThrow('CYCLE_STATE_INVALID');
  });
});

describe('handover B3Q ↔ ACTIONS carries stop state, baselines and once-markers (Codex P1-③)', () => {
  const stopped = { ...emptyCycleState(), failures: 3, stopped: true, error: 'SOURCE_STALE', lastAttemptAt: '2026-10-14T00:00:00.000Z' };
  it('dry-run first, exact digest to apply; state and runner files move before the owner flips', async () => {
    const fs = fakeFirestore(), dir = await tempDir();
    await fileCycleControl(dir, async () => undefined).save('RP012', stopped);
    const files = fileRunnerFiles(dir);
    await files.write('sonogong-api-count.json', '{"count":334}');
    await files.write('sonogong-enroll-cap-once.done', '{"cap":400}');
    const base = { source: 'RP012', to: 'ACTIONS' as const, directory: dir, store: storeOf(fs) };
    const plan = await runHandover({ ...base, apply: false });
    expect(plan).toMatchObject({ status: 'DRY_RUN', from: 'B3Q', to: 'ACTIONS', stateStopped: true, blockers: [] });
    expect(fs.methods.filter(m => m !== 'GET')).toEqual([]);                       // 계획은 쓰기 0
    await expect(runHandover({ ...base, apply: true, approval: 'wrong' })).rejects.toThrow('HANDOVER_APPROVAL_REQUIRED');
    const done = await runHandover({ ...base, apply: true, approval: (plan as { planDigest: string }).planDigest });
    expect(done.status).toBe('HANDED_OVER');
    expect(await make(fs).load('RP012')).toEqual(stopped);                          // 정지가 풀리지 않는다
    const online = firestoreRunnerFiles(storeOf(fs));
    expect(await online.read('sonogong-api-count.json')).toBe('{"count":334}');
    expect(await online.read('sonogong-enroll-cap-once.done')).toBe('{"cap":400}'); // 일회성이 다시 허용되지 않는다
    expect((await readCycleWriter(controlStore(storeOf(fs)), 'RP012')).writer).toBe('ACTIONS');
    expect(await runHandover({ ...base, apply: false })).toMatchObject({ status: 'NO_CHANGE' });
  });
  it('holds while a run may still be in flight or uncertain, and never overwrites different target values', async () => {
    const fs = fakeFirestore(), dir = await tempDir();
    const base = { source: 'RP012', to: 'ACTIONS' as const, directory: dir, store: storeOf(fs), apply: true, approval: 'x' };
    await writeFile(join(dir, `${stableDigest('RP012')}.lock`), '{}');
    await fileCycleControl(dir, async () => undefined).save('RP012', { ...emptyCycleState(), failures: 1, error: 'APPLY_UNCERTAIN' });
    await fileRunnerFiles(dir).write('sonogong-api-count.json', '{"count":334}');
    await firestoreRunnerFiles(storeOf(fs)).write('sonogong-api-count.json', '{"count":12}');
    const r = await runHandover(base);
    expect(r.status).toBe('HOLD');
    expect((r as { blockers: string[] }).blockers).toEqual(['FILE_LOCK_PRESENT', 'PRIOR_APPLY_UNCERTAIN', 'TARGET_FILE_CONFLICT:sonogong-api-count.json']);
    expect((await readCycleWriter(controlStore(storeOf(fs)), 'RP012')).writer).toBe('B3Q');
  });
});
