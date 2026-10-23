import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideCheck, decideClaim, decideTransfer, leaseConfigFromEnv, parseLease, type Lease } from '../src/domain/writer-lease.js';
import { writerLeaseStore } from '../src/infra/writer-lease-firestore.js';
import { writerLeaseGate } from '../src/runtime/source-cycle-runtime.js';

const T0 = Date.UTC(2026, 9, 23, 9, 0, 0);
const min = (n: number) => n * 60_000;
const lease = (o: Partial<Lease> = {}): Lease => ({ lane: 'source-cycle', holder: 'PC3', epoch: 2, acquiredAt: new Date(T0).toISOString(), renewedAt: new Date(T0).toISOString(),
  expiresAt: new Date(T0 + min(180)).toISOString(), ttlMin: 180, previousHolder: 'PC1', ...o });

describe('decideCheck', () => {
  it('임대가 없으면 쓰지 않는다', () => expect(decideCheck(null, 'PC3', T0)).toEqual({ status: 'NO_LEASE' }));
  it('남의 임대는 만료돼도 가져오지 않는다', () => {
    expect(decideCheck(lease(), 'PC1', T0 + min(10))).toEqual({ status: 'NOT_HELD', holder: 'PC3', expired: false });
    expect(decideCheck(lease(), 'PC1', T0 + min(500))).toEqual({ status: 'NOT_HELD', holder: 'PC3', expired: true });
  });
  it('내 임대는 남은 시간이 절반 넘으면 그대로, 절반 이하면 갱신', () => {
    expect(decideCheck(lease(), 'PC3', T0 + min(30)).status).toBe('HELD');
    const r = decideCheck(lease(), 'PC3', T0 + min(100));
    expect(r.status).toBe('HELD_RENEW');
    if (r.status === 'HELD_RENEW') expect(Date.parse(r.next.expiresAt)).toBe(T0 + min(100) + min(180));
  });
  it('내 임대가 만료됐어도 아무도 인수하지 않았으면 갱신한다', () => expect(decideCheck(lease(), 'PC3', T0 + min(500)).status).toBe('HELD_RENEW'));
});

describe('decideClaim / decideTransfer', () => {
  it('없으면 만들고, 내 것이면 갱신, 남의 것은 만료 전 거절·만료 후 에포크 +1 로 인수', () => {
    expect(decideClaim(null, 'photo', 'PC3', 180, T0).status).toBe('CREATE');
    expect(decideClaim(lease(), 'source-cycle', 'PC3', 180, T0 + 1).status).toBe('RENEW');
    expect(decideClaim(lease(), 'source-cycle', 'PC1', 180, T0 + min(10))).toEqual({ status: 'REFUSED', reason: 'HELD_BY_OTHER_UNEXPIRED', holder: 'PC3' });
    const take = decideClaim(lease(), 'source-cycle', 'PC1', 180, T0 + min(500));
    expect(take.status).toBe('TAKE_EXPIRED');
    if (take.status === 'TAKE_EXPIRED') expect(take.next).toMatchObject({ holder: 'PC1', epoch: 3, previousHolder: 'PC3' });
  });
  it('이전은 현재 보유자·에포크가 같을 때만', () => {
    expect(decideTransfer(lease(), 'PC3', 'PC1', 2, 180, T0).status).toBe('TRANSFER');
    expect(decideTransfer(lease(), 'PC1', 'PC3', 2, 180, T0)).toMatchObject({ status: 'REFUSED', reason: 'FROM_MISMATCH' });
    expect(decideTransfer(lease(), 'PC3', 'PC1', 1, 180, T0)).toMatchObject({ status: 'REFUSED', reason: 'EPOCH_MISMATCH' });
    expect(decideTransfer(null, 'PC3', 'PC1', 1, 180, T0)).toMatchObject({ reason: 'NO_LEASE' });
    expect(decideTransfer(lease(), 'PC3', 'PC3', 2, 180, T0)).toMatchObject({ reason: 'SAME_HOLDER' });
  });
  it('손상된 문서는 해석하지 않는다', () => expect(parseLease({ lane: 'x', holder: 'PC3' })).toBeNull());
});

