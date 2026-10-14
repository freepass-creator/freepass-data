import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { approvedIancarPhotoCount, createVehiclePhotoReader, isIancarCopyPhotoProduct, vehiclePhotoKey, type VehiclePhotoSource } from '../src/domain/consumer-output-contract.js';

// 이안카(RP031) 사본 우선 서빙(대표 2026-10-14·15): 승인된 압축 사본이 있으면 ONE 이 아니라 드라이브 사본(sha256 검증)으로만 서빙하고,
// 사본이 없으면(라이브 폴백 off) 사진 없음(404)이며 어느 경우에도 화면 요청이 ONE 원천을 부르지 않는다.
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9])]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const baseProduct = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider_company_code: 'RP031', listable: true, status_kind: '가용', car_number: '12가3456', supplier_vehicle_id: 'V-1', ...over });   // iancar_one_vehicle_id 없음(엔진 문서)
const refFor = (product: Record<string, unknown>, bytes: Buffer, over: Record<string, unknown> = {}) => ({
  driveFileId: 'drive_file_1', sha256: sha(bytes), mediaType: 'image/jpeg', role: 'VEHICLE_PHOTO', zone: '차량사진',
  approvedAt: '2026-10-15T00:00:00.000Z', vehicleKey: vehiclePhotoKey(product)!,
  vehiclePhotoVerifiedBy: 'tester', vehiclePhotoVerificationMethod: 'IANCAR_COMPRESSED_COPY', vehiclePhotoVerifiedAt: '2026-10-15T00:00:00.000Z', ...over });
const withCopy = (over: Record<string, unknown> = {}, refOver: Record<string, unknown> = {}, bytes = jpeg) => {
  const p = baseProduct(over);
  return { ...p, photo_original_refs: [refFor(p, bytes, refOver), refFor(p, bytes, { driveFileId: 'drive_file_2', ...refOver })] };
};
const oneSource = (): VehiclePhotoSource & { read: ReturnType<typeof vi.fn> } => ({
  eligible: () => true, connection: p => JSON.stringify([p.provider_company_code, p.car_number]),
  read: vi.fn(async () => { throw new Error('ONE must not be called'); }),
});

