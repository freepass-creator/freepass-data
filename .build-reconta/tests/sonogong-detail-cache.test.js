import { describe, expect, it, vi } from 'vitest';
import { createSonogongApiClient, readSonogongApi } from '../src/adapters/sonogong-api.js';
import { cachedDetailFor, DETAIL_CACHE_POLICY, DETAIL_CACHE_VERSION, fullRefreshDue, parseDetailCache, waitForUpstreamRefresh } from '../src/adapters/sonogong-detail-cache.js';
// 값은 전부 가짜. 상세 캐시(직전 회차 목록 행 digest 가 같은 차만 상세 재사용)와 상류 갱신 대기.
const KEY = 'SYNTHETIC_PARTNER_KEY_SENTINEL', BASE = 'https://sokrc.com/api/partner/v1';
const json = (data, attrs = { generatedAt: '2026-10-14T06:00:00.000Z' }) => new Response(JSON.stringify({ success: true, data, attrs }), { status: 200 });
const row = (id, plate, extra = {}) => ({ id, carNumber: plate, brand: '현대', model: '아반떼', detailName: 'CN7', fuel: '가솔린',
    exteriorColor: '흰색', manufactureYearMonth: '2023-05', mileageKm: 12345, displacementCc: 1598, hasActiveContract: false,
    prices: { SUBSCRIBE_RETURN: { monthly: { 12: 900000, 24: 800000, 36: 700000, 48: 650000, 60: 600000 } } }, tab: 'sub', ...extra });
const detail = (id, plate) => ({ id, carNumber: plate, carName: '현대_아반떼_CN7', images: [{ url: 'https://example.invalid/a.jpg', sortOrder: 0 }],
    prices: { SUBSCRIBE_RETURN: { monthly: { 12: 900000, 24: 800000, 36: 700000, 48: 650000, 60: 600000 }, deposit: { 12: 1000000, 24: 0, 36: 2000000, 48: null, 60: 3000000 } } } });
