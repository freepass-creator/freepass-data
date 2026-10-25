import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createPhotoRenditionCache } from '../src/api/photo-rendition-cache.js';
import { createConsumerGateway } from '../src/api/consumer-gateway.js';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { createVehiclePhotoReader } from '../src/domain/consumer-output-contract.js';
import { parseIancarPhotoIdGateSuppliers } from '../src/infra/erp5-compat-catalog-reader.js';
const buf = (n, fill = 1) => Buffer.alloc(n, fill);
describe('사진 줄인 결과물 캐시(메모리)', () => {
    it('같은 키는 적중하고 사본을 돌려준다(바깥에서 바꿔도 캐시가 안 바뀜)', () => {
        const cache = createPhotoRenditionCache();
        cache.set('p1', 0, 'list', 'tagA', { bytes: buf(10), contentType: 'image/jpeg', sourceCheckedAt: 0 });
        const hit = cache.get('p1', 0, 'list', 'tagA');
        expect(hit.bytes.length).toBe(10);
        hit.bytes[0] = 99;
        expect(cache.get('p1', 0, 'list', 'tagA').bytes[0]).toBe(1);
    });
    it('상품·순번·크기·내용 표지가 하나라도 다르면 적중하지 않는다', () => {
        const cache = createPhotoRenditionCache();
        cache.set('p1', 0, 'list', 'tagA', { bytes: buf(10), contentType: 'image/jpeg', sourceCheckedAt: 0 });
        expect(cache.get('p2', 0, 'list', 'tagA')).toBeUndefined();
        expect(cache.get('p1', 1, 'list', 'tagA')).toBeUndefined();
        expect(cache.get('p1', 0, 'detail', 'tagA')).toBeUndefined();
        expect(cache.get('p1', 0, 'list', 'tagB')).toBeUndefined();
    });
    it('시간이 지나면 버린다', () => {
        let t = 1000;
        const cache = createPhotoRenditionCache({ ttlMs: 500, now: () => t });
        cache.set('p1', 0, 'list', 'x', { bytes: buf(10), contentType: 'image/jpeg', sourceCheckedAt: 0 });
        t = 1499;
        expect(cache.get('p1', 0, 'list', 'x')).toBeDefined();
        t = 1501;
        expect(cache.get('p1', 0, 'list', 'x')).toBeUndefined();
        expect(cache.stats()).toEqual({ entries: 0, bytes: 0 });
    });
    it('바이트·항목 수 한도를 넘으면 가장 오래 안 쓴 것부터 버린다', () => {
        const cache = createPhotoRenditionCache({ maxBytes: 100, maxEntries: 3 });
        for (let i = 0; i < 3; i++)
            cache.set('p', i, 'list', 't', { bytes: buf(20), contentType: 'image/jpeg', sourceCheckedAt: 0 });
        cache.get('p', 0, 'list', 't'); // 0 을 최근 사용으로
        cache.set('p', 3, 'list', 't', { bytes: buf(20), contentType: 'image/jpeg', sourceCheckedAt: 0 }); // 항목 한도 3 → 가장 오래된 1 이 밀려남
        expect(cache.get('p', 1, 'list', 't')).toBeUndefined();
        expect(cache.get('p', 0, 'list', 't')).toBeDefined();
        for (let i = 10; i < 14; i++)
            cache.set('q', i, 'list', 't', { bytes: buf(24), contentType: 'image/jpeg', sourceCheckedAt: 0 });
        expect(cache.stats().bytes).toBeLessThanOrEqual(100);
    });
    it('한 항목이 전체 한도의 1/4 를 넘으면 담지 않고 빈 값도 거부', () => {
        const cache = createPhotoRenditionCache({ maxBytes: 100 });
        cache.set('p', 0, 'list', 't', { bytes: buf(26), contentType: 'image/jpeg', sourceCheckedAt: 0 });
        cache.set('p', 1, 'list', 't', { bytes: Buffer.alloc(0), contentType: 'image/jpeg', sourceCheckedAt: 0 });
        expect(cache.stats().entries).toBe(0);
    });
    it('상품 단위로 모두 버린다', () => {
        const cache = createPhotoRenditionCache();
        cache.set('p1', 0, 'list', 't', { bytes: buf(5), contentType: 'image/jpeg', sourceCheckedAt: 0 });
        cache.set('p1', 1, 'detail', 't', { bytes: buf(5), contentType: 'image/jpeg', sourceCheckedAt: 0 });
        cache.set('p2', 0, 'list', 't', { bytes: buf(5), contentType: 'image/jpeg', sourceCheckedAt: 0 });
        cache.dropProduct('p1');
        expect(cache.get('p1', 0, 'list', 't')).toBeUndefined();
        expect(cache.get('p2', 0, 'list', 't')).toBeDefined();
    });
});
describe('게이트웨이: 캐시 적중은 원천(ONE)을 건너뛰고 DB 재확인은 그대로', () => {
    const token = 'test-media-token-0123456789abcdefghij';
    const binding = { id: 'erp5-public-media', projectionId: 'erp-public', token, capabilities: ['photos'] };
    const headers = { authorization: `Bearer ${token}` };
    const IDS = ['id-A', 'id-B', 'id-C'];
    const product = { provider_company_code: 'RP031', listable: true, status_kind: '가용', iancar_one_vehicle_id: 'EANCAR-q', car_number: '12가3456', iancar_one_photo_ids: IDS };
    const url = (path = '') => `/v1/consumers/erp5-public-media/catalog-compat/products/iancar_abc/photos${path}`;
    const build = async () => {
        const jpeg = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#778899' } }).jpeg().toBuffer();
        let sourceCalls = 0, metadataCalls = 0, dbReads = 0, clock = 1_000_000;
        let albumCount = 3, sourceError, failNextMetadata = false, repIndex = 1;
        let current = { ...product };
        let photoBytes = jpeg;
        const source = {
            eligible: () => true, connection: () => 'c',
            read: async (_p, index) => {
                if (sourceError)
                    throw sourceError;
                if (index === undefined && failNextMetadata) {
                    failNextMetadata = false;
                    throw new Error('IANCAR_ONE_API_HTTP_404');
                }
                if (index !== undefined)
                    sourceCalls++;
                else
                    metadataCalls++;
                const ids = IDS.slice(0, albumCount);
                if (albumCount === 3) { // 대표 사진 위치(repIndex)에 따라 제공 순서가 달라지는 앨범 — ID 는 그대로 두고 구성만 바꾼다
                    const upstream = [IDS[1], IDS[0], IDS[2]];
                    const ordinals = [repIndex, ...[0, 1, 2].filter(o => o !== repIndex)];
                    return { count: 3, photoIds: ordinals.map(o => upstream[o]), upstreamPhotoIds: upstream, upstreamRepresentatives: [0, 1, 2].map(o => o === repIndex), servingSourceOrdinals: ordinals,
                        bytes: index === undefined ? null : photoBytes, contentType: index === undefined ? 'application/json' : 'image/jpeg' };
                }
                return { count: albumCount, photoIds: ids, upstreamPhotoIds: [ids[1], ids[0], ids[2]].filter(Boolean), upstreamRepresentatives: [false, true, false].slice(0, albumCount), servingSourceOrdinals: [1, 0, 2].slice(0, albumCount),
                    bytes: index === undefined ? null : photoBytes, contentType: index === undefined ? 'application/json' : 'image/jpeg' };
            },
        };
        const readVehiclePhoto = createVehiclePhotoReader(async () => { dbReads++; return { ...current }; }, source, undefined, () => clock, undefined, parseIancarPhotoIdGateSuppliers('RP031'));
        const app = createConsumerGateway(new MemoryDataStore(), [binding], new DataAccessGateway(new MemoryDataAccessLogStore()), undefined, { read: async () => { throw new Error('unused'); }, readVehiclePhoto });
        return { app, set: (next) => { current = next; }, advance: (ms) => { clock += ms; },
            setAlbumCount: (n) => { albumCount = n; }, setBytes: (b) => { photoBytes = b; }, setRepresentative: (i) => { repIndex = i; }, failNextMetadata: () => { failNextMetadata = true; }, setSourceError: (e) => { sourceError = e; },
            calls: () => ({ sourceCalls, metadataCalls, dbReads }) };
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
        expect(calls().sourceCalls).toBe(afterFirst.sourceCalls); // 원천 호출 증가 없음
        expect(calls().dbReads).toBeGreaterThan(afterFirst.dbReads); // DB 재확인은 했다
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
        set({ ...product }); // 다시 공개돼도 이전 캐시를 믿지 않고 새로 읽는다
        const again = await app.inject({ url: url('/0?size=list'), headers });
        expect(again.statusCode).toBe(200);
        expect(again.headers['x-photo-cache']).toBeUndefined();
        await app.close();
    });
    it('등록 개수(내용 표지)가 바뀌면 이전 캐시를 쓰지 않는다', async () => {
        const { app, set, calls } = await build();
        await app.inject({ url: url('/0?size=list'), headers });
        set({ ...product, iancar_one_photo_ids: [...IDS, 'id-D'] }); // 등록 4개 → 원천(3개)과 불일치 → 404, 캐시 적중 아님
        const res = await app.inject({ url: url('/0?size=list'), headers });
        expect(res.headers['x-photo-cache']).toBeUndefined();
        expect(res.statusCode).toBe(404);
        void calls;
        await app.close();
    });
    it('원천 재확인 간격(10분) 안에는 원천을 전혀 부르지 않고, 지나면 그 순번 원본을 한 번만 다시 받아 내용·앨범을 대조한 뒤 다시 간격 안', async () => {
        const { app, calls, advance } = await build();
        await app.inject({ url: url('/0?size=list'), headers });
        const base = calls();
        advance(9 * 60 * 1000);
        expect((await app.inject({ url: url('/0?size=list'), headers })).headers['x-photo-cache']).toBe('HIT');
        expect(calls().sourceCalls).toBe(base.sourceCalls); // 간격 안: 원천 호출 0
        advance(2 * 60 * 1000); // 마지막 확인 후 11분
        const rechecked = await app.inject({ url: url('/0?size=list'), headers });
        expect(rechecked.headers['x-photo-cache']).toBe('HIT');
        expect(calls().sourceCalls).toBe(base.sourceCalls + 1); // 원본 대조용 1회 읽기(같은 내용이므로 캐시 유지)
        advance(60 * 1000);
        await app.inject({ url: url('/0?size=list'), headers });
        expect(calls().sourceCalls).toBe(base.sourceCalls + 1); // 재확인 시각이 갱신돼 다시 간격 안
        await app.close();
    });
    it('재확인에서 원천 앨범 개수가 바뀌었거나 차량이 사라졌으면(ONE 404) 캐시를 쓰지 않고 404, 이후에도 믿지 않는다', async () => {
        for (const mutate of ['count', 'gone']) {
            const { app, advance, setAlbumCount, setSourceError } = await build();
            await app.inject({ url: url('/0?size=list'), headers });
            advance(11 * 60 * 1000);
            if (mutate === 'count')
                setAlbumCount(2);
            else
                setSourceError(new Error('IANCAR_ONE_API_HTTP_404'));
            const res = await app.inject({ url: url('/0?size=list'), headers });
            expect(res.statusCode).toBe(404);
            expect(res.headers['x-photo-cache']).toBeUndefined();
            // 원천이 정상으로 돌아와도 방금 버린 캐시는 되살아나지 않고 새로 읽는다
            if (mutate === 'count')
                setAlbumCount(3);
            else
                setSourceError(undefined);
            const again = await app.inject({ url: url('/0?size=list'), headers });
            expect(again.statusCode).toBe(200);
            expect(again.headers['x-photo-cache']).toBeUndefined();
            await app.close();
        }
    });
    it('재확인에서 앨범 지문(사진 수·대표 표시·순서)이 캐시를 만들 때와 달라지면(개수는 같아도) 캐시를 쓰지 않는다', async () => {
        const { app, advance, setRepresentative } = await build();
        await app.inject({ url: url('/0?size=list'), headers });
        advance(11 * 60 * 1000);
        setRepresentative(2); // 대표 사진이 바뀜(원천에서 앨범 교체)
        const res = await app.inject({ url: url('/0?size=list'), headers });
        expect(res.statusCode).toBe(404);
        expect(res.headers['x-photo-cache']).toBeUndefined();
        const again = await app.inject({ url: url('/0?size=list'), headers }); // 새 지문으로 다시 읽어 서빙
        expect(again.statusCode).toBe(200);
        expect(again.headers['x-photo-cache']).toBeUndefined();
        await app.close();
    });
    it('재확인에서 개수·대표·순서가 그대로여도 사진 내용(바이트)이 교체됐으면 옛 사진을 내보내지 않고 새 내용으로 다시 처리한다', async () => {
        const { app, advance, setBytes, calls } = await build();
        const first = await app.inject({ url: url('/0?size=list'), headers });
        advance(11 * 60 * 1000);
        setBytes(await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#aa3322' } }).jpeg().toBuffer()); // 같은 앨범 구성, 내용만 교체
        const before = calls().sourceCalls;
        const swapped = await app.inject({ url: url('/0?size=list'), headers });
        expect(swapped.statusCode).toBe(200);
        expect(swapped.headers['x-photo-cache']).toBeUndefined(); // 캐시 적중 아님
        expect(swapped.rawPayload.equals(first.rawPayload)).toBe(false); // 옛 사진(A)이 아니라 새 사진(B)
        expect(calls().sourceCalls).toBe(before + 1); // 원천은 한 번만 읽는다(재확인 읽기를 재사용)
        const next = await app.inject({ url: url('/0?size=list'), headers }); // 이후는 새 내용의 캐시 적중
        expect(next.headers['x-photo-cache']).toBe('HIT');
        expect(next.rawPayload.equals(swapped.rawPayload)).toBe(true);
        await app.close();
    });
    it('재확인 중 원천이 일시 오류(503 등)면 캐시 사진을 내보내지 않고 503', async () => {
        const { app, advance, setSourceError } = await build();
        await app.inject({ url: url('/0?size=list'), headers });
        advance(11 * 60 * 1000);
        setSourceError(new Error('IANCAR_ONE_API_HTTP_503'));
        const res = await app.inject({ url: url('/0?size=list'), headers });
        expect(res.statusCode).toBe(503);
        expect(res.headers['x-photo-cache']).toBeUndefined();
        await app.close();
    });
    it('다른 크기 요청의 최종 재확인이 실패(원천 철회)하면 같은 상품의 기존 캐시도 버린다', async () => {
        const { app, failNextMetadata } = await build();
        await app.inject({ url: url('/0?size=list'), headers }); // list 캐시 생성
        failNextMetadata(); // 다음 원천 앨범 확인(= detail 요청의 최종 재확인)이 «차량 소멸»
        const detail = await app.inject({ url: url('/0?size=detail'), headers });
        expect(detail.statusCode).toBe(404);
        const list = await app.inject({ url: url('/0?size=list'), headers }); // 10분 이내여도 이전 list 캐시를 내보내지 않는다
        expect(list.headers['x-photo-cache']).toBeUndefined();
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
