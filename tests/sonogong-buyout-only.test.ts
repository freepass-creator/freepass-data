import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSonogongApiClient, readSonogongApi } from '../src/adapters/sonogong-api.js';
import { salePriceMap, termIdentity, validateSourceRecord, type SourceTerm } from '../src/domain/source-engine.js';
import { firestoreCycleCommands, decodeFields } from '../src/infra/source-cycle-firestore.js';
import { planSourceCycle, applySourceCycle } from '../src/application/source-cycle.js';

// 값은 전부 가짜(손오공 파트너 API 모양). 인수형 전용 차 편입 규칙(대표 2026-10-15): 반납형 양수 행이 하나도 없을 때만 인수형 행을 쓴다.
const KEY = 'SYNTHETIC_PARTNER_KEY_SENTINEL', BASE = 'https://sokrc.com/api/partner/v1';
const json = (data: unknown, attrs: unknown = { generatedAt: '2026-10-15T06:00:00.000Z' }) => new Response(JSON.stringify({ success: true, data, attrs }), { status: 200 });
type Prices = Record<string, { monthly?: Record<string, number | null>; deposit?: Record<string, number | null> }>;
const row = (id: number, plate: string, tab: string, prices: Prices) => ({ id, carNumber: plate, brand: '현대', model: '아반떼', detailName: 'CN7', fuel: '가솔린',
  exteriorColor: '흰색', manufactureYearMonth: '2023-05', mileageKm: 12345, displacementCc: 1598, hasActiveContract: false, prices, tab, thumbnailUrl: null });
const detailOf = (id: number, plate: string, prices: Prices) => ({ id, carNumber: plate, carName: '현대_아반떼_CN7', images: [], prices });

async function readWith(tab: 'rent' | 'sub' | 'pick', prices: Prices, options: { withDetail?: boolean } = {}) {
  const plate = '100하1111';
  let clock = Date.parse('2026-10-15T06:00:00Z');
  const fakeFetch = (async (url: URL | RequestInfo) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/vehicles')) {
      const requested = u.searchParams.get('tab');
      return json(requested === tab ? [row(1, plate, tab, prices)] : [], { generatedAt: '2026-10-15T06:00:00.000Z', totalCount: requested === tab ? 1 : 0 });
    }
    if (options.withDetail === false) return new Response('{}', { status: 404 });
    return json(detailOf(1, plate, prices));
  }) as unknown as typeof fetch;
  const client = createSonogongApiClient({ base: BASE, key: KEY, fetch: fakeFetch, now: () => clock, sleep: async ms => { clock += ms; } });
  return readSonogongApi(client, { now: () => '2026-10-15T06:00:30.000Z' });   // 읽은 시각을 고정(계획 시각보다 앞)
}
const RET = { monthly: { 12: 900000, 36: 700000 }, deposit: { 12: 1000000, 36: 2000000 } };
const BUY = { monthly: { 36: 650000, 48: 600000 }, deposit: { 36: 5000000, 48: null } };