describe('leaseConfigFromEnv', () => {
  it('기본 꺼짐, 켜면 레인·PC 필수', () => {
    expect(leaseConfigFromEnv({})).toBeNull();
    expect(() => leaseConfigFromEnv({ WRITER_LEASE_ENFORCE: '1' })).toThrow('WRITER_LEASE_LANE_INVALID');
    expect(() => leaseConfigFromEnv({ WRITER_LEASE_ENFORCE: '1', WRITER_LEASE_LANE: 'source-cycle' })).toThrow('WRITER_LEASE_PC_INVALID');
    expect(() => leaseConfigFromEnv({ WRITER_LEASE_ENFORCE: 'true' })).toThrow('WRITER_LEASE_ENFORCE_INVALID');
    expect(leaseConfigFromEnv({ WRITER_LEASE_ENFORCE: '0' })).toBeNull();
    expect(leaseConfigFromEnv({ WRITER_LEASE_ENFORCE: '1', WRITER_LEASE_LANE: 'source-cycle', WRITER_LEASE_PC: 'PC3' })).toEqual({ lane: 'source-cycle', pc: 'PC3', ttlMin: 180 });
  });
});

/** 간이 Firestore REST: 문서 하나, updateTime 조건 지원. */
function fakeFirestore() {
  let doc: { fields: any; updateTime: string } | null = null; let seq = 0;
  const calls: string[] = [];
  const fetcher = (async (url: string, init: any) => {
    const u = new URL(url); calls.push(`${init.method} ${u.pathname.split('/').pop()}`);
    if (init.method === 'GET') return doc ? new Response(JSON.stringify({ name: 'x', fields: doc.fields, updateTime: doc.updateTime })) : new Response('{}', { status: 404 });
    const wantTime = u.searchParams.get('currentDocument.updateTime'), wantMissing = u.searchParams.get('currentDocument.exists') === 'false';
    if ((wantMissing && doc) || (wantTime && wantTime !== doc?.updateTime)) return new Response('{}', { status: 409 });
    doc = { fields: JSON.parse(init.body).fields, updateTime: `t${++seq}` };
    return new Response('{}');
  }) as unknown as typeof fetch;
  return { fetcher, calls, set: (l: Lease) => { /* 직접 심기 */ doc = { fields: Object.fromEntries(Object.entries(l).map(([k, v]) => [k, typeof v === 'number' ? { integerValue: String(v) } : v === null ? { nullValue: null } : { stringValue: v }])), updateTime: `t${++seq}` }; } };
}
const env = { FIREBASE_PROJECT_ID: 'freepasserp5' } as NodeJS.ProcessEnv;

describe('writerLeaseStore', () => {
  it('없으면 NO_LEASE, 인수 뒤 보유자만 held, 이전 뒤에는 이전 PC 가 not held', async () => {
    const f = fakeFirestore(); const store = writerLeaseStore({ env, fetcher: f.fetcher, token: async () => 't' });
    expect(await store.check('source-cycle', 'PC3', T0)).toMatchObject({ held: false, status: 'NO_LEASE' });
    expect(await store.claim('source-cycle', 'PC1', 180, undefined, T0)).toMatchObject({ done: true, status: 'CREATE', holder: 'PC1', epoch: 1 });
    expect(await store.check('source-cycle', 'PC1', T0 + min(5))).toMatchObject({ held: true, status: 'HELD' });
    expect(await store.check('source-cycle', 'PC3', T0 + min(5))).toMatchObject({ held: false, status: 'NOT_HELD', holder: 'PC1' });
    expect(await store.claim('source-cycle', 'PC3', 180, undefined, T0 + min(5))).toMatchObject({ done: false, status: 'REFUSED' });
    expect(await store.transfer('source-cycle', 'PC1', 'PC3', 1, 180, undefined, T0 + min(6))).toMatchObject({ done: true, holder: 'PC3', epoch: 2, previousHolder: 'PC1' });
    expect(await store.check('source-cycle', 'PC1', T0 + min(7))).toMatchObject({ held: false });
    expect(await store.check('source-cycle', 'PC3', T0 + min(7))).toMatchObject({ held: true });
  });
  it('handover 한 명령으로 양방향 전환, 이전 쪽은 다음 확인부터 not held', async () => {
    const f = fakeFirestore(); const store = writerLeaseStore({ env, fetcher: f.fetcher, token: async () => 't' });
    await store.claim('settlement-intake', 'PC1', 180, undefined, T0);
    expect(await store.handover('settlement-intake', 'PC3', 180, undefined, T0 + min(1))).toMatchObject({ done: true, holder: 'PC3', epoch: 2 });
    expect(await store.check('settlement-intake', 'PC1', T0 + min(2))).toMatchObject({ held: false, holder: 'PC3' });
    expect(await store.handover('settlement-intake', 'PC1', 180, undefined, T0 + min(3))).toMatchObject({ done: true, holder: 'PC1', epoch: 3 });
    expect(await store.check('settlement-intake', 'PC1', T0 + min(4))).toMatchObject({ held: true });
    const empty = writerLeaseStore({ env, fetcher: fakeFirestore().fetcher, token: async () => 't' });
    expect(await empty.handover('other-lane', 'PC1', 180, undefined, T0)).toMatchObject({ done: false, reason: 'NO_LEASE' });
  });
  it('손상 문서는 닫힘(throw)', async () => {
    const f = fakeFirestore(); f.set({ ...lease(), lane: 'other-lane' });
    const store = writerLeaseStore({ env, fetcher: f.fetcher, token: async () => 't' });
    await expect(store.check('source-cycle', 'PC3', T0)).rejects.toThrow('WRITER_LEASE_DOCUMENT_CORRUPT');
  });
});

