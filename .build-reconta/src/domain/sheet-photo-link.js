/** F05 공통시트 «차량번호» 칸에 공급사가 붙인 사진 폴더 링크 → 상품 photo_link (대표 2026-10-22 «f05에 사진이 잘 반영 안 된 것도 있어 erp에»).
 *  순수 로직(시트·드라이브·Firestore 를 만지지 않는다). 원칙: 불확실하면 쓰지 않는다.
 *  - 드라이브 «폴더» 링크만 인정한다(https://drive.google.com/drive/[u/N/]folders/<id>). 파일·문서·단축 주소·open?id=·resourcekey 붙은 링크는 거절.
 *  - 한 칸에 링크가 둘 이상이면 어느 쪽인지 모르므로 거절. 같은 폴더가 서로 다른 번호에 붙어 있으면(복사·붙여넣기 실수) 모두 거절.
 *  - 값이 있는 photo_link 는 덮지 않는다. 드라이브 캐시(photo_cache)가 다른 폴더를 가리키면 쓰지 않는다(사람·옛 도구가 정한 값 보존).
 *  - 폴더 «이름»의 번호 일치(folderMatchesPlate)는 드라이브를 읽을 수 있는 사진 캐시 단계(scripts/ops/photo-cache-from-folder.mjs, photo-cache-folder-plan)가 다시 검증한다. */
import { isAssignedPlate, plateIdentityKey } from './vehicle-plate.js';
const FOLDER_PATH = /^\/drive\/(?:u\/\d{1,2}\/)?folders\/([A-Za-z0-9_-]{20,})\/?$/;
/** 링크 하나의 최대 길이(시트 칸 원문 보존 한도). */
export const SHEET_LINK_MAX_LENGTH = 2000;
/** 드라이브 폴더 링크 → 폴더 ID. 폴더 링크가 아니면 null. 공유 표시(usp=…)만 허용하고 그 밖의 질의(resourcekey 등)는 거절한다. */
export function driveFolderIdOf(link) {
    if (typeof link !== 'string' || !link.trim() || link.length > SHEET_LINK_MAX_LENGTH)
        return null;
    let url;
    try {
        url = new URL(link.trim());
    }
    catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.hostname !== 'drive.google.com' || url.username || url.password || url.port)
        return null;
    for (const key of url.searchParams.keys())
        if (key !== 'usp')
            return null;
    return FOLDER_PATH.exec(url.pathname)?.[1] ?? null;
}
export const canonicalDriveFolderLink = (folderId) => `https://drive.google.com/drive/folders/${folderId}`;
/** 차량번호 칸 링크 목록 → «탭|행» 별 표준 폴더 링크. plateAt 은 그 행의 차량번호 칸 값. 거절 사유는 건수로만 돌려준다(번호를 남기지 않는다). */
export function sheetPhotoLinksOf(entries, plateAt) {
    const skipped = {};
    const skip = (reason, n = 1) => { skipped[reason] = (skipped[reason] ?? 0) + n; };
    const candidates = [];
    for (const entry of entries ?? []) {
        const distinct = [...new Set((entry.links ?? []).filter((x) => typeof x === 'string' && x.trim() !== '').map(x => x.trim()))];
        if (!distinct.length)
            continue;
        if (distinct.length > 1) {
            skip('MULTIPLE_LINKS');
            continue;
        }
        const folder = driveFolderIdOf(distinct[0]);
        if (!folder) {
            skip('NOT_FOLDER');
            continue;
        }
        const plate = plateAt(entry.tab, entry.row);
        if (!isAssignedPlate(plate)) {
            skip('PLATE_MISSING');
            continue;
        }
        candidates.push({ key: `${entry.tab}|${entry.row}`, plate: plateIdentityKey(plate), folder });
    }
    const platesByFolder = new Map();
    for (const c of candidates)
        (platesByFolder.get(c.folder) ?? platesByFolder.set(c.folder, new Set()).get(c.folder)).add(c.plate);
    const links = new Map();
    for (const c of candidates) {
        if (platesByFolder.get(c.folder).size > 1) {
            skip('FOLDER_ON_MULTIPLE_PLATES');
            continue;
        }
        links.set(c.key, canonicalDriveFolderLink(c.folder));
    }
    return { links, skipped };
}
const textOf = (v) => (typeof v === 'string' ? v.trim() : '');
/** 문서 photo_link 를 이 폴더 링크로 채워도 되나: photo_link 가 비어 있고, 드라이브 캐시가 없거나 같은 폴더를 가리킬 때만. */
export function photoLinkFillable(doc, link) {
    if (doc.photo_link !== undefined && doc.photo_link !== null && (typeof doc.photo_link !== 'string' || textOf(doc.photo_link)))
        return false;
    const cache = doc.photo_cache;
    if (cache === undefined || cache === null)
        return true;
    if (typeof cache !== 'object' || Array.isArray(cache))
        return false;
    const src = textOf(cache.src), urls = cache.urls;
    const hasUrls = Array.isArray(urls) && urls.some(u => typeof u === 'string' && u.trim());
    if (!src && !hasUrls)
        return true;
    // 캐시가 이미 있으면 같은 폴더일 때만(캐시와 링크가 다른 차를 가리키지 않게). 링크를 아직 모르면(읽기 경로) 캐시 폴더가 읽히는지만 본다.
    const cacheFolder = driveFolderIdOf(src);
    return !!cacheFolder && (link === undefined || driveFolderIdOf(link) === cacheFolder);
}
/** 읽기 경로 표시: 채울 수 있는 빈 photo_link 면 { cacheFolder }(캐시가 있으면 그 폴더 ID), 아니면 null. */
export function photoLinkFillState(doc) {
    if (!photoLinkFillable(doc))
        return null;
    const src = doc.photo_cache && typeof doc.photo_cache === 'object' ? doc.photo_cache.src : undefined;
    return { cacheFolder: driveFolderIdOf(src) };
}
/** 계획 판정: 이번 관측 원천 링크로 이 빈 photo_link 를 채우게 되나(쓰기 규칙 sheetPhotoLinkFields 와 같은 결론). */
export function photoLinkFillDue(state, sheetPhotoLink) {
    const folder = driveFolderIdOf(sheetPhotoLink);
    return !!state && !!folder && (state.cacheFolder === null || state.cacheFolder === folder);
}
/** 쓰기 칸: 원천 기록의 시트 폴더 링크(raw.sheet_photo_link)를 빈 photo_link 에만. 출처 표식을 함께 남긴다. */
export function sheetPhotoLinkFields(raw, original, observedAt) {
    const folder = driveFolderIdOf(raw?.sheet_photo_link);
    if (!folder)
        return {};
    const link = canonicalDriveFolderLink(folder);
    if (!photoLinkFillable(original, link))
        return {};
    return { photo_link: link, photo_link_source: { kind: 'SHARED_SHEET_PLATE_LINK', at: observedAt } };
}