describe('손오공 인수형 전용 차 편입(대표 2026-10-15)', () => {
  it('(a) a vehicle with return prices is unchanged: return terms only, plain month keys, no buyout key', async () => {
    const read = await readWith('sub', { SUBSCRIBE_RETURN: RET });
    const record = read.records[0]!;
    expect(record.terms.map(t => [t.months, t.raw.priceType])).toEqual([[12, 'SUBSCRIBE_RETURN'], [36, 'SUBSCRIBE_RETURN']]);
    expect(Object.keys(salePriceMap(record.terms)).sort()).toEqual(['12', '36']);
    expect(record.raw.price_basis).toBeUndefined();
  });

  it('(b) return AND buyout prices: return only (mixed vehicles stay as today), buyout is kept in raw only', async () => {
    const read = await readWith('sub', { SUBSCRIBE_RETURN: RET, SUBSCRIBE_BUYOUT: BUY });
    const record = read.records[0]!;
    expect(record.terms.every(t => t.raw.priceType === 'SUBSCRIBE_RETURN')).toBe(true);
    expect(Object.keys(salePriceMap(record.terms)).some(k => k.includes('인수형'))).toBe(false);
    expect((record.raw.prices as Prices).SUBSCRIBE_BUYOUT).toBeDefined();
  });

  it('(c) buyout prices only: only «{개월}_인수형» rows, no plain month key, nothing zero-filled; deposit from the same type', async () => {
    const read = await readWith('sub', { SUBSCRIBE_BUYOUT: BUY });
    const record = read.records[0]!;
    expect(read.complete).toBe(true);
    expect(record.terms.map(t => [t.months, t.raw.priceType, t.monthlyRent.value, t.deposit.state])).toEqual([
      [36, 'SUBSCRIBE_BUYOUT', 650000, 'KNOWN'], [48, 'SUBSCRIBE_BUYOUT', 600000, 'UNKNOWN']]);
    const price = salePriceMap(record.terms);
    expect(Object.keys(price).sort()).toEqual(['36_인수형', '48_인수형']);
    expect(price['36_인수형']).toMatchObject({ rent: 650000, deposit: 5000000 });
    expect(record.raw.price_basis).toBe('BUYOUT_ONLY');
    expect(validateSourceRecord(record)).toEqual([]);                    // 양수 대여료 행 ≥1 가드 통과
  });

  it('(d) neither return nor buyout has a positive monthly rent: terms stay empty → TERMS_HOLD (guard kept)', async () => {
    const read = await readWith('pick', { SUBSCRIBE_RETURN: { monthly: { 36: null } }, SUBSCRIBE_BUYOUT: { monthly: { 36: 0 } } });
    expect(read.records[0]!.terms).toEqual([]);
    expect(validateSourceRecord(read.records[0]!)).toContain('TERMS_HOLD');
  });

  it('(e) buyout deposit: unknown when the detail could not be read, never filled with zero', async () => {
    const read = await readWith('sub', { SUBSCRIBE_BUYOUT: BUY }, { withDetail: false });
    expect(read.records[0]!.terms.every(t => t.deposit.state === 'UNKNOWN')).toBe(true);
  });

  it('(f) return prices only for some months: still the return path (the switch needs NO positive return row at all)', async () => {
    const read = await readWith('sub', { SUBSCRIBE_RETURN: { monthly: { 36: 700000 }, deposit: { 36: 0 } }, SUBSCRIBE_BUYOUT: BUY });
    expect(read.records[0]!.terms.map(t => [t.months, t.raw.priceType])).toEqual([[36, 'SUBSCRIBE_RETURN']]);
    expect(Object.keys(salePriceMap(read.records[0]!.terms))).toEqual(['36']);
  });

  it('the 중고렌트 tab uses RENT_BUYOUT for the buyout-only rule', async () => {
    const read = await readWith('rent', { RENT_BUYOUT: { monthly: { 24: 500000 }, deposit: { 24: 3000000 } } });
    expect(read.records[0]!.terms.map(t => t.raw.priceType)).toEqual(['RENT_BUYOUT']);
    expect(read.records[0]!.raw.product_type).toBe('중고렌트');
    expect(Object.keys(salePriceMap(read.records[0]!.terms))).toEqual(['24_인수형']);
  });

  it('engine identity: the same month as return and buyout are different terms and never collide', () => {
    const term = (priceType: string): SourceTerm => ({ months: 36, monthlyRent: { state: 'KNOWN', value: 700000 }, deposit: { state: 'ZERO', value: 0 }, mileage: null, raw: { priceType } });
    expect(termIdentity(term('SUBSCRIBE_RETURN'))).toBe('36|');                     // 기존 문서의 식별자는 그대로
    expect(termIdentity(term('SUBSCRIBE_BUYOUT'))).toBe('36||BUYOUT');
    const price = salePriceMap([term('SUBSCRIBE_RETURN'), term('SUBSCRIBE_BUYOUT')]);
    expect(Object.keys(price).sort()).toEqual(['36', '36_인수형']);
  });
});