const plateOf = (id) => `100하${String(id).repeat(4)}`;
function world(rows) {
    const detailCalls = [];
    let clock = Date.parse('2026-10-14T06:00:00Z');
    const fakeFetch = vi.fn(async (url) => {
        const u = new URL(String(url));
        if (u.pathname.endsWith('/vehicles')) {
            const tab = u.searchParams.get('tab'), page = Number(u.searchParams.get('page'));
            return json(tab === 'sub' && page === 1 ? rows() : [], { generatedAt: '2026-10-14T06:00:00.000Z', totalCount: tab === 'sub' ? rows().length : 0 });
        }
        const id = Number(u.pathname.split('/').at(-1));
        detailCalls.push(id);
        return json(detail(id, plateOf(id)));
    });
    const client = createSonogongApiClient({ base: BASE, key: KEY, fetch: fakeFetch, now: () => clock, sleep: async (ms) => { clock += ms; } });
    return { client, detailCalls };
}
const T0 = '2026-10-14T06:10:00.000Z';
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
function worldWithGeneration(rows, generatedAt) {
    const detailCalls = [];
    const fakeFetch = vi.fn(async (url) => {
        const u = new URL(String(url));
        if (u.pathname.endsWith('/vehicles')) {
            const tab = u.searchParams.get('tab'), page = Number(u.searchParams.get('page'));
            return json(tab === 'sub' && page === 1 ? rows() : [], { generatedAt, totalCount: tab === 'sub' ? rows().length : 0 });
        }
        const id = Number(u.pathname.split('/').at(-1));
        detailCalls.push(id);
        return json(detail(id, plateOf(id)));
    });
    let clock = Date.parse('2026-10-14T06:00:00Z');
    return { client: createSonogongApiClient({ base: BASE, key: KEY, fetch: fakeFetch, now: () => clock, sleep: async (ms) => { clock += ms; } }), detailCalls };
}
describe('손오공 상세 캐시', () => {
    const rows = () => [row(1, plateOf(1)), row(2, plateOf(2)), row(3, plateOf(3))];
    it('첫 회차(캐시 없음)는 전수 읽기, 다음 회차는 목록 행이 같은 차의 상세를 다시 읽지 않는다', async () => {
        const w1 = world(rows);
        const first = await readSonogongApi(w1.client, { now: () => T0, detailCache: null });
        expect(w1.detailCalls.sort()).toEqual([1, 2, 3]);
        expect(first.detailsCached).toBe(0);
        expect(first.detailCacheOut.lastFullAt).toBe(T0);
        expect(Object.keys(first.detailCacheOut.entries).sort()).toEqual(['1', '2', '3']);
        const w2 = world(rows);
        const second = await readSonogongApi(w2.client, { now: () => at(60), detailCache: first.detailCacheOut });
        expect(w2.detailCalls).toEqual([]);
        expect(second.detailsCached).toBe(3);
        expect(second.notes).toContain('DETAIL_CACHE_HIT:3');
        expect(second.complete).toBe(true);
        // 캐시된 상세로 만든 레코드가 직접 읽은 것과 같다(보증금·사진)
        expect(second.records.map(r => r.terms.map(t => [t.months, t.deposit.state, t.deposit.value]))).toEqual(first.records.map(r => r.terms.map(t => [t.months, t.deposit.state, t.deposit.value])));
        expect(second.records[0].raw.images).toEqual(['https://example.invalid/a.jpg']);
    });
    it('목록 행이 바뀐 차(가격·상태)만 상세를 다시 읽는다', async () => {
        const w1 = world(rows);
        const first = await readSonogongApi(w1.client, { now: () => T0, detailCache: null });
        const changed = () => [row(1, plateOf(1)), row(2, plateOf(2), { hasActiveContract: true }), row(3, plateOf(3), { prices: { SUBSCRIBE_RETURN: { monthly: { 12: 1, 24: 2, 36: 3, 48: 4, 60: 5 } } } })];
        const w2 = world(changed);
        const second = await readSonogongApi(w2.client, { now: () => at(60), detailCache: first.detailCacheOut });
        expect(w2.detailCalls.sort()).toEqual([2, 3]);
        expect(second.detailsCached).toBe(1);
    });
    it('유효 상한(6시간)을 넘은 항목과 전수 갱신 시기(24시간)가 지난 회차는 다시 읽는다', async () => {
        const w1 = world(rows);
        const first = await readSonogongApi(w1.client, { now: () => T0, detailCache: null });
        const old = world(rows);
        await readSonogongApi(old.client, { now: () => at(7 * 60), detailCache: first.detailCacheOut }); // 7시간 뒤: 상한 초과 → 전부 재읽기
        expect(old.detailCalls.sort()).toEqual([1, 2, 3]);
        // 5시간 뒤: 유효, 하지만 전수 갱신 시각이 25시간 전이면 캐시를 쓰지 않는다
        const stale = { ...first.detailCacheOut, lastFullAt: at(-25 * 60 + 5 * 60) };
        const full = world(rows);
        const result = await readSonogongApi(full.client, { now: () => at(5 * 60), detailCache: stale });
        expect(full.detailCalls.sort()).toEqual([1, 2, 3]);
        expect(result.detailCacheOut.lastFullAt).toBe(at(5 * 60));
    });
    it('상태 파일 손상·형식 불일치는 캐시 없음(전수 읽기)이다', () => {
        const good = { version: DETAIL_CACHE_VERSION, writtenAt: T0, lastFullAt: T0, lastGeneratedAt: T0,
            entries: { '1': { rowDigest: 'a'.repeat(32), detail: { carNumber: 'x' }, cachedAt: T0, generatedAt: T0 } } };
        expect(parseDetailCache(good)).not.toBeNull();
        for (const bad of [null, 'x', [], {}, { ...good, version: 'other' }, { ...good, writtenAt: 'nope' }, { ...good, entries: [] },
            { ...good, entries: { '1': { rowDigest: 'zz', detail: {}, cachedAt: T0, generatedAt: T0 } } },
            { ...good, entries: { '1': { rowDigest: 'a'.repeat(32), detail: 'str', cachedAt: T0, generatedAt: T0 } } },
            { ...good, entries: { '1': { rowDigest: 'a'.repeat(32), detail: {}, cachedAt: 'nope', generatedAt: T0 } } },
            { ...good, entries: { '1': { rowDigest: 'a'.repeat(32), detail: {}, cachedAt: T0, generatedAt: 'nope' } } },
            { ...good, lastFullAt: 'nope' }])
            expect(parseDetailCache(bad), JSON.stringify(bad).slice(0, 60)).toBeNull();
        expect(fullRefreshDue(null, Date.parse(T0))).toBe(true);
        expect(fullRefreshDue({ ...good, lastFullAt: null }, Date.parse(T0))).toBe(true);
        expect(fullRefreshDue(good, Date.parse(T0) + DETAIL_CACHE_POLICY.fullRefreshAfterMs - 1)).toBe(false);
        expect(cachedDetailFor(good, '1', 'b'.repeat(32), Date.parse(T0), T0)).toBeNull(); // digest 불일치
        expect(cachedDetailFor(good, '1', 'a'.repeat(32), Date.parse(T0), T0)).not.toBeNull();
        expect(cachedDetailFor(good, '1', 'a'.repeat(32), Date.parse(T0), at(60))).toBeNull(); // 다른 판(생성 시각 불일치)
        expect(cachedDetailFor(good, '1', 'a'.repeat(32), Date.parse(T0), null)).toBeNull(); // 현재 판 미확정
        const unknownGen = { ...good, entries: { '1': { ...good.entries['1'], generatedAt: null } } };
        expect(cachedDetailFor(unknownGen, '1', 'a'.repeat(32), Date.parse(T0), T0)).toBeNull(); // 저장 때 판 미확정
    });
    it('(Codex #666 ⑴) 상류가 새 판을 만들면 목록 행이 같아도 상세를 다시 읽는다 — 상세에만 있는 값의 낡음 방지', async () => {
        const w1 = world(rows);
        const first = await readSonogongApi(w1.client, { now: () => T0, detailCache: null });
        expect(first.detailCacheOut.entries['1'].generatedAt).toBe('2026-10-14T06:00:00.000Z');
        // 같은 목록 행이지만 상류 생성 시각이 다른 판
        const newer = worldWithGeneration(rows, '2026-10-14T07:00:00.000Z');
        const second = await readSonogongApi(newer.client, { now: () => at(60), detailCache: first.detailCacheOut });
        expect(newer.detailCalls.sort()).toEqual([1, 2, 3]);
        expect(second.detailsCached).toBe(0);
        expect(second.detailCacheOut.entries['1'].generatedAt).toBe('2026-10-14T07:00:00.000Z');
    });
    it('(Codex #666 ⑷) 전수 시각이 미래(시계 역행·손상)이면 전수 갱신 차례다', () => {
        const base = { version: DETAIL_CACHE_VERSION, writtenAt: T0, lastFullAt: at(120), lastGeneratedAt: T0, entries: {} };
        expect(fullRefreshDue(base, Date.parse(T0))).toBe(true); // 2시간 미래
        expect(fullRefreshDue({ ...base, lastFullAt: at(3) }, Date.parse(T0))).toBe(false); // 5분 이내 시계 오차는 허용
        expect(fullRefreshDue({ ...base, lastFullAt: at(-10) }, Date.parse(T0))).toBe(false);
    });
    it('캐시를 주지 않으면(undefined) 종전과 같이 전수 읽고 캐시 출력도 없다', async () => {
        const w = world(rows);
        const read = await readSonogongApi(w.client, { now: () => T0 });
        expect(w.detailCalls.sort()).toEqual([1, 2, 3]);
        expect(read.detailCacheOut).toBeUndefined();
    });
    it('캐시된 상세도 번호 대조를 거친다(다른 차의 상세가 섞이면 그 차만 보류)', async () => {
        const w1 = world(rows);
        const first = await readSonogongApi(w1.client, { now: () => T0, detailCache: null });
        const tampered = { ...first.detailCacheOut, entries: { ...first.detailCacheOut.entries,
                '2': { ...first.detailCacheOut.entries['2'], detail: { ...first.detailCacheOut.entries['2'].detail, carNumber: '100하0000' } } } };
        const w2 = world(rows);
        const second = await readSonogongApi(w2.client, { now: () => at(60), detailCache: tampered });
        expect(second.held).toEqual([{ tab: 'sub', reason: 'IDENTITY_MISMATCH' }]);
        expect(second.records.map(r => r.plate.slice(-4)).sort()).toEqual(['1111', '3333']);
    });
});
describe('상류 갱신 대기', () => {
    it('생성 시각이 바뀌면 기다리지 않고 시작한다', async () => {
        const sleep = vi.fn(async () => undefined);
        const r = await waitForUpstreamRefresh(async () => '2026-10-14T07:00:00.000Z', { lastGeneratedAt: '2026-10-14T06:00:00.000Z', maxWaitMs: 300_000, pollMs: 60_000, sleep });
        expect(r).toMatchObject({ changed: true, probeFailed: false });
        expect(sleep).not.toHaveBeenCalled();
    });
    it('바뀌지 않으면 최대 대기 시간까지만 기다리고 그대로 진행한다(영영 시작 못 하지 않음)', async () => {
        let clock = 0;
        const sleep = vi.fn(async (ms) => { clock += ms; });
        const r = await waitForUpstreamRefresh(async () => '2026-10-14T06:00:00.000Z', { lastGeneratedAt: '2026-10-14T06:00:00.000Z', maxWaitMs: 180_000, pollMs: 60_000, sleep, now: () => clock });
        expect(r.changed).toBe(false);
        expect(sleep.mock.calls.length).toBeLessThanOrEqual(3);
        expect(clock).toBeLessThanOrEqual(180_000);
    });
    it('도중에 바뀌면 그 시점에 시작하고, 첫 회차(기준 없음)·대기 0·조회 실패는 기다리지 않는다', async () => {
        let clock = 0, n = 0;
        const r = await waitForUpstreamRefresh(async () => (++n < 3 ? '2026-10-14T06:00:00.000Z' : '2026-10-14T07:00:00.000Z'), { lastGeneratedAt: '2026-10-14T06:00:00.000Z', maxWaitMs: 600_000, pollMs: 60_000, sleep: async (ms) => { clock += ms; }, now: () => clock });
        expect(r).toMatchObject({ changed: true, generatedAt: '2026-10-14T07:00:00.000Z' });
        expect(clock).toBe(120_000);
        const probe = vi.fn(async () => '2026-10-14T06:00:00.000Z');
        expect((await waitForUpstreamRefresh(probe, { lastGeneratedAt: null, maxWaitMs: 300_000, pollMs: 60_000, sleep: async () => undefined })).changed).toBe(true);
        expect((await waitForUpstreamRefresh(probe, { lastGeneratedAt: 'x', maxWaitMs: 0, pollMs: 60_000, sleep: async () => undefined })).changed).toBe(true);
        expect(probe).not.toHaveBeenCalled();
        const failed = await waitForUpstreamRefresh(async () => { throw new Error('boom'); }, { lastGeneratedAt: '2026-10-14T06:00:00.000Z', maxWaitMs: 300_000, pollMs: 60_000, sleep: async () => undefined });
        expect(failed).toMatchObject({ changed: false, probeFailed: true });
    });
});
