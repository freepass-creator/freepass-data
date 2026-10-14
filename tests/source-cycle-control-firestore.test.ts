import { describe, expect, it } from 'vitest';
import { firestoreCycleControl } from '../src/infra/source-cycle-control-firestore.js';
import { emptyCycleState } from '../src/ports/source-cycle.js';

/** Firestore REST 의 이 모듈이 쓰는 부분만 흉내 낸다: GET·POST(documentId, 있으면 409)·PATCH(updateTime 조건, 다르면 412). DELETE 는 없다. */
function fakeFirestore() {
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
const make = (fs: ReturnType<typeof fakeFirestore>, over: Partial<Parameters<typeof firestoreCycleControl>[0]> = {}) =>
  firestoreCycleControl({ env, heartbeat: async () => undefined, fetcher: fs.fetcher, token: async () => 'synthetic', ...over });

describe('Firestore cycle control (online runner: locks and state survive the ephemeral runner)', () => {
  it('only one runner holds a source lease; release marks RELEASED (never deletes) and the next runner can take it', async () => {
    const fs = fakeFirestore();
    const a = make(fs), b = make(fs);
    const releaseA = await a.acquire('RP012');
    expect(releaseA).toBeTypeOf('function');
    expect(await b.acquire('RP012')).toBeNull();                         // 다른 실행기는 건너뜀
    expect(await b.acquire('RP031')).toBeTypeOf('function');             // 원천이 다르면 독립
    await releaseA!();
    const releaseB = await b.acquire('RP012');
    expect(releaseB).toBeTypeOf('function');
    await expect(releaseA!()).rejects.toThrow('CYCLE_LOCK_OWNER_CHANGED'); // 남의 잠금은 못 푼다
    expect(fs.methods).not.toContain('DELETE');
  });

  it('an expired lease is taken over only by the designated runner, with an alert; others hold', async () => {
    const fs = fakeFirestore();
    let t = Date.parse('2026-10-14T00:00:00Z');
    await make(fs, { now: () => t }).acquire('RP012');                   // 해제 없이 죽은 실행기
    t += 61 * 60_000;
    expect(await make(fs, { now: () => t }).acquire('RP012')).toBeNull();
    expect([...fs.docs.values()].some(d => JSON.stringify(d.fields).includes('DEAD_LOCK_HELD'))).toBe(true);
    expect(await make(fs, { now: () => t, takeOverExpired: true }).acquire('RP012')).toBeTypeOf('function');
    expect([...fs.docs.values()].some(d => JSON.stringify(d.fields).includes('LEASE_TAKEN_OVER'))).toBe(true);
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
