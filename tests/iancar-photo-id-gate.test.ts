import { describe, expect, it, vi } from 'vitest';
import { createVehiclePhotoReader, type VehiclePhotoSource } from '../src/domain/consumer-output-contract.js';

// 최소 JPEG(매직 바이트 + 충분한 길이). 미디어 검사는 raster 매직과 크기를 본다.
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1), Buffer.from([0xff, 0xd9])]);
const ids = ['id-a', 'id-b', 'id-c'];
const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider_company_code: 'RP031', listable: true, status_kind: '가용', iancar_one_vehicle_id: 'EANCAR-x', car_number: '12가3456',
  iancar_one_photo_ids: ids, ...over,
});
const source = (served: string[] = ids, contentType = 'image/jpeg'): VehiclePhotoSource & { read: ReturnType<typeof vi.fn> } => ({
  eligible: () => true, connection: () => 'c',
  read: vi.fn(async (_p, index?: number) => ({ count: served.length, photoIds: served, bytes: index === undefined ? null : jpeg, contentType: index === undefined ? 'application/json' : contentType })),
});

describe('이안카 사진 ID 기반 서빙 게이트', () => {
  it('기본값(꺼짐)에서는 검수 refs 없는 상품을 서빙하지 않는다', async () => {
    const src = source();
    const read = createVehiclePhotoReader(async () => base(), src);
    await expect(read('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
    expect(src.read).not.toHaveBeenCalled();
  });
  it('켜진 공급사는 등록 ID 집합이 원천과 같으면 서빙하고 내부 필드는 싣지 않는다', async () => {
    const read = createVehiclePhotoReader(async () => base(), source(), undefined, Date.now, undefined, new Set(['RP031']));
    const manifest = await read('erp5-public-media', 'p1');
    expect(manifest.count).toBe(3);
    expect(Object.keys(manifest).sort()).toEqual(['bytes', 'contentType', 'count', 'revalidate']);
    const image = await read('erp5-public-media', 'p1', 1);
    expect(image.bytes).toEqual(jpeg);
    expect(image.contentType).toBe('image/jpeg');
    expect(await image.revalidate()).toBe(true);
  });
  it('원천 앨범이 등록 집합과 다르면(추가·누락·중복) 서빙하지 않는다', async () => {
    for (const served of [['id-a', 'id-b'], ['id-a', 'id-b', 'id-c', 'id-z'], ['id-a', 'id-b', 'id-z'], ['id-a', 'id-a', 'id-b']]) {
      const read = createVehiclePhotoReader(async () => base(), source(served), undefined, Date.now, undefined, new Set(['RP031']));
      await expect(read('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
    }
  });
  it('비공개·철회·다른 공급사·ID 미등록 상품은 게이트 대상이 아니다', async () => {
    for (const over of [{ listable: false }, { publication_withdrawal: { reason: 'x' } }, { provider_company_code: 'RP012' }, { iancar_one_photo_ids: [] }, { iancar_one_photo_ids: ['a', 'a'] }, { _deleted: true }]) {
      const src = source();
      const read = createVehiclePhotoReader(async () => base(over), src, undefined, Date.now, undefined, new Set(['RP031', 'RP012']));
      await expect(read('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
      expect(src.read).not.toHaveBeenCalled();
    }
  });
  it('이미지가 아닌 응답은 거부하고, 서빙 뒤 상품이 바뀌면 revalidate 가 거짓이다', async () => {
    const bad = createVehiclePhotoReader(async () => base(), source(ids, 'text/html'), undefined, Date.now, undefined, new Set(['RP031']));
    await expect(bad('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
    let current = base();
    const read = createVehiclePhotoReader(async () => current, source(), undefined, Date.now, undefined, new Set(['RP031']));
    const image = await read('erp5-public-media', 'p1', 0);
    current = base({ listable: false });
    expect(await image.revalidate()).toBe(false);
  });
  it('범위 밖 인덱스는 찾을 수 없다', async () => {
    const read = createVehiclePhotoReader(async () => base(), source(), undefined, Date.now, undefined, new Set(['RP031']));
    await expect(read('erp5-public-media', 'p1', 3)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
  });
});
