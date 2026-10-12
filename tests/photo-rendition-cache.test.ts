import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createPhotoRenditionCache } from '../src/api/photo-rendition-cache.js';
import { createConsumerGateway, type ConsumerBinding } from '../src/api/consumer-gateway.js';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { createVehiclePhotoReader, type VehiclePhotoSource } from '../src/domain/consumer-output-contract.js';
import { parseIancarPhotoIdGateSuppliers } from '../src/infra/erp5-compat-catalog-reader.js';

const buf = (n: number, fill = 1) => Buffer.alloc(n, fill);

describe('사진 줄인 결과물 캐시(메모리)', () => {
  it('같은 키는 적중하고 사본을 돌려준다(바깥에서 바꿔도 캐시가 안 바뀜)', () => {
    const cache = createPhotoRenditionCache();
    cache.set('p1', 0, 'list', 'tagA', { bytes: buf(10), contentType: 'image/jpeg' });
    const hit = cache.get('p1', 0, 'list', 'tagA')!;
    expect(hit.bytes.length).toBe(10);
    hit.bytes[0] = 99;
    expect(cache.get('p1', 0, 'list', 'tagA')!.bytes[0]).toBe(1);
  });
  it('상품·순번·크기·내용 표지가 하나라도 다르면 적중하지 않는다', () => {
    const cache = createPhotoRenditionCache();
    cache.set('p1', 0, 'list', 'tagA', { bytes: buf(10), contentType: 'image/jpeg' });
    expect(cache.get('p2', 0, 'list', 'tagA')).toBeUndefined();
    expect(cache.get('p1', 1, 'list', 'tagA')).toBeUndefined();
    expect(cache.get('p1', 0, 'detail', 'tagA')).toBeUndefined();
    expect(cache.get('p1', 0, 'list', 'tagB')).toBeUndefined();
  });
  it('시간이 지나면 버린다', () => {
    let t = 1000;
    const cache = createPhotoRenditionCache({ ttlMs: 500, now: () => t });
    cache.set('p1', 0, 'list', 'x', { bytes: buf(10), contentType: 'image/jpeg' });
    t = 1499; expect(cache.get('p1', 0, 'list', 'x')).toBeDefined();
    t = 1501; expect(cache.get('p1', 0, 'list', 'x')).toBeUndefined();
    expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
  });
  it('바이트·항목 수 한도를 넘으면 가장 오래 안 쓴 것부터 버린다', () => {
    const cache = createPhotoRenditionCache({ maxBytes: 100, maxEntries: 3 });
    for (let i = 0; i < 3; i++) cache.set('p', i, 'list', 't', { bytes: buf(20), contentType: 'image/jpeg' });
    cache.get('p', 0, 'list', 't');                                            // 0 을 최근 사용으로
    cache.set('p', 3, 'list', 't', { bytes: buf(20), contentType: 'image/jpeg' }); // 항목 한도 3 → 가장 오래된 1 이 밀려남
    expect(cache.get('p', 1, 'list', 't')).toBeUndefined();
    expect(cache.get('p', 0, 'list', 't')).toBeDefined();
    for (let i = 10; i < 14; i++) cache.set('q', i, 'list', 't', { bytes: buf(24), contentType: 'image/jpeg' });
    expect(cache.stats().bytes).toBeLessThanOrEqual(100);
  });
  it('한 항목이 전체 한도의 1/4 를 넘으면 담지 않고 빈 값도 거부', () => {
    const cache = createPhotoRenditionCache({ maxBytes: 100 });
    cache.set('p', 0, 'list', 't', { bytes: buf(26), contentType: 'image/jpeg' });
    cache.set('p', 1, 'list', 't', { bytes: Buffer.alloc(0), contentType: 'image/jpeg' });
    expect(cache.stats().entries).toBe(0);
  });
  it('상품 단위로 모두 버린다', () => {
    const cache = createPhotoRenditionCache();
    cache.set('p1', 0, 'list', 't', { bytes: buf(5), contentType: 'image/jpeg' });
    cache.set('p1', 1, 'detail', 't', { bytes: buf(5), contentType: 'image/jpeg' });
    cache.set('p2', 0, 'list', 't', { bytes: buf(5), contentType: 'image/jpeg' });
    cache.dropProduct('p1');
    expect(cache.get('p1', 0, 'list', 't')).toBeUndefined();
    expect(cache.get('p2', 0, 'list', 't')).toBeDefined();
  });
});

