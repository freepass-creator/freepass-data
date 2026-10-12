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
  eligible: () => true, connection: p => JSON.stringify([p.provider_company_code, p.iancar_one_vehicle_id, p.car_number]),
  read: vi.fn(async (_p, index?: number, _fresh?: boolean, _expectedRegisteredPhotoCount?: number) => ({ count: served.length, photoIds: served, upstreamPhotoIds: [...served],
    upstreamRepresentatives: served.map((_, i) => i === 0), servingSourceOrdinals: served.map((_, i) => i),
    bytes: index === undefined ? null : jpeg, contentType: index === undefined ? 'application/json' : contentType })),
});

it('최종 상품의 ONE 연결 변경을 같은 등록 ID로 숨길 수 없다', async () => {
  let current = base(); const src = source();
  const read = createVehiclePhotoReader(async () => current, src, undefined, Date.now, undefined, new Set(['RP031']));
  const image = await read('erp5-public-media', 'p1', 0);
  current = base({ iancar_one_vehicle_id: 'changed', car_number: 'changed' });
  expect(await image.revalidate()).toBe(false);
});
it('현재 원천의 정상 대표 순서는 과거 등록 순서에 묶이지 않는다', async () => {
  const read = createVehiclePhotoReader(async () => base(), source([...ids].reverse()), undefined, Date.now, undefined, new Set(['RP031']));
  expect((await read('erp5-public-media', 'p1', 0)).bytes).toEqual(jpeg);
});
it('감사 이후 원천 개수 변경을 새 메타데이터로 거부한다', async () => {
  const src = source(); const read = createVehiclePhotoReader(async () => base(), src, undefined, Date.now, undefined, new Set(['RP031']));
  const image = await read('erp5-public-media', 'p1', 0);
  src.read.mockResolvedValueOnce({ count: 2, photoIds: ['id-a', 'id-b'], bytes: null, contentType: 'application/json' });
  expect(await image.revalidate()).toBe(false);
});
it.each([null, [], {}, [{ vehiclePhotoVerifiedBy: '' }], undefined])('존재하는 잘못된 refs는 ID 경로로 우회하지 않는다: %s', async refs => {
  const src = source(); const read = createVehiclePhotoReader(async () => base({ photo_original_refs: refs }), src, undefined, Date.now, undefined, new Set(['RP031']));
  await expect(read('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND'); expect(src.read).not.toHaveBeenCalled();
});
it.each(['erp-com', 'whitelabel-test'])('새 ID 경로는 전용 소비처 밖으로 확장하지 않는다: %s', async consumer => {
  const src = source(); const read = createVehiclePhotoReader(async () => base(), src, undefined, Date.now, undefined, new Set(['RP031']));
  await expect(read(consumer, 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND'); expect(src.read).not.toHaveBeenCalled();
});

it('대표가 원천 뒤에 있어도 정본의 대표 우선 등록 순서를 보존한다', async () => {
  const src = source();
  src.read.mockImplementation(async (_p, index?: number) => ({ count: 3, photoIds: ids,
    upstreamPhotoIds: ['id-b', 'id-a', 'id-c'], upstreamRepresentatives: [false, true, false], servingSourceOrdinals: [1, 0, 2],
    bytes: index === undefined ? null : jpeg, contentType: index === undefined ? 'application/json' : 'image/jpeg' }));
  const db = vi.fn(async () => base()); const read = createVehiclePhotoReader(db, src, undefined, Date.now, undefined, new Set(['RP031']));
  const image = await read('erp5-public-media', 'p1', 0); expect(await image.revalidate()).toBe(true);
  expect(src.read.mock.calls.map(c => [c[1], c[2]])).toEqual([[0, true], [undefined, true]]);
  expect(src.read.mock.calls[0]![3]).toBe(ids.length);
  expect(src.read.mock.calls[1]![3]).toBe(src.read.mock.calls[0]![3]);
  expect(db).toHaveBeenCalledTimes(3);
});

it.each(['upstream-order', 'representative', 'ordinal'])('새 원천 구성은 자체 매핑이 유효하면 허용하고 잘못된 ordinal은 거부한다: %s', async kind => {
  const src = source(); const read = createVehiclePhotoReader(async () => base(), src, undefined, Date.now, undefined, new Set(['RP031']));
  const image = await read('erp5-public-media', 'p1', 0);
  src.read.mockResolvedValueOnce({ count: 3, photoIds: ids,
    upstreamPhotoIds: kind === 'upstream-order' ? ['id-b', 'id-a', 'id-c'] : ids,
    upstreamRepresentatives: kind === 'representative' ? [false, false, false] : kind === 'upstream-order' ? [false, true, false] : [true, false, false],
    servingSourceOrdinals: kind === 'upstream-order' ? [1, 0, 2] : kind === 'ordinal' ? [0, 2, 1] : [0, 1, 2],
    bytes: null, contentType: 'application/json' });
  expect(await image.revalidate()).toBe(kind !== 'ordinal');
});

it('최종 원천 실패와 refs 신규 존재는 승인 없는 성공으로 바꾸지 않는다', async () => {
  let current = base(); const src = source(); const read = createVehiclePhotoReader(async () => current, src, undefined, Date.now, undefined, new Set(['RP031']));
  const image = await read('erp5-public-media', 'p1', 0);
  src.read.mockRejectedValueOnce(new Error('synthetic source failure')); expect(await image.revalidate()).toBe(false);
  current = base({ photo_original_refs: [] }); expect(await image.revalidate()).toBe(false);
  expect(src.read).toHaveBeenCalledTimes(2);
});

it('최종 원천의 handle 재발급은 같은 차량·개수와 유효한 현재 매핑이면 허용한다', async () => {
  let current = base(); const src = source();
  const read = createVehiclePhotoReader(async () => current, src, undefined, Date.now, undefined, new Set(['RP031']));
  const image = await read('erp5-public-media', 'p1', 0);
  current = base({ iancar_one_photo_ids: ['new-registration-a', 'new-registration-b', 'new-registration-c'] });
  src.read.mockResolvedValueOnce({ count: 3, photoIds: ['new-b', 'new-a', 'new-c'],
    upstreamPhotoIds: ['new-a', 'new-b', 'new-c'], upstreamRepresentatives: [false, true, false], servingSourceOrdinals: [1, 0, 2],
    bytes: null, contentType: 'application/json' });
  expect(await image.revalidate()).toBe(true);
  expect(src.read.mock.calls[1]![3]).toBe(3);
});

it('최종 등록 개수 또는 형상 변경은 현재 handle이 유효해도 거부한다', async () => {
  for (const registered of [['replacement'], ['bad ', 'b', 'c']]) {
    let current = base(); const src = source();
    const read = createVehiclePhotoReader(async () => current, src, undefined, Date.now, undefined, new Set(['RP031']));
    const image = await read('erp5-public-media', 'p1', 0); current = base({ iancar_one_photo_ids: registered });
    expect(await image.revalidate()).toBe(false); expect(src.read).toHaveBeenCalledTimes(1);
  }
});

it('새 ID 경로는 원본 캐시를 추가하지 않고 바이트를 복사해 반환한다', async () => {
  const src = source(); const read = createVehiclePhotoReader(async () => base(), src, undefined, Date.now, undefined, new Set(['RP031']));
  const first = await read('erp5-public-media', 'p1', 0); expect(await first.revalidate()).toBe(true);
  const second = await read('erp5-public-media', 'p1', 0); expect(await second.revalidate()).toBe(true);
  first.bytes![3] = 99; expect(second.bytes).toEqual(jpeg);
  expect(src.read.mock.calls.map(c => [c[1], c[2]])).toEqual([[0, true], [undefined, true], [0, true], [undefined, true]]);
});

it('기존 유효 refs가 있으면 새 ID 경로 대신 기존 승인 경로를 유지한다', async () => {
  const src = source(); const read = createVehiclePhotoReader(async () => base({ photo_original_refs: [{
    vehiclePhotoVerifiedBy: 'synthetic-reviewer', vehiclePhotoVerificationMethod: 'synthetic review', vehiclePhotoVerifiedAt: '2026-10-11T00:00:00.000Z',
  }] }), src, undefined, Date.now, undefined, new Set(['RP031']));
  expect((await read('erp5-public-media', 'p1', 0)).bytes).toEqual(jpeg);
  expect(src.read.mock.calls[0]![2]).toBe(false);
  expect(src.read.mock.calls[0]![3]).toBeUndefined();
});

it('동시 ID 원본 작업은 여덟 개 한도를 유지하고 완료 후 회복한다', async () => {
  const src = source(); let release!: () => void; const gate = new Promise<void>(r => { release = r; });
  const original = src.read.getMockImplementation()!;
  src.read.mockImplementation(async (...args) => { await gate; return original(...args); });
  const read = createVehiclePhotoReader(async () => base(), src, undefined, Date.now, undefined, new Set(['RP031']));
  const calls = Array.from({ length: 8 }, (_, i) => read('erp5-public-media', `p${i}`, 0));
  await vi.waitFor(() => expect(src.read).toHaveBeenCalledTimes(8));
  await expect(read('erp5-public-media', 'ninth', 0)).rejects.toThrow('VEHICLE_PHOTO_BUSY');
  release(); await Promise.all(calls); expect((await read('erp5-public-media', 'recovered', 0)).bytes).toEqual(jpeg);
});

it.each([[' id-a'], ['id-a '], [''], ['x'.repeat(2049)], [1], ['id-a', 'id-a']].map(registered => ({ registered })))
  ('비정규 등록 ID는 원천 호출 전에 거부한다', async ({ registered }) => {
    const src = source(); const read = createVehiclePhotoReader(async () => base({ iancar_one_photo_ids: registered }), src,
      undefined, Date.now, undefined, new Set(['RP031']));
    await expect(read('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
    expect(src.read).not.toHaveBeenCalled();
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
    // 내부 결과 객체에는 캐시 표지(cacheTag, 연결 해시)가 있으나 HTTP 응답에는 실리지 않는다(photo-rendition-cache 시험·ID 게이트 HTTP 시험이 확인)
    expect(Object.keys(manifest).sort()).toEqual(['bytes', 'cacheTag', 'contentType', 'count', 'revalidate', 'sourceCheckedAt']);
    const image = await read('erp5-public-media', 'p1', 1);
    expect(image.bytes).toEqual(jpeg);
    expect(image.contentType).toBe('image/jpeg');
    expect(await image.revalidate()).toBe(true);
  });
  it('원천 앨범 개수가 등록 개수와 다르거나 현재 ID 에 중복이 있으면 서빙하지 않는다', async () => {
    for (const served of [['id-a', 'id-b'], ['id-a', 'id-b', 'id-c', 'id-z'], ['id-a', 'id-a', 'id-b']]) {
      const read = createVehiclePhotoReader(async () => base(), source(served), undefined, Date.now, undefined, new Set(['RP031']));
      await expect(read('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
    }
  });
  it('ONE 이 사진 ID 를 재발급해도(등록 ID 와 현재 ID 겹침 0) 개수가 같으면 현재 앨범을 순번으로 서빙한다', async () => {
    const src = source(['new-x', 'new-y', 'new-z']);
    const read = createVehiclePhotoReader(async () => base(), src, undefined, Date.now, undefined, new Set(['RP031']));
    expect((await read('erp5-public-media', 'p1')).count).toBe(3);
    expect((await read('erp5-public-media', 'p1', 2)).bytes).toEqual(jpeg);
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

describe('이안카 사진 ID 게이트 — 원천 신원 불일치·stale·차량 소멸', () => {
  const gateOn = (error: Error) => createVehiclePhotoReader(async () => base(), {
    eligible: () => true, connection: () => 'c', read: vi.fn(async () => { throw error; }),
  }, undefined, Date.now, undefined, new Set(['RP031']));
  it.each(['IANCAR_PHOTO_IDENTITY_MISMATCH', 'IANCAR_PHOTO_DETAIL_STALE'])('원천이 %s 로 거부하면 사진을 서빙하지 않고 503 계열 오류(응답에 원인 문구 없음)', async code => {
    await expect(gateOn(new Error(code))('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
    await expect(gateOn(new Error(code))('erp5-public-media', 'p1')).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
  });
  it('원천에서 차량이 사라진 경우(ONE 상세 404)는 일시 오류가 아니라 «사진 없음» 404 로 답한다', async () => {
    await expect(gateOn(new Error('IANCAR_ONE_API_HTTP_404'))('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
  });
  it('그 밖의 원천 오류(503·타임아웃)는 계속 일시 오류(UNAVAILABLE)', async () => {
    for (const code of ['IANCAR_ONE_API_HTTP_503', 'IANCAR_ONE_API_HTTP_500', 'TimeoutError']) await expect(gateOn(new Error(code))('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
  });
});
