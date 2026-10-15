/** 공급사 사진 인입 «계획»(구현 ② — 쓰기 0): freepasspics/<공급사>/<번호 차종>/ 폴더 ↔ 상품 문서 매칭, 서류 제외 분류, 상한 적용.
 *  설계: docs/KAKAO-PHOTO-TO-PRODUCT-DESIGN-20261016.md. 순수 로직 — 드라이브·Firestore 를 만지지 않는다(입력은 호출자가 읽어 준 스냅숏).
 *  원칙: 불확실하면 보류(fail-closed). 번호 매칭 키는 «같은 공급사 안 전체 번호»이며 끝 4자리는 표시 전용이다. */
import { folderMatchesPlate, plateFromFolderName } from '../domain/photo-folder-match.js';

export type IntakeFile = { id: string; name: string; mimeType: string | null; size: number | null };
/** files = 번호 폴더의 직계 파일만(하위 폴더는 subfolderCount 로만 전달 — 서류 하위 폴더는 통째로 읽지 않는다). */
export type IntakeFolder = { id: string; name: string; files: IntakeFile[]; subfolderCount?: number };
export type IntakeProduct = { plate: string; hasPhotoRefs: boolean };
export type IntakeSupplierInput = { supplierCode: string; folders: IntakeFolder[]; products: IntakeProduct[] };

export const INTAKE_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const INTAKE_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const INTAKE_MAX_PHOTOS_PER_VEHICLE = 200;
export const INTAKE_MAX_VEHICLES_PER_RUN = 50;
/** 서류 의심이 이 비율 이상이면 폴더 통째 보류(서류 묶음일 가능성). */
export const INTAKE_DOCUMENT_HOLD_RATIO = 0.5;
/** 파일명에 들어 있으면 서류로 보는 표지. 늘리는 쪽으로만 바꾼다(시험으로 고정). */
export const DOCUMENT_NAME_MARKERS = ['등록증', '자동차등록', '서류', '사업자', '보험', '계약', '신분', '면허', '인감', '명의', '통장', '견적', '영수'] as const;

export type ExcludeReason = 'DOCUMENT_NAME' | 'NOT_IMAGE' | 'FILE_TOO_LARGE' | 'OVER_PHOTO_CAP';
export type PlanStatus = 'PLANNED' | 'SKIP_HAS_REFS' | 'HOLD_FOLDER_DUPLICATE' | 'HOLD_PRODUCT_NONE' | 'HOLD_PRODUCT_DUPLICATE'
  | 'HOLD_DOCUMENT_RATIO' | 'HOLD_NO_PHOTOS' | 'HOLD_OVER_RUN_CAP' | 'SKIP_FOLDER_UNPARSED';
export type VehiclePlan = { plateLast4: string; folderId: string | null; status: PlanStatus; photos: IntakeFile[]; excluded: Partial<Record<ExcludeReason, number>>;
  subfoldersIgnored: number };
export type SupplierPlan = { supplierCode: string; allowed: boolean; vehicles: VehiclePlan[]; counts: Record<PlanStatus, number>; photosPlanned: number; documentsExcluded: number };

const squashName = (v: string): string => v.normalize('NFC').toLowerCase().replace(/\s+/g, '');
export const isDocumentName = (name: string): boolean => { const n = squashName(name); return DOCUMENT_NAME_MARKERS.some(m => n.includes(m)); };
const isImage = (f: IntakeFile): boolean => f.mimeType !== null && (INTAKE_IMAGE_MIME as readonly string[]).includes(f.mimeType.toLowerCase());
export const last4 = (plate: string): string => String(plate).replace(/\D/g, '').slice(-4);

const emptyCounts = (): Record<PlanStatus, number> => ({ PLANNED: 0, SKIP_HAS_REFS: 0, HOLD_FOLDER_DUPLICATE: 0, HOLD_PRODUCT_NONE: 0, HOLD_PRODUCT_DUPLICATE: 0,
  HOLD_DOCUMENT_RATIO: 0, HOLD_NO_PHOTOS: 0, HOLD_OVER_RUN_CAP: 0, SKIP_FOLDER_UNPARSED: 0 });

/** 한 폴더의 직계 파일을 분류한다: 사진 후보와 제외 사유별 건수. 서류 표지·비이미지·큰 파일 제외, 상한 초과분은 이름순 뒤쪽을 제외. */
export function classifyFolderFiles(files: readonly IntakeFile[]): { photos: IntakeFile[]; excluded: Partial<Record<ExcludeReason, number>>; documentLike: number } {
  const excluded: Partial<Record<ExcludeReason, number>> = {};
  const bump = (r: ExcludeReason) => { excluded[r] = (excluded[r] ?? 0) + 1; };
  const kept: IntakeFile[] = [];
  let documentLike = 0;
  for (const f of files) {
    if (isDocumentName(f.name)) { documentLike++; bump('DOCUMENT_NAME'); continue; }
    if (!isImage(f)) { bump('NOT_IMAGE'); continue; }
    if (f.size === null || f.size > INTAKE_MAX_FILE_BYTES || f.size <= 0) { bump('FILE_TOO_LARGE'); continue; }
    kept.push(f);
  }
  kept.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const photos = kept.slice(0, INTAKE_MAX_PHOTOS_PER_VEHICLE);
  for (let i = photos.length; i < kept.length; i++) bump('OVER_PHOTO_CAP');
  return { photos, excluded, documentLike };
}

