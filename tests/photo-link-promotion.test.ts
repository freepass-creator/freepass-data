import { describe, expect, it } from 'vitest';
import { planPhotoLinks, photoLinkCsv, type DriveFolder, type PhotoProduct } from '../src/application/photo-link-promotion.js';

const img = (id: string, over: Partial<{ mimeType: string; size: number; sha256Checksum: string | null }> = {}) =>
  ({ id, name: `${id}.jpg`, mimeType: 'image/jpeg', size: 500_000, sha256Checksum: 'a'.repeat(64), ...over });
const folder = (id: string, name: string, files = [img('f1'), img('f2')]): DriveFolder => ({ id, name, files });
const doc = (plate: string, over: Partial<PhotoProduct> = {}): PhotoProduct => ({ plate, listable: true, photoRefCount: 0, hasVehicleKey: true, ...over });

describe('사진 연결 승격 계획', () => {
  it('links a numbered Drive folder to its document only when everything is unique and eligible, exposed cars first', () => {
    const plan = planPhotoLinks([folder('F2', '12가1002'), folder('F1', '12가1001'), folder('F3', '12가1003')],
      [doc('12가1001', { listable: false }), doc('12가1002'), doc('12가1003')]);
    expect(plan.csvRows.map(r => [r.plate, r.folderId, r.images])).toEqual([['12가1002', 'F2', 2], ['12가1003', 'F3', 2], ['12가1001', 'F1', 2]]);
    expect(photoLinkCsv(plan)).toBe('번호,폴더\n12가1002,F2\n12가1003,F3\n12가1001,F1\n');
    expect(plan.stats).toMatchObject({ folders: 3, planned: 3, held: 0, eligibleImages: 6 });
  });

  it('holds with a reason instead of guessing: no document, two folders, existing photos, no vehicle key, no eligible image, bad folder name', () => {
    const plan = planPhotoLinks([
      folder('A', '12가1001'),                                        // 문서 없음
      folder('B1', '12가1002'), folder('B2', '12 가 1002'),           // 같은 번호 폴더 둘(공백 표기 포함)
      folder('C', '12가1003'),                                        // 이미 사진 있음
      folder('D', '12가1004'),                                        // vehicleKey 불가
      folder('E', '12가1005', [img('x', { mimeType: 'application/pdf' }), img('y', { sha256Checksum: null }), img('z', { size: 9 * 1024 * 1024 })]),   // 적합 이미지 없음
      folder('G', '서류보관'),                                         // 번호 형식 아님
    ], [doc('12가1002'), doc('12가1003', { photoRefCount: 3 }), doc('12가1004', { hasVehicleKey: false }), doc('12가1005')]);
    expect(plan.csvRows).toEqual([]);
    expect(Object.fromEntries(plan.held.map(h => [h.plate4, h.reason]))).toEqual({
      '1001': 'NO_DOCUMENT', '1002': 'AMBIGUOUS_FOLDER', '1003': 'ALREADY_HAS_PHOTOS', '1004': 'NO_VEHICLE_KEY', '1005': 'NO_ELIGIBLE_IMAGE', NONE: 'PLATE_INVALID' });
    // 이미 사진이 있는 문서도 명시적으로 허용하면 계획에 들어간다(기본은 건드리지 않음)
    const again = planPhotoLinks([folder('C', '12가1003')], [doc('12가1003', { photoRefCount: 3 })], { includeExisting: true });
    expect(again.csvRows).toHaveLength(1);
  });

  it('caps one run (default 50, max 200) deterministically and reports the overflow as held', () => {
    const folders = Array.from({ length: 5 }, (_, i) => folder(`F${i}`, `12가${1000 + i}`));
    const products = folders.map(f => doc(f.name));
    const plan = planPhotoLinks(folders, products, { maxPerRun: 3 });
    expect(plan.csvRows.map(r => r.plate)).toEqual(['12가1000', '12가1001', '12가1002']);
    expect(plan.held.map(h => [h.plate4, h.reason])).toEqual([['1003', 'OVER_RUN_LIMIT'], ['1004', 'OVER_RUN_LIMIT']]);
  });

  it('never puts a full plate number in the held list (last 4 digits only)', () => {
    const plan = planPhotoLinks([folder('A', '12가1001')], []);
    expect(JSON.stringify(plan.held)).not.toMatch(/\d{2,3}[가-힣]\d{4}/);
  });
});