describe('이안카 사본 우선 서빙', () => {
  it('사본 refs 가 있으면 ONE 차량 ID 가 없어도(엔진 문서) 드라이브 사본으로 서빙하고 ONE 호출은 0회다', async () => {
    const product = withCopy();
    const one = oneSource();
    const copyReader = vi.fn(async () => ({ bytes: jpeg, contentType: 'image/jpeg' }));
    const read = createVehiclePhotoReader(async () => product, one, copyReader);
    for (const consumer of ['erp5-public-media', 'erp-com']) {
      const image = await read(consumer, 'p1', 1);
      expect(image.bytes).toEqual(jpeg);
      expect(image.count).toBe(2);
      expect(await image.revalidate()).toBe(true);
      const manifest = await read(consumer, 'p1');
      expect(manifest.count).toBe(2);
    }
    expect(copyReader).toHaveBeenCalled();
    expect(one.read).not.toHaveBeenCalled();
  });

  it('사본 바이트가 등록 sha256 과 다르면 거절하고(ONE 폴백 없음) 드라이브 404 도 사진 없음이다', async () => {
    const product = withCopy();
    const one = oneSource();
    const bad = createVehiclePhotoReader(async () => product, one, async () => ({ bytes: Buffer.concat([jpeg, Buffer.from([1])]), contentType: 'image/jpeg' }));
    await expect(bad('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
    const gone = createVehiclePhotoReader(async () => product, one, async () => { throw new Error('VEHICLE_PHOTO_NOT_FOUND'); });
    await expect(gone('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
    expect(one.read).not.toHaveBeenCalled();
  });

  it('사본 읽기 서비스가 꺼져 있어도 ONE 으로 폴백하지 않고 503 계열(READER_UNAVAILABLE)이다', async () => {
    const one = oneSource();
    const read = createVehiclePhotoReader(async () => withCopy(), one);
    await expect(read('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_READER_UNAVAILABLE');
    expect(one.read).not.toHaveBeenCalled();
  });

  it('사본이 없는 이안카 상품: 라이브 폴백 off 면 사진 없음(404), ONE 호출 0회 — 켜 두면(기본) 종전 ONE 경로', async () => {
    const product = baseProduct({ iancar_one_vehicle_id: 'ONE-1' });
    const one = oneSource();
    const off = createVehiclePhotoReader(async () => product, one, undefined, Date.now, undefined, new Set(), false);
    await expect(off('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
    expect(one.read).not.toHaveBeenCalled();
    const on = createVehiclePhotoReader(async () => product, one);
    await expect(on('erp5-public-media', 'p1', 0)).rejects.toThrow();   // 종전 경로(심사된 refs 가 없어 거절)이되 판정은 도메인이 한다
  });

  it('비적격 상품(비공개·철회·상태 불가)은 사본이 있어도 서빙하지 않는다, 처리 중 변경은 revalidate 가 거부한다', async () => {
    const one = oneSource();
    const copyReader = vi.fn(async () => ({ bytes: jpeg, contentType: 'image/jpeg' }));
    for (const over of [{ listable: false }, { status_kind: '불가' }, { publication_withdrawal: { at: 'x' } }, { _deleted: true }]) {
      const read = createVehiclePhotoReader(async () => withCopy(over), one, copyReader);
      await expect(read('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
    }
    let current: Record<string, unknown> = withCopy();
    const read = createVehiclePhotoReader(async () => current, one, copyReader, Date.now, undefined, new Set(), false);
    const image = await read('erp5-public-media', 'p1', 0);
    current = { ...current, listable: false };
    expect(await image.revalidate()).toBe(false);
    expect(one.read).not.toHaveBeenCalled();
  });

  it('다른 공급사·옛 ONE 결속 refs·다른 방식 refs 는 사본 경로(copyFirst)가 아니다 — 다른 공급사 동작 불변', async () => {
    const other = { ...withCopy(), provider_company_code: 'RP005' };
    expect(isIancarCopyPhotoProduct(other)).toBe(false);
    const legacy = withCopy({}, { sourceKind: 'IANCAR_ONE' });
    expect(isIancarCopyPhotoProduct(legacy)).toBe(false);
    const otherMethod = withCopy({}, { vehiclePhotoVerificationMethod: 'AUTO_KAKAO_COLLECT' });
    expect(isIancarCopyPhotoProduct(otherMethod)).toBe(false);
    expect(isIancarCopyPhotoProduct(withCopy())).toBe(true);
    // 다른 공급사의 승인 사진은 종전처럼 approvedSource 로 서빙된다(라이브 폴백 off 가 영향 없음)
    const copyReader = vi.fn(async () => ({ bytes: jpeg, contentType: 'image/jpeg' }));
    const p5 = { ...baseProduct({ provider_company_code: 'RP005' }) };
    const p5full = { ...p5, photo_original_refs: [refFor(p5, jpeg, { vehiclePhotoVerificationMethod: 'AUTO_KAKAO_COLLECT' })] };
    const read = createVehiclePhotoReader(async () => p5full, undefined, copyReader, Date.now, undefined, new Set(), false);
    expect((await read('erp-com', 'p5', 0)).bytes).toEqual(jpeg);
  });

  it('photo_approved_count: 사본 서빙이 보장될 때만 refs 수, 아니면 0', () => {
    expect(approvedIancarPhotoCount(withCopy())).toBe(2);
    expect(approvedIancarPhotoCount(baseProduct())).toBe(0);
    expect(approvedIancarPhotoCount(withCopy({ listable: false }))).toBe(0);
    expect(approvedIancarPhotoCount(withCopy({}, { sourceKind: 'IANCAR_ONE' }))).toBe(0);
    expect(approvedIancarPhotoCount({ ...withCopy(), provider_company_code: 'RP005' })).toBe(0);
    expect(approvedIancarPhotoCount(undefined)).toBe(0);
  });
});