describe('(g) 쓰기·되읽기 왕복', () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
  function fakeFirestore() {
    const docs = new Map<string, any>(); let version = 0;
    const doc = (uid: string, fields: any) => ({ name: `projects/synthetic-test/databases/(default)/documents/products/${uid}`, updateTime: `2026-10-15T06:00:00.000Z:${++version}`, fields });
    const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input)), uid = decodeURIComponent(url.pathname.split('/').at(-1)!);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      if (!init.method || init.method === 'GET') {
        let result: any = uid === 'products' ? { documents: [...docs.values()] } : docs.get(uid);
        if (!result) return new Response('{}', { status: 404 });
        result = structuredClone(result);
        const masked = url.searchParams.getAll('mask.fieldPaths').map(p => p.replace(/`/g, ''));
        if (uid === 'products' && masked.length) for (const d of result.documents) d.fields = Object.fromEntries(Object.entries(d.fields ?? {}).filter(([k]) => masked.includes(k)));
        return Response.json(result);
      }
      const current = docs.get(uid);
      if (url.searchParams.get('currentDocument.exists') === 'false' ? !!current : current?.updateTime !== url.searchParams.get('currentDocument.updateTime')) return new Response('{}', { status: 412 });
      const fields = url.searchParams.has('updateMask.fieldPaths') ? { ...current?.fields, ...body.fields } : body.fields;
      const after = doc(uid, fields); docs.set(uid, after); return Response.json(after);
    }) as unknown as typeof fetch;
    return { docs, fetcher };
  }

  it('enrolls a buyout-only vehicle exposed with «{개월}_인수형» rows, reads it back identically, and the next cycle is unchanged', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'buyout-only-')); dirs.push(dir);
    const fake = fakeFirestore();
    const commands = firestoreCycleCommands({ directory: dir, env: { FIREBASE_PROJECT_ID: 'synthetic-test' }, token: async () => 'synthetic-token', fetcher: fake.fetcher,
      supplierDefaults: { RP012: { provider_name: '합성손오공', policy_code: 'SYNTHETIC_POLICY' } } });
    const read = await readWith('pick', { SUBSCRIBE_BUYOUT: BUY });
    const now = Date.parse('2026-10-15T06:05:00.000Z');
    const plan = async () => planSourceCycle({ sourceId: 'RP012', family: 'OTHER', maxDowngradeRatio: 1 },
      { records: read.records, observedAt: read.observedAt, heldCount: 0, complete: true }, await commands.list('RP012'), now);
    const built = await plan();
    expect(built.plan.entries.map(e => [e.kind, e.after.listable])).toEqual([['ENROLL', true]]);
    const applied = await applySourceCycle(commands, built.plan, { apply: true, digest: built.digest, approval: built.digest, now });
    expect(applied).toMatchObject({ status: 'APPLIED', verified: 1 });
    const stored = decodeFields(fake.docs.get('100하1111').fields) as Record<string, any>;
    expect(Object.keys(stored.price).sort()).toEqual(['36_인수형', '48_인수형']);
    expect(stored.product_type).toBe('픽업구독');
    expect((await plan()).plan.entries).toEqual([]);                        // 되풀이 쓰기 없음(PRICE_LAYOUT 등 재기록 사유 없음)
  });

  it('an existing exposed return-priced document is not touched by the new rule (no UPDATE)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'buyout-only-')); dirs.push(dir);
    const fake = fakeFirestore();
    const commands = firestoreCycleCommands({ directory: dir, env: { FIREBASE_PROJECT_ID: 'synthetic-test' }, token: async () => 'synthetic-token', fetcher: fake.fetcher,
      supplierDefaults: { RP012: { provider_name: '합성손오공', policy_code: 'SYNTHETIC_POLICY' } } });
    const read = await readWith('sub', { SUBSCRIBE_RETURN: RET, SUBSCRIBE_BUYOUT: BUY });
    const now = Date.parse('2026-10-15T06:05:00.000Z');
    const first = planSourceCycle({ sourceId: 'RP012', family: 'OTHER', maxDowngradeRatio: 1 },
      { records: read.records, observedAt: read.observedAt, heldCount: 0, complete: true }, await commands.list('RP012'), now);
    await applySourceCycle(commands, first.plan, { apply: true, digest: first.digest, approval: first.digest, now });
    const again = planSourceCycle({ sourceId: 'RP012', family: 'OTHER', maxDowngradeRatio: 1 },
      { records: read.records, observedAt: read.observedAt, heldCount: 0, complete: true }, await commands.list('RP012'), now);
    expect(again.plan.entries).toEqual([]);
    const stored = decodeFields(fake.docs.get('100하1111').fields) as Record<string, any>;
    expect(Object.keys(stored.price).sort()).toEqual(['12', '36']);
  });
});