describe('writerLeaseGate', () => {
  const dir = () => mkdtemp(join(tmpdir(), 'lease-'));
  it('꺼져 있으면 아무것도 하지 않는다', async () => expect(await writerLeaseGate({ SOURCE_CYCLE_PRIVATE_DIR: await dir() } as NodeJS.ProcessEnv)).toBeNull());
  it('내 임대면 통과(null), 남의 임대면 쓰기 0·exit 0 으로 기록', async () => {
    const d = await dir(); const base = { SOURCE_CYCLE_PRIVATE_DIR: d, WRITER_LEASE_ENFORCE: '1', WRITER_LEASE_LANE: 'source-cycle', WRITER_LEASE_PC: 'PC1' } as NodeJS.ProcessEnv;
    expect(await writerLeaseGate(base, { check: async () => ({ held: true, status: 'HELD', holder: 'PC1', epoch: 1, expiresAt: 'x' }) } as any)).toBeNull();
    const skipped = await writerLeaseGate(base, { check: async () => ({ held: false, status: 'NOT_HELD', holder: 'PC3', expired: false }) } as any);
    expect(skipped).toMatchObject({ exit: 0, lease: { status: 'NOT_HELD', holder: 'PC3' } });
    expect(JSON.parse((await readFile(join(d, 'lease-skips.jsonl'), 'utf8')).trim())).toMatchObject({ lane: 'source-cycle', pc: 'PC1', writes: 0 });
  });
  it('임대를 못 읽으면 닫힘: exit 1 + 알림', async () => {
    const d = await dir(); const env2 = { SOURCE_CYCLE_PRIVATE_DIR: d, WRITER_LEASE_ENFORCE: '1', WRITER_LEASE_LANE: 'source-cycle', WRITER_LEASE_PC: 'PC1' } as NodeJS.ProcessEnv;
    const r = await writerLeaseGate(env2, { check: async () => { throw new Error('WRITER_LEASE_REQUEST_FAILED'); } } as any);
    expect(r).toMatchObject({ exit: 1, lease: { error: 'WRITER_LEASE_REQUEST_FAILED' } });
    expect(await readFile(join(d, 'alerts.jsonl'), 'utf8')).toContain('WRITER_LEASE_REQUEST_FAILED');
  });
  it('임대 문서가 아예 없으면 exit 1 (정상 건너뜀으로 숨기지 않는다)', async () => {
    const d = await dir(); const e = { SOURCE_CYCLE_PRIVATE_DIR: d, WRITER_LEASE_ENFORCE: '1', WRITER_LEASE_LANE: 'source-cycle', WRITER_LEASE_PC: 'PC1' } as NodeJS.ProcessEnv;
    expect(await writerLeaseGate(e, { check: async () => ({ held: false, status: 'NO_LEASE' }) } as any)).toMatchObject({ exit: 1, lease: { error: 'WRITER_LEASE_MISSING' } });
  });
  it('켰는데 설정이 빠졌으면 닫힘', async () => {
    const r = await writerLeaseGate({ SOURCE_CYCLE_PRIVATE_DIR: await dir(), WRITER_LEASE_ENFORCE: '1' } as NodeJS.ProcessEnv);
    expect(r).toMatchObject({ exit: 1, lease: { error: 'WRITER_LEASE_LANE_INVALID' } });
  });
});