export function planSupplierIntake(input: IntakeSupplierInput, options: { allowedSuppliers: ReadonlySet<string>; maxVehicles?: number | undefined }): SupplierPlan {
  const counts = emptyCounts();
  const allowed = options.allowedSuppliers.has(input.supplierCode);
  const maxVehicles = options.maxVehicles ?? INTAKE_MAX_VEHICLES_PER_RUN;
  if (!allowed) return { supplierCode: input.supplierCode, allowed: false, vehicles: [], counts, photosPlanned: 0, documentsExcluded: 0 };

  const productsByPlate = new Map<string, IntakeProduct[]>();
  for (const p of input.products) productsByPlate.set(p.plate, [...(productsByPlate.get(p.plate) ?? []), p]);
  const foldersByPlate = new Map<string, IntakeFolder[]>();
  const vehicles: VehiclePlan[] = [];
  for (const f of input.folders) {
    const plate = plateFromFolderName(f.name);
    if (!plate) { counts.SKIP_FOLDER_UNPARSED++; continue; }
    foldersByPlate.set(plate, [...(foldersByPlate.get(plate) ?? []), f]);
  }
  let planned = 0, photosPlanned = 0, documentsExcluded = 0;
  for (const [plate, folders] of [...foldersByPlate].sort(([a], [b]) => a.localeCompare(b))) {
    const add = (v: Omit<VehiclePlan, 'plateLast4' | 'subfoldersIgnored'> & { subfoldersIgnored?: number }) => {
      counts[v.status]++;
      vehicles.push({ plateLast4: last4(plate), subfoldersIgnored: 0, ...v });
    };
    if (folders.length > 1) { add({ folderId: null, status: 'HOLD_FOLDER_DUPLICATE', photos: [], excluded: {} }); continue; }
    const folder = folders[0]!;
    if (!folderMatchesPlate(folder.name, plate)) { add({ folderId: folder.id, status: 'SKIP_FOLDER_UNPARSED', photos: [], excluded: {} }); continue; }
    const prods = productsByPlate.get(plate) ?? [];
    if (prods.length === 0) { add({ folderId: folder.id, status: 'HOLD_PRODUCT_NONE', photos: [], excluded: {} }); continue; }
    if (prods.length > 1) { add({ folderId: folder.id, status: 'HOLD_PRODUCT_DUPLICATE', photos: [], excluded: {} }); continue; }
    if (prods[0]!.hasPhotoRefs) { add({ folderId: folder.id, status: 'SKIP_HAS_REFS', photos: [], excluded: {} }); continue; }
    const cls = classifyFolderFiles(folder.files);
    documentsExcluded += cls.documentLike;
    const subfoldersIgnored = folder.subfolderCount ?? 0;
    const imageCandidates = cls.photos.length + cls.documentLike;
    if (cls.documentLike > 0 && imageCandidates > 0 && cls.documentLike / imageCandidates >= INTAKE_DOCUMENT_HOLD_RATIO) {
      add({ folderId: folder.id, status: 'HOLD_DOCUMENT_RATIO', photos: [], excluded: cls.excluded, subfoldersIgnored }); continue;
    }
    if (cls.photos.length === 0) { add({ folderId: folder.id, status: 'HOLD_NO_PHOTOS', photos: [], excluded: cls.excluded, subfoldersIgnored }); continue; }
    if (planned >= maxVehicles) { add({ folderId: folder.id, status: 'HOLD_OVER_RUN_CAP', photos: [], excluded: cls.excluded, subfoldersIgnored }); continue; }
    planned++; photosPlanned += cls.photos.length;
    add({ folderId: folder.id, status: 'PLANNED', photos: cls.photos, excluded: cls.excluded, subfoldersIgnored });
  }
  return { supplierCode: input.supplierCode, allowed: true, vehicles, counts, photosPlanned, documentsExcluded };
}

/** 인입 대상 공급사 = 인입 플래그 ∩ 사본 허용표(서빙 못 하는 사진을 세지 않는다). 허용표에 없는 항목은 무시. */
export function intakeSuppliers(intakeFlag: string | undefined | null, copyAllowed: ReadonlySet<string>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const part of String(intakeFlag ?? '').split(',')) { const code = part.trim().toUpperCase(); if (code && copyAllowed.has(code)) out.add(code); }
  return out;
}

/** 보고용 요약(끝 4자리만, 파일 id·이름 없음). */
export function summarizeSupplierPlan(plan: SupplierPlan): string[] {
  if (!plan.allowed) return [`${plan.supplierCode} 인입 대상 아님(플래그·허용표 밖) — 처리 안 함`];
  const c = plan.counts;
  const lines = [`${plan.supplierCode} 계획 ${c.PLANNED}대·사진 ${plan.photosPlanned}장·서류 제외 ${plan.documentsExcluded}장`,
    `보류: 폴더중복 ${c.HOLD_FOLDER_DUPLICATE}·문서없음 ${c.HOLD_PRODUCT_NONE}·문서중복 ${c.HOLD_PRODUCT_DUPLICATE}·서류의심 ${c.HOLD_DOCUMENT_RATIO}·사진없음 ${c.HOLD_NO_PHOTOS}·상한 ${c.HOLD_OVER_RUN_CAP}`,
    `건너뜀: 이미 등록 ${c.SKIP_HAS_REFS}·번호 못 읽음 ${c.SKIP_FOLDER_UNPARSED}`];
  for (const v of plan.vehicles) if (v.status !== 'PLANNED' && v.status !== 'SKIP_HAS_REFS') lines.push(`${v.plateLast4} ${v.status}`);
  return lines;
}
