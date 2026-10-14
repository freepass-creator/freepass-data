/** 사진 연결 승격 계획(순수·읽기 전용) — 드라이브 «번호 폴더» 목록 × 상품 문서 스냅샷 → 승인 사진 등록 대상 CSV(번호,폴더) + 보류 목록.
 * 실제 등록(photo_original_refs 쓰기)은 기존 도구 scripts/ops/register-approved-photos.mjs 가 한다: 문서별 백업·updateTime 조건·한 건씩 되읽기·체크섬 검증이 거기 있다.
 * 이 모듈은 «어느 차에 어느 폴더를 연결할지» 만 결정한다(사람이 CSV 를 만들던 일의 자동화). 규칙: 하나로 특정되는 것만, 이미 사진이 있는 문서는 건드리지 않는다. */
export type DriveFolder = { id: string; /** 폴더 이름 = 차량번호 */ name: string; files: DriveFile[] };
export type DriveFile = { id: string; name: string; mimeType: string; size: number; sha256Checksum: string | null };
export type PhotoProduct = { plate: string; listable: boolean; photoRefCount: number; /** 공급사 코드가 있어 vehicleKey 를 만들 수 있는지 */ hasVehicleKey: boolean };
export type PhotoHold = { plate4: string; reason: 'NO_DOCUMENT' | 'AMBIGUOUS_FOLDER' | 'ALREADY_HAS_PHOTOS' | 'NO_ELIGIBLE_IMAGE' | 'NO_VEHICLE_KEY' | 'PLATE_INVALID' | 'OVER_RUN_LIMIT' };
export type PhotoLinkPlan = {
  /** 등록 도구가 읽는 «번호,폴더» 행(전체 번호는 비공개 디렉터리의 CSV 에만 둔다). */ csvRows: Array<{ plate: string; folderId: string; images: number }>;
  held: PhotoHold[]; stats: { folders: number; planned: number; held: number; eligibleImages: number };
};

const MEDIA = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 8 * 1024 * 1024;
const norm = (v: string) => v.normalize('NFKC').replace(/\s+/g, '');
const PLATE = /^\d{2,3}[가-힣]\d{4}$/;
const tail = (v: string) => v.replace(/\D/g, '').slice(-4);
const eligible = (f: DriveFile) => MEDIA.has(f.mimeType) && f.size > 0 && f.size <= MAX_BYTES && /^[a-f0-9]{64}$/.test(f.sha256Checksum ?? '');

export function planPhotoLinks(folders: readonly DriveFolder[], products: readonly PhotoProduct[], options: { maxPerRun?: number; includeExisting?: boolean } = {}): PhotoLinkPlan {
  const maxPerRun = Math.max(1, Math.min(200, options.maxPerRun ?? 50));
  const held: PhotoHold[] = [];
  const byPlate = new Map<string, DriveFolder[]>();
  for (const folder of folders) {
    const plate = norm(folder.name);
    if (!PLATE.test(plate)) { held.push({ plate4: tail(plate) || 'NONE', reason: 'PLATE_INVALID' }); continue; }
    (byPlate.get(plate) ?? byPlate.set(plate, []).get(plate)!).push(folder);
  }
  const docs = new Map(products.map(p => [norm(p.plate), p]));
  const candidates: Array<{ plate: string; folderId: string; images: number; listable: boolean }> = [];
  let eligibleImages = 0;
  for (const [plate, list] of [...byPlate].sort(([a], [b]) => a.localeCompare(b))) {
    const doc = docs.get(plate);
    if (!doc) { held.push({ plate4: tail(plate), reason: 'NO_DOCUMENT' }); continue; }
    if (list.length > 1) { held.push({ plate4: tail(plate), reason: 'AMBIGUOUS_FOLDER' }); continue; }
    if (doc.photoRefCount > 0 && !options.includeExisting) { held.push({ plate4: tail(plate), reason: 'ALREADY_HAS_PHOTOS' }); continue; }
    if (!doc.hasVehicleKey) { held.push({ plate4: tail(plate), reason: 'NO_VEHICLE_KEY' }); continue; }
    const images = list[0]!.files.filter(eligible).length;
    if (!images) { held.push({ plate4: tail(plate), reason: 'NO_ELIGIBLE_IMAGE' }); continue; }
    eligibleImages += images;
    candidates.push({ plate, folderId: list[0]!.id, images, listable: doc.listable });
  }
  // 노출 중인 차를 먼저(사진이 없으면 화면이 비어 있다), 같은 우선순위는 번호 순서 — 결정적.
  candidates.sort((a, b) => Number(b.listable) - Number(a.listable) || a.plate.localeCompare(b.plate));
  const planned = candidates.slice(0, maxPerRun);
  for (const c of candidates.slice(maxPerRun)) held.push({ plate4: tail(c.plate), reason: 'OVER_RUN_LIMIT' });
  return { csvRows: planned.map(({ plate, folderId, images }) => ({ plate, folderId, images })), held,
    stats: { folders: folders.length, planned: planned.length, held: held.length, eligibleImages } };
}

/** 등록 도구 입력 형식(헤더 «번호,폴더»). 전체 번호가 들어가므로 비공개 디렉터리에만 쓴다. */
export const photoLinkCsv = (plan: PhotoLinkPlan): string => ['번호,폴더', ...plan.csvRows.map(r => `${r.plate},${r.folderId}`)].join('\n') + '\n';
