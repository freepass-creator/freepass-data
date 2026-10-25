import { describe, expect, it } from 'vitest';
import { planPhotoCacheFromFolder, PHOTO_CACHE_MAX, driveFolderLink, driveThumbnailUrl } from '../src/application/photo-cache-folder-plan.js';
// 값은 전부 합성이다.
const FOLDER = 'F'.repeat(33), OTHER = 'G'.repeat(33);
const sha = (n) => String(n).padStart(64, 'a');
const img = (n, over = {}) => ({ id: `I${String(n).padStart(2, '0')}${'x'.repeat(20)}`, name: `link_${n}.jpg`, mimeType: 'image/jpeg', size: 1000 + n, sha256: sha(n), ...over });
const files = (n) => Array.from({ length: n }, (_, i) => img(i + 1));
const base = { plate: '109호2041', expectedProvider: 'RP004', doc: { provider_company_code: 'RP004' },
    folder: { id: FOLDER, name: '109호2041 캐스퍼 가솔린 1.0 스마트' }, files: files(19), now: '2026-10-22T03:00:00.000Z' };
describe('planPhotoCacheFromFolder', () => {
    it('writes photo_link + photo_cache for an empty document: folder-wide, natural file order, w640 thumbnails', () => {
        const plan = planPhotoCacheFromFolder({ ...base, files: [...files(12)].reverse() });
        expect(plan).toMatchObject({ status: 'WRITE', setLink: true, count: 12, photoLink: driveFolderLink(FOLDER) });
        if (plan.status !== 'WRITE')
            throw new Error('unreachable');
        expect(plan.cache.src).toBe(driveFolderLink(FOLDER));
        expect(plan.cache.at).toBe(base.now);
        expect(plan.cache.urls[0]).toBe(driveThumbnailUrl(img(1).id));
        expect(plan.cache.urls[1]).toBe(driveThumbnailUrl(img(2).id)); // 숫자 인식 정렬: 2 < 10
        expect(plan.cache.urls[11]).toBe(driveThumbnailUrl(img(12).id));
        expect(plan.cache.urls[0]).toContain('sz=w640');
    });
    it('caps at 40 (folder-wide, not the old 10) and never above the hard cap even if asked', () => {
        const p40 = planPhotoCacheFromFolder({ ...base, files: files(55) });
        expect(p40).toMatchObject({ status: 'WRITE', count: PHOTO_CACHE_MAX });
        expect(PHOTO_CACHE_MAX).toBe(40);
        expect(planPhotoCacheFromFolder({ ...base, files: files(55), max: 500 })).toMatchObject({ count: 40 });
        expect(planPhotoCacheFromFolder({ ...base, files: files(55), max: 12 })).toMatchObject({ count: 12 });
        expect(planPhotoCacheFromFolder({ ...base, files: files(55), max: 0 })).toMatchObject({ count: 1 });
    });
    it('keeps an existing same-folder link (setLink false) but refuses a different folder link or an existing cache', () => {
        expect(planPhotoCacheFromFolder({ ...base, doc: { ...base.doc, photo_link: driveFolderLink(FOLDER) } })).toMatchObject({ status: 'WRITE', setLink: false });
        expect(planPhotoCacheFromFolder({ ...base, doc: { ...base.doc, photo_link: driveFolderLink(OTHER) } })).toEqual({ status: 'SKIP', reason: 'LINK_DIFFERS' });
        expect(planPhotoCacheFromFolder({ ...base, doc: { ...base.doc, photo_link: 'https://example.com/album' } })).toEqual({ status: 'SKIP', reason: 'LINK_DIFFERS' });
        expect(planPhotoCacheFromFolder({ ...base, doc: { ...base.doc, photo_cache: { src: 'x', urls: ['https://a'] } } })).toEqual({ status: 'SKIP', reason: 'CACHE_EXISTS' });
        // 빈 캐시(urls 없음·빈 배열·빈 문자열)는 «없음» — 채운다
        for (const empty of [null, undefined, {}, { urls: [] }, { urls: [''] }, 'x', []])
            expect(planPhotoCacheFromFolder({ ...base, doc: { ...base.doc, photo_cache: empty } }).status).toBe('WRITE');
    });
    it('requires the right supplier and a folder name that matches the plate (no prefix-digit collisions)', () => {
        expect(planPhotoCacheFromFolder({ ...base, doc: { provider_company_code: 'RP012' } })).toEqual({ status: 'SKIP', reason: 'PROVIDER_MISMATCH' });
        expect(planPhotoCacheFromFolder({ ...base, doc: {} })).toEqual({ status: 'SKIP', reason: 'PROVIDER_MISMATCH' });
        expect(planPhotoCacheFromFolder({ ...base, folder: { id: FOLDER, name: '109호2042 캐스퍼' } })).toEqual({ status: 'SKIP', reason: 'FOLDER_NAME_MISMATCH' });
        expect(planPhotoCacheFromFolder({ ...base, folder: { id: FOLDER, name: '109호20410 캐스퍼' } })).toEqual({ status: 'SKIP', reason: 'FOLDER_NAME_MISMATCH' });
        expect(planPhotoCacheFromFolder({ ...base, folder: { id: FOLDER, name: '109호2041' } }).status).toBe('WRITE');
    });
    it('skips restricted / document folders and drops document-looking files, holding a document-heavy folder', () => {
        expect(planPhotoCacheFromFolder({ ...base, folder: { id: FOLDER, name: '109호2041 캐스퍼 사용X' } })).toEqual({ status: 'SKIP', reason: 'FOLDER_RESTRICTED' });
        expect(planPhotoCacheFromFolder({ ...base, folder: { id: FOLDER, name: '109호2041 등록증' } })).toEqual({ status: 'SKIP', reason: 'FOLDER_RESTRICTED' });
        const mixed = planPhotoCacheFromFolder({ ...base, files: [...files(9), img(90, { name: '자동차등록증.jpg' }), img(91, { name: 'scan.pdf', mimeType: 'application/pdf' })] });
        expect(mixed).toMatchObject({ status: 'WRITE', count: 9 });
        if (mixed.status === 'WRITE')
            expect(mixed.excluded).toMatchObject({ DOCUMENT_NAME: 1, DOCUMENT_PDF: 1 });
        expect(planPhotoCacheFromFolder({ ...base, files: [img(1), img(90, { name: '등록증.jpg' }), img(91, { name: '보험증권.jpg' })] }))
            .toMatchObject({ status: 'SKIP', reason: 'DOCUMENT_HEAVY' });
    });
    it('excludes non-images, missing checksums and oversize files; nothing usable means no write', () => {
        const plan = planPhotoCacheFromFolder({ ...base, files: [img(1), img(2, { sha256: null }), img(3, { mimeType: 'video/mp4' }), img(4, { size: 9 * 1024 * 1024 }), img(5, { size: 0 }), img(6, { name: '사용X_6.jpg' })] });
        expect(plan).toMatchObject({ status: 'WRITE', count: 1 });
        if (plan.status === 'WRITE')
            expect(plan.excluded).toMatchObject({ NO_CHECKSUM: 1, NOT_IMAGE: 1, FILE_TOO_LARGE: 2, USE_RESTRICTED: 1 });
        expect(planPhotoCacheFromFolder({ ...base, files: [] })).toMatchObject({ status: 'SKIP', reason: 'NO_PHOTOS' });
        expect(planPhotoCacheFromFolder({ ...base, files: [img(2, { sha256: null })] })).toMatchObject({ status: 'SKIP', reason: 'NO_PHOTOS' });
    });
});
