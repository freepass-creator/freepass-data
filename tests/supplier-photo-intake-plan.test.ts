import { describe, expect, it } from 'vitest';
import { classifyFolderFiles, intakeSuppliers, planSupplierIntake, summarizeSupplierPlan, INTAKE_MAX_PHOTOS_PER_VEHICLE, INTAKE_MAX_FILE_BYTES,
  type IntakeFile, type IntakeFolder } from '../src/application/supplier-photo-intake-plan.js';
import { parsePhotoCopySuppliers } from '../src/domain/consumer-output-contract.js';
import { planSupplierPhotoIntakeCli } from '../src/jobs/plan-supplier-photo-intake.js';

const img = (name: string, size = 100_000, mimeType: string | null = 'image/jpeg'): IntakeFile => ({ id: `id-${name}`, name, mimeType, size });
const folder = (name: string, files: IntakeFile[], subfolderCount = 0): IntakeFolder => ({ id: `f-${name}`, name, files, subfolderCount });
const allowed = new Set(['RP012']);
const plan = (folders: IntakeFolder[], products: Array<{ plate: string; hasPhotoRefs: boolean }>, opts: { maxVehicles?: number } = {}) =>
  planSupplierIntake({ supplierCode: 'RP012', folders, products }, { allowedSuppliers: allowed, ...opts });

describe('공급사 사진 인입 계획', () => {
  it('전체 번호 일치 + 빈 refs → 계획, 번호는 끝 4자리만 노출', () => {
    const p = plan([folder('133하4531 쏘나타', [img('1.jpg'), img('2.jpg')])], [{ plate: '133하4531', hasPhotoRefs: false }]);
    expect(p.counts.PLANNED).toBe(1);
    expect(p.photosPlanned).toBe(2);
    expect(p.vehicles[0]!.plateLast4).toBe('4531');
    expect(JSON.stringify(summarizeSupplierPlan(p))).not.toContain('133하');
  });

  it('끝 4자리만 같은 다른 번호는 연결하지 않는다(문서 없음 보류)', () => {
    const p = plan([folder('133하4531 쏘나타', [img('1.jpg')])], [{ plate: '12가4531', hasPhotoRefs: false }]);
    expect(p.counts.HOLD_PRODUCT_NONE).toBe(1);
    expect(p.counts.PLANNED).toBe(0);
  });

  it('같은 번호 폴더 둘, 같은 번호 문서 둘 → 보류', () => {
    const dupFolders = plan([folder('133하4531 A', [img('1.jpg')]), folder('133하4531 B', [img('1.jpg')])], [{ plate: '133하4531', hasPhotoRefs: false }]);
    expect(dupFolders.counts.HOLD_FOLDER_DUPLICATE).toBe(1);
    const dupProducts = plan([folder('133하4531', [img('1.jpg')])], [{ plate: '133하4531', hasPhotoRefs: false }, { plate: '133하4531', hasPhotoRefs: false }]);
    expect(dupProducts.counts.HOLD_PRODUCT_DUPLICATE).toBe(1);
  });

  it('이미 refs 가 있으면 건너뜀(사람이 등록한 것 보존)', () => {
    const p = plan([folder('133하4531', [img('1.jpg')])], [{ plate: '133하4531', hasPhotoRefs: true }]);
    expect(p.counts.SKIP_HAS_REFS).toBe(1);
    expect(p.photosPlanned).toBe(0);
  });

  it('번호 모양이 아닌 폴더는 건너뜀(추정 금지)', () => {
    const p = plan([folder('쏘나타 사진', [img('1.jpg')])], []);
    expect(p.counts.SKIP_FOLDER_UNPARSED).toBe(1);
  });

  it('서류 표지 파일·비이미지·큰 파일은 제외, 사진만 계획', () => {
    const files = [img('1.jpg'), img('자동차등록증.jpg'), img('견적서.png'), img('doc.pdf', 1000, 'application/pdf'), img('big.jpg', INTAKE_MAX_FILE_BYTES + 1), img('2.jpg'), img('3.jpg'), img('4.jpg')];
    const c = classifyFolderFiles(files);
    expect(c.photos.map(f => f.name)).toEqual(['1.jpg', '2.jpg', '3.jpg', '4.jpg']);
    expect(c.excluded).toMatchObject({ DOCUMENT_NAME: 2, NOT_IMAGE: 1, FILE_TOO_LARGE: 1 });
  });

  it('서류 의심이 절반 이상이면 폴더 통째 보류', () => {
    const p = plan([folder('133하4531', [img('1.jpg'), img('등록증.jpg'), img('서류1.jpg')])], [{ plate: '133하4531', hasPhotoRefs: false }]);
    expect(p.counts.HOLD_DOCUMENT_RATIO).toBe(1);
    expect(p.photosPlanned).toBe(0);
  });

  it('하위 폴더는 읽지 않고 개수만 남긴다 / 사진 0장은 보류', () => {
    const p = plan([folder('133하4531', [], 2)], [{ plate: '133하4531', hasPhotoRefs: false }]);
    expect(p.counts.HOLD_NO_PHOTOS).toBe(1);
    expect(p.vehicles[0]!.subfoldersIgnored).toBe(2);
  });

  it('차량당 사진 상한·회차 차량 상한', () => {
    const many = Array.from({ length: INTAKE_MAX_PHOTOS_PER_VEHICLE + 5 }, (_, i) => img(`${String(i).padStart(4, '0')}.jpg`));
    const p = plan([folder('133하4531', many)], [{ plate: '133하4531', hasPhotoRefs: false }]);
    expect(p.vehicles[0]!.photos).toHaveLength(INTAKE_MAX_PHOTOS_PER_VEHICLE);
    expect(p.vehicles[0]!.excluded.OVER_PHOTO_CAP).toBe(5);
    const two = plan([folder('133하4531', [img('1.jpg')]), folder('134하4532', [img('1.jpg')])],
      [{ plate: '133하4531', hasPhotoRefs: false }, { plate: '134하4532', hasPhotoRefs: false }], { maxVehicles: 1 });
    expect(two.counts.PLANNED).toBe(1);
    expect(two.counts.HOLD_OVER_RUN_CAP).toBe(1);
  });

  it('허용표 밖 공급사는 처리하지 않는다 / 인입 대상 = 플래그 ∩ 허용표', () => {
    const out = planSupplierIntake({ supplierCode: 'RP099', folders: [folder('133하4531', [img('1.jpg')])], products: [{ plate: '133하4531', hasPhotoRefs: false }] }, { allowedSuppliers: allowed });
    expect(out.allowed).toBe(false);
    expect(out.vehicles).toEqual([]);
    const copy = parsePhotoCopySuppliers('RP012');
    expect([...intakeSuppliers('RP012,RP044,rp031,', copy)].sort()).toEqual(['RP012', 'RP031']);
    expect(intakeSuppliers('', copy).size).toBe(0);
    expect(intakeSuppliers(undefined, copy).size).toBe(0);
  });

  it('CLI: 플래그가 비어 있으면 아무것도 하지 않고 정상 종료, 입력이 없으면 설정 오류', () => {
    const lines: string[] = [];
    expect(planSupplierPhotoIntakeCli(['--input', 'x.json'], {}, l => lines.push(l))).toBe(0);
    expect(lines.join('\n')).toContain('처리 안 함');
    expect(planSupplierPhotoIntakeCli([], {}, () => undefined)).toBe(2);
    expect(planSupplierPhotoIntakeCli(['--input', 'x.json', '--max-vehicles', '0'], {}, () => undefined)).toBe(2);
  });
});
