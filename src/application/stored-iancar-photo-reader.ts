import { idGatePhotoIds, type VehiclePhotoRead } from '../domain/consumer-output-contract.js';
import {
  IANCAR_PHOTO_RENDITIONS,
  iancarManifestLayout,
  iancarManifestSha256,
  iancarPlateDigest,
  isIancarPhotoStoreFresh,
  parseIancarPhotoManifest,
  parseIancarPhotoPointer,
  sha256Hex,
  type IancarPhotoManifest,
} from '../domain/iancar-photo-store.js';
import type { PhotoObjectStore } from '../ports/photo-object-store.js';

type Rec = Record<string, unknown>;

/**
 * 저장본 우선 사진 읽기. 저장본을 쓸 수 없거나 어긋나면 null — 호출자는 기존 원천 경로로 대체한다.
 * 공개·철회·삭제 게이트는 호출자(createVehiclePhotoReader)가 매 요청 DB 로 먼저 확인하므로 여기서 다루지 않는다.
 * 값은 모두 검증한 뒤에만 돌려준다: 포인터 → 매니페스트(sha256·차량·번호판·개수) → 객체(sha256·바이트).
 */
export function createStoredIancarPhotoReader(deps: {
  store: PhotoObjectStore;
  now?: () => number;
  manifestCacheTtlMs?: number;
  onFallback?: (reason: string) => void;
}) {
  const now = deps.now ?? Date.now;
  const ttl = deps.manifestCacheTtlMs ?? 30_000;
  // 캐시 키는 매니페스트 sha256 (리비전별 분리).
  const manifests = new Map<string, { value: IancarPhotoManifest; expiresAt: number }>();
  const fallback = (reason: string): null => { try { deps.onFallback?.(reason); } catch { /* 관측 실패는 서빙에 영향 없음 */ } return null; };

  const loadManifest = async (objectName: string, expectedSha: string): Promise<IancarPhotoManifest | null> => {
    const hit = manifests.get(expectedSha);
    if (hit && hit.expiresAt > now()) return hit.value;
    manifests.delete(expectedSha);
    const bytes = await deps.store.getObject(objectName);
    if (!bytes) return null;
    let parsed: IancarPhotoManifest | null;
    try { parsed = parseIancarPhotoManifest(JSON.parse(bytes.toString('utf8'))); } catch { return null; }
    if (!parsed || iancarManifestSha256(parsed) !== expectedSha) return null;
    if (manifests.size >= 256) manifests.delete(manifests.keys().next().value!);
    manifests.set(expectedSha, { value: parsed, expiresAt: now() + ttl });
    return parsed;
  };

  return async (product: Rec, index?: number): Promise<VehiclePhotoRead | null> => {
    try {
      const pointer = parseIancarPhotoPointer(product.iancar_photo_store);
      if (!pointer) return fallback('NO_POINTER');
      if (!isIancarPhotoStoreFresh(pointer.observedAt, now())) return fallback('STALE');
      // 상품 문서에 등록된 개수와 저장본 개수가 같을 때만(앨범이 바뀐 채 옛 저장본이 나가지 않게).
      const registered = idGatePhotoIds(product);
      if (!registered || registered.length !== pointer.count) return fallback('COUNT_MISMATCH');
      const vehicleId = product.iancar_one_vehicle_id, plate = product.car_number;
      if (typeof vehicleId !== 'string' || typeof plate !== 'string') return fallback('IDENTITY_MISSING');
      const manifest = await loadManifest(pointer.manifestObject, pointer.manifestSha256);
      if (!manifest) return fallback('MANIFEST_INVALID');
      if (manifest.vehicleId !== vehicleId || manifest.plateDigest !== iancarPlateDigest(plate)
        || manifest.count !== pointer.count || manifest.observedAt !== pointer.observedAt) return fallback('BINDING_MISMATCH');
      const layout = iancarManifestLayout(manifest);
      if (index === undefined) return { ...layout, bytes: null, contentType: 'application/json' };
      const item = manifest.items[index];
      if (!item) return fallback('INDEX_OUT_OF_RANGE');
      const bytes = await deps.store.getObject(item.detailObject);
      if (!bytes || bytes.length !== item.detailBytes || sha256Hex(bytes) !== item.detailSha256) return fallback('OBJECT_INVALID');
      return { ...layout, bytes, contentType: 'image/jpeg' };
    } catch {
      return fallback('STORE_ERROR');
    }
  };
}

export const IANCAR_PHOTO_SERVED_VARIANT = 'detail' as const;
export const IANCAR_PHOTO_SERVED_WIDTH = IANCAR_PHOTO_RENDITIONS.detail.width;
