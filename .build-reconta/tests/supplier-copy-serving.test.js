import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { approvedPhotoCount, createVehiclePhotoReader, isSupplierCopyPhotoProduct, parsePhotoCopySuppliers, vehiclePhotoKey } from '../src/domain/consumer-output-contract.js';
// 공급사 공통 사본 서빙(설계 승인 2026-10-15): 허용표 안의 공급사만 사본 우선·photo_approved_count, 표 밖 공급사는 종전 동작 그대로.
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 9), Buffer.from([0xff, 0xd9])]);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const product = (supplier, over = {}) => ({
    provider_company_code: supplier, listable: true, status_kind: '가용', car_number: '12가3456', supplier_vehicle_id: 'V-1', ...over
});
const withRefs = (supplier, method, refOver = {}, over = {}) => {
    const p = product(supplier, over);
    const ref = (id) => ({ driveFileId: id, sha256: sha(jpeg), mediaType: 'image/jpeg', role: 'VEHICLE_PHOTO', zone: '차량사진',
        approvedAt: '2026-10-15T00:00:00.000Z', vehicleKey: vehiclePhotoKey(p), vehiclePhotoVerifiedBy: 'tester',
        vehiclePhotoVerificationMethod: method, vehiclePhotoVerifiedAt: '2026-10-15T00:00:00.000Z', ...refOver });
    return { ...p, photo_original_refs: [ref('file_a'), ref('file_b')] };
};
const allow = new Set(['RP031', 'RP005']);
const failingOne = () => ({
    eligible: p => p?.provider_company_code === 'RP031', connection: () => 'c', read: vi.fn(async () => { throw new Error('ONE must not be called'); })
});
describe('사본 서빙 허용표', () => {
    it('파싱: RP031 은 항상 포함, 형식이 틀린 항목은 무시(허용표를 넓히지 않음)', () => {
        expect([...parsePhotoCopySuppliers(undefined)]).toEqual(['RP031']);
        expect([...parsePhotoCopySuppliers('')]).toEqual(['RP031']);
        expect([...parsePhotoCopySuppliers('rp005, RP012 ,bogus,RP12,RP0051,*')].sort()).toEqual(['RP005', 'RP012', 'RP031']);
    });
    it('공급사 코드 형식은 RP### 또는 PT-#### — 렌트존(PT-0001)이 허용표에서 빠지지 않고, 잘못된 PT 형식은 무시', () => {
        expect([...parsePhotoCopySuppliers('PT-0001, pt-0026, RP005')].sort()).toEqual(['PT-0001', 'PT-0026', 'RP005', 'RP031']);
        expect([...parsePhotoCopySuppliers('PT-1,PT0001,PT-00011,XX-0001,PT-000a')]).toEqual(['RP031']);
        const doc = withRefs('PT-0001', 'SUPPLIER_FOLDER_COPY');
        const pt = parsePhotoCopySuppliers('PT-0001');
        expect(isSupplierCopyPhotoProduct(doc, pt)).toBe(true);
        expect(approvedPhotoCount(doc, pt)).toBe(2);
        expect(approvedPhotoCount(doc)).toBe(0); // 허용표 밖이면 0(기본 = 이안카만)
        // 이안카 불변: PT 코드를 넣어도 RP031 규칙·방법은 그대로
        expect(isSupplierCopyPhotoProduct(withRefs('RP031', 'IANCAR_COMPRESSED_COPY'), pt)).toBe(true);
        expect(isSupplierCopyPhotoProduct(withRefs('RP031', 'SUPPLIER_FOLDER_COPY'), pt)).toBe(false);
    });
    it('표 안의 공급사만 사본 상품이다 — 공급사별 허용 방법(이안카=압축 사본만, 그 밖=폴더 사본·카톡 등록)', () => {
        expect(isSupplierCopyPhotoProduct(withRefs('RP005', 'SUPPLIER_FOLDER_COPY'), allow)).toBe(true);
        expect(isSupplierCopyPhotoProduct(withRefs('RP005', 'AUTO_KAKAO_COLLECT'), allow)).toBe(true);
        expect(isSupplierCopyPhotoProduct(withRefs('RP005', 'IANCAR_COMPRESSED_COPY'), allow)).toBe(false); // 이안카 방법은 이안카만
        expect(isSupplierCopyPhotoProduct(withRefs('RP031', 'IANCAR_COMPRESSED_COPY'), allow)).toBe(true);
        expect(isSupplierCopyPhotoProduct(withRefs('RP031', 'AUTO_KAKAO_COLLECT'), allow)).toBe(false); // 이안카 종전 규칙 유지
        expect(isSupplierCopyPhotoProduct(withRefs('RP012', 'SUPPLIER_FOLDER_COPY'), allow)).toBe(false); // 표 밖 공급사
        expect(isSupplierCopyPhotoProduct(withRefs('RP005', 'SUPPLIER_FOLDER_COPY', { sourceKind: 'IANCAR_ONE' }), allow)).toBe(false);
        expect(isSupplierCopyPhotoProduct(withRefs('RP005', 'SUPPLIER_FOLDER_COPY', {}, { listable: false }), allow)).toBe(false);
        expect(isSupplierCopyPhotoProduct(withRefs('RP005', 'SUPPLIER_FOLDER_COPY'))).toBe(false); // 기본 허용표 = 이안카만
    });
    it('photo_approved_count: 허용표 안에서만 >0, 서빙 보장 조건과 같은 판정', () => {
        expect(approvedPhotoCount(withRefs('RP005', 'SUPPLIER_FOLDER_COPY'), allow)).toBe(2);
        expect(approvedPhotoCount(withRefs('RP005', 'SUPPLIER_FOLDER_COPY'))).toBe(0);
        expect(approvedPhotoCount(withRefs('RP012', 'SUPPLIER_FOLDER_COPY'), allow)).toBe(0);
        expect(approvedPhotoCount(product('RP005'), allow)).toBe(0);
        expect(approvedPhotoCount(undefined, allow)).toBe(0);
    });
});
describe('공급사 공통 사본 서빙 — 읽기 경로', () => {
    it('허용 공급사: 기계 소비처(erp5-public-media)도 드라이브 사본으로 서빙, ONE 호출 0', async () => {
        const doc = withRefs('RP005', 'SUPPLIER_FOLDER_COPY');
        const one = failingOne();
        const copyReader = vi.fn(async () => ({ bytes: jpeg, contentType: 'image/jpeg' }));
        const read = createVehiclePhotoReader(async () => doc, one, copyReader, Date.now, undefined, new Set(), true, allow);
        const image = await read('erp5-public-media', 'p1', 1);
        expect(image.bytes).toEqual(jpeg);
        expect(image.count).toBe(2);
        expect(await image.revalidate()).toBe(true);
        expect(one.read).not.toHaveBeenCalled();
    });
    it('허용표 밖 공급사는 종전 동작: 기계 소비처는 이안카가 아니면 거절(404), 내부 소비처는 승인 refs 로 서빙', async () => {
        const doc = withRefs('RP012', 'SUPPLIER_FOLDER_COPY');
        const copyReader = vi.fn(async () => ({ bytes: jpeg, contentType: 'image/jpeg' }));
        const read = createVehiclePhotoReader(async () => doc, failingOne(), copyReader, Date.now, undefined, new Set(), true, allow);
        await expect(read('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
        expect((await read('erp-com', 'p1', 0)).bytes).toEqual(jpeg); // 종전: approvedSource
    });
    it('sha256 불일치·드라이브 404·리더 꺼짐·비적격(처리 중 변경)은 사진 없음/불가이고 ONE 폴백이 없다', async () => {
        const one = failingOne();
        const doc = withRefs('RP005', 'SUPPLIER_FOLDER_COPY');
        const bad = createVehiclePhotoReader(async () => doc, one, async () => ({ bytes: Buffer.concat([jpeg, Buffer.from([1])]), contentType: 'image/jpeg' }), Date.now, undefined, new Set(), true, allow);
        await expect(bad('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_UNAVAILABLE');
        const gone = createVehiclePhotoReader(async () => doc, one, async () => { throw new Error('VEHICLE_PHOTO_NOT_FOUND'); }, Date.now, undefined, new Set(), true, allow);
        await expect(gone('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
        const off = createVehiclePhotoReader(async () => doc, one, undefined, Date.now, undefined, new Set(), true, allow);
        await expect(off('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_READER_UNAVAILABLE');
        let current = doc;
        const ok = createVehiclePhotoReader(async () => current, one, async () => ({ bytes: jpeg, contentType: 'image/jpeg' }), Date.now, undefined, new Set(), true, allow);
        const image = await ok('erp5-public-media', 'p1', 0);
        current = { ...doc, listable: false };
        expect(await image.revalidate()).toBe(false);
        expect(one.read).not.toHaveBeenCalled();
    });
    it('이안카 동작 불변: 허용표를 넓혀도 RP031 사본 우선·폴백 스위치는 그대로', async () => {
        const doc = withRefs('RP031', 'IANCAR_COMPRESSED_COPY');
        const one = failingOne();
        const read = createVehiclePhotoReader(async () => doc, one, async () => ({ bytes: jpeg, contentType: 'image/jpeg' }), Date.now, undefined, new Set(), false, allow);
        expect((await read('erp5-public-media', 'p1', 0)).bytes).toEqual(jpeg);
        const noCopy = product('RP031', { iancar_one_vehicle_id: 'ONE-1' });
        const off = createVehiclePhotoReader(async () => noCopy, one, undefined, Date.now, undefined, new Set(), false, allow);
        await expect(off('erp5-public-media', 'p1', 0)).rejects.toThrow('VEHICLE_PHOTO_NOT_FOUND');
        expect(one.read).not.toHaveBeenCalled();
    });
});