describe('게이트웨이: 캐시 적중은 원천(ONE)을 건너뛰고 DB 재확인은 그대로', () => {
  const token = 'test-media-token-0123456789abcdefghij';
  const binding: ConsumerBinding = { id: 'erp5-public-media', projectionId: 'erp-public', token, capabilities: ['photos'] };
  const headers = { authorization: `Bearer ${token}` };
  const IDS = ['id-A', 'id-B', 'id-C'];
  const product = { provider_company_code: 'RP031', listable: true, status_kind: '가용', iancar_one_vehicle_id: 'EANCAR-q', car_number: '12가3456', iancar_one_photo_ids: IDS };
  const url = (path = '') => `/v1/consumers/erp5-public-media/catalog-compat/products/iancar_abc/photos${path}`;
  const build = async () => {
    const jpeg = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#778899' } }).jpeg().toBuffer();
    let sourceCalls = 0, dbReads = 0;
    let current: Record<string, unknown> = { ...product };
    const source: VehiclePhotoSource = {
      eligible: () => true, connection: () => 'c',
      read: async (_p, index) => {
        if (index !== undefined) sourceCalls++;
        return { count: 3, photoIds: IDS, upstreamPhotoIds: [IDS[1]!, IDS[0]!, IDS[2]!], upstreamRepresentatives: [false, true, false], servingSourceOrdinals: [1, 0, 2],
          bytes: index === undefined ? null : jpeg, contentType: index === undefined ? 'application/json' : 'image/jpeg' };
      },
    };
    const readVehiclePhoto = createVehiclePhotoReader(async () => { dbReads++; return { ...current }; }, source, undefined, Date.now, undefined, parseIancarPhotoIdGateSuppliers('RP031'));
    const app = createConsumerGateway(new MemoryDataStore(), [binding], new DataAccessGateway(new MemoryDataAccessLogStore()), undefined,
      { read: async () => { throw new Error('unused'); }, readVehiclePhoto } as never);
    return { app, set: (next: Record<string, unknown>) => { current = next; }, calls: () => ({ sourceCalls, dbReads }) };
  };
  it('첫 요청은 원천을 읽고, 같은 상품·순번·크기 재요청은 원천을 읽지 않으며 HIT 표시, 바이트 동일, DB 는 다시 읽는다', async () => {
    const { app, calls } = await build();
    const first = await app.inject({ url: url('/0?size=list'), headers });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-photo-cache']).toBeUndefined();
    const afterFirst = calls();
    const second = await app.inject({ url: url('/0?size=list'), headers });
    expect(second.statusCode).toBe(200);
    expect(second.headers['x-photo-cache']).toBe('HIT');
    expect(second.rawPayload).toEqual(first.rawPayload);
    expect(second.headers['content-type']).toBe('image/jpeg');
    expect(calls().sourceCalls).toBe(afterFirst.sourceCalls);          // 원천 호출 증가 없음
    expect(calls().dbReads).toBeGreaterThan(afterFirst.dbReads);        // DB 재확인은 했다
    await app.close();
  });
  it('크기나 순번이 다르면 다시 읽는다', async () => {
    const { app, calls } = await build();
    await app.inject({ url: url('/0?size=list'), headers });
    const before = calls().sourceCalls;
    expect((await app.inject({ url: url('/0?size=detail'), headers })).headers['x-photo-cache']).toBeUndefined();
    expect((await app.inject({ url: url('/1?size=list'), headers })).headers['x-photo-cache']).toBeUndefined();
    expect(calls().sourceCalls).toBe(before + 2);
    await app.close();
  });
  it('캐시가 있어도 철회·비공개가 되면 내보내지 않고 404, 항목은 버려진다', async () => {
    const { app, set } = await build();
    await app.inject({ url: url('/0?size=list'), headers });
    set({ ...product, publication_withdrawal: { reason: 'x' } });
    const res = await app.inject({ url: url('/0?size=list'), headers });
    expect(res.statusCode).toBe(404);
    set({ ...product });                                                 // 다시 공개돼도 이전 캐시를 믿지 않고 새로 읽는다
    const again = await app.inject({ url: url('/0?size=list'), headers });
    expect(again.statusCode).toBe(200);
    expect(again.headers['x-photo-cache']).toBeUndefined();
    await app.close();
  });
  it('등록 개수(내용 표지)가 바뀌면 이전 캐시를 쓰지 않는다', async () => {
    const { app, set, calls } = await build();
    await app.inject({ url: url('/0?size=list'), headers });
    set({ ...product, iancar_one_photo_ids: [...IDS, 'id-D'] });        // 등록 4개 → 원천(3개)과 불일치 → 404, 캐시 적중 아님
    const res = await app.inject({ url: url('/0?size=list'), headers });
    expect(res.headers['x-photo-cache']).toBeUndefined();
    expect(res.statusCode).toBe(404);
    void calls;
    await app.close();
  });
  it('size 없는 원본 요청은 캐시하지 않는다', async () => {
    const { app, calls } = await build();
    await app.inject({ url: url('/0'), headers });
    const n = calls().sourceCalls;
    await app.inject({ url: url('/0'), headers });
    expect(calls().sourceCalls).toBe(n + 1);
    await app.close();
  });
});
