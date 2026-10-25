import { describe, expect, it, vi } from 'vitest';
import { createConsumerGateway } from '../src/api/consumer-gateway.js';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { createVehiclePhotoReader, VEHICLE_PHOTO_MAX_CONCURRENT } from '../src/domain/consumer-output-contract.js';
import { parseIancarPhotoIdGateSuppliers } from '../src/infra/erp5-compat-catalog-reader.js';
// ID 게이트를 «켠 상태»로 실제 HTTP 경로(인증·색인 검증·감사·헤더·오류 본문)까지 확인한다. 원천은 가짜지만 비밀 문자열을 심어 누출 여부를 본다.
const token = 'test-media-token-0123456789abcdefghij';
const binding = { id: 'erp5-public-media', projectionId: 'erp-public', token, capabilities: ['photos'] };
const headers = { authorization: `Bearer ${token}` };
const SECRET = 'SECRET-PROVIDER-KEY-xyz';
const IDS = ['photo-id-AAA', 'photo-id-BBB', 'photo-id-CCC'];
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9])]);
const product = { provider_company_code: 'RP031', listable: true, status_kind: '가용', iancar_one_vehicle_id: 'EANCAR-vehicle-q', car_number: '12가3456', iancar_one_photo_ids: IDS };
const build = (mode = 'ok', gate = true, consumer = binding) => {
    let reads = 0, inflight = 0, maxInflight = 0;
    let current = { ...product };
    const logs = new MemoryDataAccessLogStore();
    const source = {
        eligible: () => true, connection: () => 'c',
        read: async (_p, index, fresh) => {
            expect(fresh).toBe(true);
            if (index !== undefined)
                reads++;
            inflight++;
            maxInflight = Math.max(maxInflight, inflight);
            try {
                if (mode === 'leaky')
                    throw new Error(`https://eancarone.com/v1/vehicles/EANCAR-vehicle-q/photos/photo-id-AAA Bearer ${SECRET}`);
                if (mode === 'slow')
                    await new Promise(resolve => setTimeout(resolve, 30));
                // Producer preserves upstream order separately from representative-first serving order.
                return { count: IDS.length, photoIds: IDS, upstreamPhotoIds: [IDS[1], IDS[0], IDS[2]],
                    upstreamRepresentatives: [false, true, false], servingSourceOrdinals: [1, 0, 2],
                    bytes: index === undefined ? null : jpeg, contentType: index === undefined ? 'application/json' : 'image/jpeg' };
            }
            finally {
                inflight--;
            }
        },
    };
    const readVehiclePhoto = createVehiclePhotoReader(async () => ({ ...current }), source, undefined, Date.now, undefined, parseIancarPhotoIdGateSuppliers(gate ? ' RP031 ' : undefined));
    const app = createConsumerGateway(new MemoryDataStore(), [consumer], new DataAccessGateway(logs), undefined, { read: async () => { throw new Error('unused'); }, readVehiclePhoto });
    return { app, logs, withdraw: () => { current = { ...current, publication_withdrawal: { reason: 'test' } }; }, stats: () => ({ reads, maxInflight }) };
};
const url = (path = '') => `/v1/consumers/erp5-public-media/catalog-compat/products/iancar_abc/photos${path}`;
describe('ID 게이트 켠 상태의 실제 HTTP 요청', () => {
    it('기존 erp-com 소비자는 등록 ID 경로로 확장되지 않는다', async () => {
        const { app, stats } = build('ok', true, { ...binding, id: 'erp-com', capabilities: ['catalog'] });
        const res = await app.inject({ url: url('/0').replace('erp5-public-media', 'erp-com'), headers });
        expect(res.statusCode).toBe(404);
        expect(stats().reads).toBe(0);
        await app.close();
    });
    it.each(['', '/0'])('성공 감사 중 철회되면 사진을 보내지 않는다: %s', async (suffix) => {
        const { app, logs, withdraw } = build();
        const append = logs.appendDataAccessEvent.bind(logs);
        vi.spyOn(logs, 'appendDataAccessEvent').mockImplementation(async (event) => {
            await append(event);
            if (event.phase === 'SUCCEEDED')
                withdraw();
        });
        const res = await app.inject({ url: url(suffix), headers });
        expect(res.statusCode).toBe(404);
        expect(res.rawPayload).not.toEqual(jpeg);
        await app.close();
    });
    it.each(['', '/0'])('성공 감사 저장이 실패하면 응답을 차단한다: %s', async (suffix) => {
        const { app, logs } = build();
        const append = logs.appendDataAccessEvent.bind(logs);
        vi.spyOn(logs, 'appendDataAccessEvent').mockImplementation(async (event) => {
            if (event.phase === 'SUCCEEDED')
                throw Error('test audit failure');
            await append(event);
        });
        const res = await app.inject({ url: url(suffix), headers });
        expect(res.statusCode).toBe(503);
        expect(res.rawPayload).not.toEqual(jpeg);
        expect(logs.events.some(event => event.phase === 'SUCCEEDED')).toBe(false);
        await app.close();
    });
    it('인증 없이는 401, 켜진 상태에서 manifest·이미지는 200이며 헤더가 고정된다', async () => {
        const { app } = build();
        expect((await app.inject({ url: url() })).statusCode).toBe(401);
        const manifest = await app.inject({ url: url(), headers });
        expect(manifest.statusCode).toBe(200);
        expect(manifest.json()).toEqual({ schema: 'freepass-data.product-photos/v1', productId: 'iancar_abc', count: 3 });
        const image = await app.inject({ url: url('/1'), headers });
        expect(image.statusCode).toBe(200);
        expect(image.headers['content-type']).toBe('image/jpeg');
        expect(image.headers['x-content-type-options']).toBe('nosniff');
        expect(image.headers['cache-control']).toBe('private, no-store');
        expect(image.rawPayload).toEqual(jpeg);
        for (const text of [JSON.stringify(manifest.json()), JSON.stringify(image.headers)])
            for (const leak of IDS.concat([SECRET, 'eancarone.com', 'EANCAR-vehicle-q']))
                expect(text).not.toContain(leak);
        await app.close();
    });
    it('색인이 음수·소수·NaN·지수·선행 0·200 이상이면 400, 범위 밖(3)은 404', async () => {
        const { app, stats } = build();
        for (const bad of ['-1', '1.5', 'NaN', '1e1', '01', '200', '999', 'abc'])
            expect((await app.inject({ url: url('/' + bad), headers })).statusCode).toBe(400);
        expect(stats().reads).toBe(0);
        expect((await app.inject({ url: url('/3'), headers })).statusCode).toBe(404);
        await app.close();
    });
    it('원천 오류 본문·로그에 열쇠·ID·원본 주소가 나가지 않는다', async () => {
        const logs = new MemoryDataAccessLogStore();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => { });
        const { app } = build('leaky');
        const res = await app.inject({ url: url('/0'), headers });
        expect(res.statusCode).toBe(503);
        const body = res.body + JSON.stringify(res.headers);
        for (const leak of IDS.concat([SECRET, 'eancarone.com', 'EANCAR-vehicle-q', 'Bearer']))
            expect(body).not.toContain(leak);
        expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
        spy.mockRestore();
        void logs;
        await app.close();
    });
    it('요청 폭주에도 원천 동시 호출은 한도(8) 이하이고 초과분은 429 로 거절된다', async () => {
        const { app, stats } = build('slow');
        const results = await Promise.all(Array.from({ length: 40 }, (_, i) => app.inject({ url: url('/' + (i % 3)), headers })));
        const codes = results.map(r => r.statusCode);
        expect(stats().maxInflight).toBeLessThanOrEqual(VEHICLE_PHOTO_MAX_CONCURRENT);
        expect(codes.every(code => [200, 429].includes(code))).toBe(true);
        expect(codes.filter(code => code === 200).length).toBeGreaterThan(0);
        expect(stats().reads).toBe(codes.filter(code => code === 200).length);
        await app.close();
    });
    it('끄면(기본) 같은 상품이 404 로 되돌아간다', async () => {
        const { app, stats } = build('ok', false);
        expect((await app.inject({ url: url('/0'), headers })).statusCode).toBe(404);
        expect(stats().reads).toBe(0);
        await app.close();
    });
});
