import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyFolderFiles, isDocumentHeavy, intakeSuppliers, planSupplierIntake, summarizeSupplierPlan, INTAKE_MAX_PHOTOS_PER_VEHICLE, INTAKE_MAX_FILE_BYTES,
  type IntakeFile, type IntakeFolder } from '../src/application/supplier-photo-intake-plan.js';
import { parsePhotoCopySuppliers } from '../src/domain/consumer-output-contract.js';
import { planSupplierPhotoIntakeCli } from '../src/jobs/plan-supplier-photo-intake.js';

const SHA = 'c'.repeat(64);
const img = (name: string, size = 100_000, mimeType: string | null = 'image/jpeg'): IntakeFile => ({ id: `id-${name}`, name, mimeType, size, sha256: SHA });
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
    expect(c.excluded).toMatchObject({ DOCUMENT_NAME: 2, DOCUMENT_PDF: 1, FILE_TOO_LARGE: 1 });
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

  it('사용X 표지: 파일은 제외, 폴더면 통째 보류(대소문자·공백 무시)', () => {
    const c = classifyFolderFiles([img('1.jpg'), img('사용X_2.jpg'), img('사용 x 3.jpg'), img('사용불가.png')]);
    expect(c.photos.map(f => f.name)).toEqual(['1.jpg']);
    expect(c.excluded.USE_RESTRICTED).toBe(3);
    const p = plan([folder('109호1234 K5 사용X', [img('1.jpg')])], [{ plate: '109호1234', hasPhotoRefs: false }]);
    expect(p.counts.HOLD_USE_RESTRICTED).toBe(1);
    expect(p.photosPlanned).toBe(0);
  });

  it('아이카식 번호(109호NNNN)도 전체 번호로 매칭된다', () => {
    const p = plan([folder('109호1234 K5', [img('1.jpg')])], [{ plate: '109호1234', hasPhotoRefs: false }]);
    expect(p.counts.PLANNED).toBe(1);
  });

  it('Codex #690 (a): 폴더 이름이 서류(«번호 등록증»)면 파일명에 표지가 없어도 통째 보류', () => {
    const p = plan([folder('109호1234 등록증', [img('1.jpg'), img('2.jpg')])], [{ plate: '109호1234', hasPhotoRefs: false }]);
    expect(p.counts.HOLD_DOCUMENT_FOLDER).toBe(1);
    expect(p.photosPlanned).toBe(0);
  });

  it('Codex #690 재검토: 서류 비율 판정은 계획 모듈·등록 도구가 같은 함수(등록증.jpg + 001.jpg 는 보류)', () => {
    expect(isDocumentHeavy(1, 1)).toBe(true);
    expect(isDocumentHeavy(1, 3)).toBe(false);
    expect(isDocumentHeavy(0, 5)).toBe(false);
    expect(isDocumentHeavy(0, 0)).toBe(false);
    const c = classifyFolderFiles([img('등록증.jpg'), img('001.jpg')]);
    expect(isDocumentHeavy(c.documentLike, c.photos.length)).toBe(true);
    const p = plan([folder('109호1234', [img('등록증.jpg'), img('001.jpg')])], [{ plate: '109호1234', hasPhotoRefs: false }]);
    expect(p.counts.HOLD_DOCUMENT_RATIO).toBe(1);
  });

  it('Codex #690 재검토 3건: PDF 서류도 비율에 포함, 장수 상한으로 자르기 전 전체로 비율 계산', () => {
    const pdf = classifyFolderFiles([img('등록증.pdf', 1000, 'application/pdf'), img('001.jpg')]);
    expect(pdf.documentLike).toBe(1);
    expect(isDocumentHeavy(pdf.documentLike, pdf.candidates)).toBe(true);
    // 서류 200 + 정상 300: 실제 40% → 보류 아님(자른 200장으로 계산하면 50% 가 돼 과보류)
    const docs = Array.from({ length: 200 }, (_, i) => img(`등록증${i}.jpg`));
    const photos = Array.from({ length: 300 }, (_, i) => img(`${String(i).padStart(4, '0')}.jpg`));
    const big = classifyFolderFiles([...docs, ...photos]);
    expect(big.photos).toHaveLength(INTAKE_MAX_PHOTOS_PER_VEHICLE);
    expect(big.candidates).toBe(300);
    expect(isDocumentHeavy(big.documentLike, big.candidates)).toBe(false);
    const p = plan([folder('109호1234', [...docs, ...photos])], [{ plate: '109호1234', hasPhotoRefs: false }]);
    expect(p.counts.PLANNED).toBe(1);
  });

  it('Codex #690 4차: 이름 없는 PDF 도 서류, 체크섬 없는 이미지는 등록 도구와 같이 제외, 정렬 기준 일치', () => {
    const pdf = classifyFolderFiles([img('001.pdf', 1000, 'application/pdf'), img('002.jpg')]);
    expect(pdf.documentLike).toBe(1);
    expect(pdf.excluded.DOCUMENT_PDF).toBe(1);
    expect(isDocumentHeavy(pdf.documentLike, pdf.candidates)).toBe(true);
    const sha = 'a'.repeat(64);
    const withSha = (name: string, sha256: string | null): IntakeFile => ({ ...img(name), sha256 });
    const c = classifyFolderFiles([withSha('1.jpg', sha), withSha('2.jpg', null), withSha('3.jpg', 'xyz')]);
    expect(c.photos.map(f => f.name)).toEqual(['1.jpg']);
    expect(c.excluded.NO_CHECKSUM).toBe(2);
    // 체크섬이 생략(undefined)된 이미지도 제외한다(fail-closed, 등록 도구와 같은 판정)
    const omitted = classifyFolderFiles([{ id: 'x', name: '1.jpg', mimeType: 'image/jpeg', size: 1000 }]);
    expect(omitted.photos).toHaveLength(0);
    expect(omitted.excluded.NO_CHECKSUM).toBe(1);
    // 같은 이름은 id 순으로 안정 정렬
    const dup = classifyFolderFiles([{ ...img('1.jpg'), id: 'b' }, { ...img('1.jpg'), id: 'a' }]).photos.map(f => f.id);
    expect(dup).toEqual(['a', 'b']);
    // 숫자 인식 정렬: 2 < 10 (등록 도구와 같은 기준)
    const order = classifyFolderFiles([img('10.jpg'), img('2.jpg'), img('1.jpg')]).photos.map(f => f.name);
    expect(order).toEqual(['1.jpg', '2.jpg', '10.jpg']);
  });

  it('Codex #690 (b): 회차 차량 상한은 공급사별이 아니라 전체 합산', () => {
    const dir = mkdtempSync(join(tmpdir(), 'intake-'));
    const supplier = (code: string, plates: string[]) => ({ supplierCode: code,
      folders: plates.map(pl => folder(`${pl} 차`, [img('1.jpg')])), products: plates.map(pl => ({ plate: pl, hasPhotoRefs: false })) });
    const file = join(dir, 's.json');
    writeFileSync(file, JSON.stringify({ suppliers: [supplier('RP012', ['101가1001', '101가1002', '101가1003']), supplier('RP004', ['102가2001', '102가2002', '102가2003'])] }));
    const lines: string[] = [];
    const code = planSupplierPhotoIntakeCli(['--input', file, '--max-vehicles', '4'], { FREEPASS_DATA_PHOTO_INTAKE_SUPPLIERS: 'RP012,RP004', FREEPASS_DATA_PHOTO_COPY_SUPPLIERS: 'RP012,RP004' }, l => lines.push(l));
    expect(code).toBe(0);
    const planned = lines.map(l => /계획 (\d+)대/.exec(l)?.[1]).filter(Boolean).map(Number);
    expect(planned).toEqual([3, 1]);   // 4대 합산 상한: 앞 공급사 3대 + 뒤 공급사 1대
    rmSync(dir, { recursive: true, force: true });
  });

  it('CLI: 플래그가 비어 있으면 아무것도 하지 않고 정상 종료, 입력이 없으면 설정 오류', () => {
    const lines: string[] = [];
    expect(planSupplierPhotoIntakeCli(['--input', 'x.json'], {}, l => lines.push(l))).toBe(0);
    expect(lines.join('\n')).toContain('처리 안 함');
    expect(planSupplierPhotoIntakeCli([], {}, () => undefined)).toBe(2);
    expect(planSupplierPhotoIntakeCli(['--input', 'x.json', '--max-vehicles', '0'], {}, () => undefined)).toBe(2);
  });
});
