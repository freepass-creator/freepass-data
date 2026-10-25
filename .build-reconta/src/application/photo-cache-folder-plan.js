/** 드라이브 번호 폴더 → 상품 문서의 화면용 사진 칸(photo_link + photo_cache) «계획» — 순수 로직(드라이브·Firestore 를 만지지 않는다).
 *  배경(2026-10-22 PC1 커맨드): 공개 화면(ERP5)은 승인 사진(photo_original_refs) 스위치가 꺼져 있어 photo_cache{src,urls} 와 photo_link 만 읽는다.
 *  기존 도구(scripts/ops/photo-cache-from-folder.mjs)는 photo_link 가 이미 있는 문서의 캐시만 채웠다(최대 10장) — 번호↔폴더 목록(CSV)으로
 *  photo_link 와 photo_cache 를 함께 쓰는 모드를 더한다. 서류·사용X 제외, 서류 비율 보류, 번호 일치 검증은 공급사 사진 인입 계획(supplier-photo-intake-plan)과 같은 함수를 쓴다.
 *  원칙: 불확실하면 쓰지 않는다. 이미 캐시가 있는 문서·다른 폴더 링크가 붙은 문서는 건드리지 않는다(사람·옛 도구가 정한 값 보존). */
import { folderMatchesPlate } from '../domain/photo-folder-match.js';
import { classifyFolderFiles, isDocumentHeavy, isDocumentName, isUseRestrictedName } from './supplier-photo-intake-plan.js';
/** 차량당 화면 사진 상한(대표 2026-10-22: 폴더 전체, 최대 40장). */
export const PHOTO_CACHE_MAX = 40;
export const PHOTO_THUMBNAIL_SIZE = 'w640';
const FOLDER_ID = /\/folders\/([A-Za-z0-9_-]{20,})/;
export const driveFolderLink = (folderId) => `https://drive.google.com/drive/folders/${folderId}`;
export const driveThumbnailUrl = (fileId) => `https://drive.google.com/thumbnail?id=${fileId}&sz=${PHOTO_THUMBNAIL_SIZE}`;
const hasUrls = (cache) => {
    if (!cache || typeof cache !== 'object' || Array.isArray(cache))
        return false;
    const urls = cache.urls;
    return Array.isArray(urls) && urls.some(u => typeof u === 'string' && u.trim() !== '');
};
export function planPhotoCacheFromFolder(input) {
    const { doc, folder } = input;
    if (doc.provider_company_code !== input.expectedProvider)
        return { status: 'SKIP', reason: 'PROVIDER_MISMATCH' };
    // 빈 칸만 쓴다: 캐시가 이미 있으면 보존(교체는 별도 결정).
    if (hasUrls(doc.photo_cache))
        return { status: 'SKIP', reason: 'CACHE_EXISTS' };
    const existing = typeof doc.photo_link === 'string' ? doc.photo_link.trim() : '';
    if (existing && FOLDER_ID.exec(existing)?.[1] !== folder.id)
        return { status: 'SKIP', reason: 'LINK_DIFFERS' };
    if (!folderMatchesPlate(folder.name, input.plate))
        return { status: 'SKIP', reason: 'FOLDER_NAME_MISMATCH' };
    if (isUseRestrictedName(folder.name) || isDocumentName(folder.name))
        return { status: 'SKIP', reason: 'FOLDER_RESTRICTED' };
    const cls = classifyFolderFiles(input.files);
    if (isDocumentHeavy(cls.documentLike, cls.candidates))
        return { status: 'SKIP', reason: 'DOCUMENT_HEAVY', excluded: cls.excluded };
    const max = Math.max(1, Math.min(PHOTO_CACHE_MAX, input.max ?? PHOTO_CACHE_MAX));
    const photos = cls.photos.slice(0, max);
    if (!photos.length)
        return { status: 'SKIP', reason: 'NO_PHOTOS', excluded: cls.excluded };
    const link = existing || driveFolderLink(folder.id);
    return { status: 'WRITE', photoLink: link, setLink: !existing, count: photos.length, excluded: cls.excluded,
        cache: { src: link, urls: photos.map(p => driveThumbnailUrl(p.id)), at: input.now } };
}
