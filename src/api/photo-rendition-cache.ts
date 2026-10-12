/** 사진 «줄인 결과물(렌디션)» 메모리 캐시 — 상품·순번·크기·내용 표지가 같으면 원천(ONE)을 다시 읽지 않는다.
 * ONE 은 사진 ID 를 호출마다 새로 발급하고 한 장당 4~5초(상세+사진 2~3번 직렬 시 11~15초)가 걸려 ID 기반 캐시는 쓸 수 없다.
 * 그래서 키는 (상품 문서 ID, 순번, 크기, 내용 표지)이고, 내용 표지는 상품 연결(공급사·차량 ID·번호)+등록 개수의 해시다.
 * 캐시는 «원천 호출»만 건너뛴다. 비공개·철회·삭제·연결·개수 변경 재확인(DB)은 캐시 적중에서도 매 요청 그대로 한다.
 * 한도: 시간(기본 6시간)·전체 바이트(기본 48MiB)·항목 수. 가득 차면 가장 오래 안 쓴 것부터 버린다. 프로세스 메모리에만 있다. */
export type PhotoRenditionSize = 'list' | 'detail';
export type PhotoRenditionEntry = { bytes: Buffer; contentType: string; sourceCheckedAt: number };

export const PHOTO_RENDITION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const PHOTO_RENDITION_CACHE_MAX_BYTES = 48 * 1024 * 1024;
export const PHOTO_RENDITION_CACHE_MAX_ENTRIES = 1500;

export function createPhotoRenditionCache(options: { ttlMs?: number; maxBytes?: number; maxEntries?: number; now?: () => number } = {}) {
  const ttlMs = options.ttlMs ?? PHOTO_RENDITION_CACHE_TTL_MS;
  const maxBytes = options.maxBytes ?? PHOTO_RENDITION_CACHE_MAX_BYTES;
  const maxEntries = options.maxEntries ?? PHOTO_RENDITION_CACHE_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, PhotoRenditionEntry & { expiresAt: number }>();
  let totalBytes = 0;
  const key = (productId: string, index: number, size: PhotoRenditionSize, tag: string) => JSON.stringify([productId, index, size, tag]);
  const remove = (k: string) => { const entry = entries.get(k); if (entry) totalBytes -= entry.bytes.length; entries.delete(k); };
  return {
    get(productId: string, index: number, size: PhotoRenditionSize, tag: string): PhotoRenditionEntry | undefined {
      const k = key(productId, index, size, tag);
      const entry = entries.get(k);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) { remove(k); return undefined; }
      entries.delete(k); entries.set(k, entry);                        // 최근 사용으로 갱신(LRU)
      return { bytes: Buffer.from(entry.bytes), contentType: entry.contentType, sourceCheckedAt: entry.sourceCheckedAt };
    },
    set(productId: string, index: number, size: PhotoRenditionSize, tag: string, value: PhotoRenditionEntry): void {
      if (!Buffer.isBuffer(value.bytes) || !value.bytes.length || value.bytes.length > maxBytes / 4) return;   // 한 항목이 전체의 1/4 를 넘으면 담지 않는다
      const k = key(productId, index, size, tag);
      remove(k);
      for (const [other, entry] of entries) if (entry.expiresAt <= now()) remove(other);
      while ((totalBytes + value.bytes.length > maxBytes || entries.size >= maxEntries) && entries.size) remove(entries.keys().next().value!);
      entries.set(k, { bytes: Buffer.from(value.bytes), contentType: value.contentType, sourceCheckedAt: value.sourceCheckedAt, expiresAt: now() + ttlMs });
      totalBytes += value.bytes.length;
    },
    /** 원천 앨범을 다시 확인했을 때 마지막 확인 시각만 갱신한다(바이트·만료는 그대로). */
    touchSource(productId: string, index: number, size: PhotoRenditionSize, tag: string, sourceCheckedAt: number): void {
      const entry = entries.get(key(productId, index, size, tag));
      if (entry && sourceCheckedAt > entry.sourceCheckedAt) entry.sourceCheckedAt = sourceCheckedAt;
    },
    /** 한 상품의 항목을 모두 버린다(철회·변경 확인 때). */
    dropProduct(productId: string): void { for (const k of [...entries.keys()]) if (k.startsWith(`["${productId.replace(/"/g, '\\"')}",`)) remove(k); },
    stats: () => ({ entries: entries.size, bytes: totalBytes }),
  };
}
