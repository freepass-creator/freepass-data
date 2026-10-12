import { describe, expect, it, vi } from 'vitest';
import { createConsumerGateway, type ConsumerBinding } from '../src/api/consumer-gateway.js';
import { DataAccessGateway } from '../src/application/data-access-gateway.js';
import { MemoryDataAccessLogStore } from '../src/infra/memory-data-access-log.js';
import { MemoryDataStore } from '../src/infra/memory-store.js';
import { createVehiclePhotoReader, type VehiclePhotoSource, VEHICLE_PHOTO_MAX_CONCURRENT } from '../src/domain/consumer-output-contract.js';

// ID 게이트를 «켠 상태»로 실제 HTTP 경로(인증·색인 검증·감사·헤더·오류 본문)까지 확인한다. 원천은 가짜지만 비밀 문자열을 심어 누출 여부를 본다.
const token = 'test-media-token-0123456789abcdefghij';
const binding: ConsumerBinding = { id: 'erp5-public-media', projectionId: 'erp-public', token, capabilities: ['photos'] };
const headers = { authorization: `Bearer ${token}` };
const SECRET = 'SECRET-PROVIDER-KEY-xyz';
const IDS = ['photo-id-AAA', 'photo-id-BBB', 'photo-id-CCC'];
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9])]);
const product = { provider_company_code: 'RP031', listable: true, status_kind: '가용', iancar_one_vehicle_id: 'EANCAR-vehicle-q', car_number: '12가3456', iancar_one_photo_ids: IDS };

const build = (mode: 'ok' | 'leaky' | 'slow' = 'ok', gate = true) => {
  let reads = 0, inflight = 0, maxInflight = 0;
  const source: VehiclePhotoSource = {
    eligible: () => true, connection: () => 'c',
    read: async (_p, index) => {
      reads++; inflight++; maxInflight = Math.max(maxInflight, inflight);
      try {
        if (mode === 'leaky') throw new Error(`https://eancarone.com/v1/vehicles/EANCAR-vehicle-q/photos/photo-id-AAA Bearer ${SECRET}`);
        if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 30));
        return { count: IDS.length, photoIds: IDS, bytes: index === undefined ? null : jpeg, contentType: index === undefined ? 'application/json' : 'image/jpeg' };
      } finally { inflight--; }
    },
  };
  const readVehiclePhoto = createVehiclePhotoReader(async () => ({ ...product }), source, undefined, Date.now, undefined, gate ? new Set(['RP031']) : new Set());
  const app = createConsumerGateway(new MemoryDataStore(), [binding], new DataAccessGateway(new MemoryDataAccessLogStore()), undefined,
    { read: async () => { throw new Error('unused'); }, readVehiclePhoto } as never);
  return { app, stats: () => ({ reads, maxInflight }) };
};
const url = (path = '') => `/v1/consumers/erp5-public-media/catalog-compat/products/iancar_abc/photos${path}`;

describe('ID 게이트 켠 상태의 실제 HTTP 요청', () => {
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
    for (const text of [JSON.stringify(manifest.json()), JSON.stringify(image.headers)]) for (const leak of IDS.concat([SECRET, 'eancarone.com', 'EANCAR-vehicle-q'])) expect(text).not.toContain(leak);
    await app.close();
  });
  it('색인이 음수·소수·NaN·지수·선행 0·200 이상이면 400, 범위 밖(3)은 404', async () => {
    const { app, stats } = build();
    for (const bad of ['-1', '1.5', 'NaN', '1e1', '01', '200', '999', 'abc']) expect((await app.inject({ url: url('/' + bad), headers })).statusCode).toBe(400);
    expect(stats().reads).toBe(0);
    expect((await app.inject({ url: url('/3'), headers })).statusCode).toBe(404);
    await app.close();
  });
  it('원천 오류 본문·로그에 열쇠·ID·원본 주소가 나가지 않는다', async () => {
    const logs = new MemoryDataAccessLogStore();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = build('leaky');
    const res = await app.inject({ url: url('/0'), headers });
    expect(res.statusCode).toBe(503);
    const body = res.body + JSON.stringify(res.headers);
    for (const leak of IDS.concat([SECRET, 'eancarone.com', 'EANCAR-vehicle-q', 'Bearer'])) expect(body).not.toContain(leak);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET);
    spy.mockRestore(); void logs; await app.close();
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
