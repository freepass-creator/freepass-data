export const PHOTO_RENDITION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const PHOTO_RENDITION_CACHE_MAX_BYTES = 48 * 1024 * 1024;
export const PHOTO_RENDITION_CACHE_MAX_ENTRIES = 1500;
export function createPhotoRenditionCache(options = {}) {
    const ttlMs = options.ttlMs ?? PHOTO_RENDITION_CACHE_TTL_MS;
    const maxBytes = options.maxBytes ?? PHOTO_RENDITION_CACHE_MAX_BYTES;
    const maxEntries = options.maxEntries ?? PHOTO_RENDITION_CACHE_MAX_ENTRIES;
    const now = options.now ?? Date.now;
    const entries = new Map();
    let totalBytes = 0;
    const key = (productId, index, size, tag) => JSON.stringify([productId, index, size, tag]);
    const remove = (k) => { const entry = entries.get(k); if (entry)
        totalBytes -= entry.bytes.length; entries.delete(k); };
    return {
        get(productId, index, size, tag) {
            const k = key(productId, index, size, tag);
            const entry = entries.get(k);
            if (!entry)
                return undefined;
            if (entry.expiresAt <= now()) {
                remove(k);
                return undefined;
            }
            entries.delete(k);
            entries.set(k, entry); // 최근 사용으로 갱신(LRU)
            return { bytes: Buffer.from(entry.bytes), contentType: entry.contentType, sourceCheckedAt: entry.sourceCheckedAt, ...(entry.albumFingerprint !== undefined ? { albumFingerprint: entry.albumFingerprint } : {}), ...(entry.sourceSha256 !== undefined ? { sourceSha256: entry.sourceSha256 } : {}) };
        },
        set(productId, index, size, tag, value) {
            if (!Buffer.isBuffer(value.bytes) || !value.bytes.length || value.bytes.length > maxBytes / 4)
                return; // 한 항목이 전체의 1/4 를 넘으면 담지 않는다
            const k = key(productId, index, size, tag);
            remove(k);
            for (const [other, entry] of entries)
                if (entry.expiresAt <= now())
                    remove(other);
            while ((totalBytes + value.bytes.length > maxBytes || entries.size >= maxEntries) && entries.size)
                remove(entries.keys().next().value);
            entries.set(k, { bytes: Buffer.from(value.bytes), contentType: value.contentType, sourceCheckedAt: value.sourceCheckedAt, ...(value.albumFingerprint !== undefined ? { albumFingerprint: value.albumFingerprint } : {}), ...(value.sourceSha256 !== undefined ? { sourceSha256: value.sourceSha256 } : {}), expiresAt: now() + ttlMs });
            totalBytes += value.bytes.length;
        },
        /** 원천 앨범을 다시 확인했을 때 마지막 확인 시각만 갱신한다(바이트·만료는 그대로). */
        touchSource(productId, index, size, tag, sourceCheckedAt) {
            const entry = entries.get(key(productId, index, size, tag));
            if (entry && sourceCheckedAt > entry.sourceCheckedAt)
                entry.sourceCheckedAt = sourceCheckedAt;
        },
        /** 한 상품의 항목을 모두 버린다(철회·변경 확인 때). */
        dropProduct(productId) { for (const k of [...entries.keys()])
            if (k.startsWith(`["${productId.replace(/"/g, '\\"')}",`))
                remove(k); },
        stats: () => ({ entries: entries.size, bytes: totalBytes }),
    };
}
