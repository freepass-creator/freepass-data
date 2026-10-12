import {
  IANCAR_PHOTO_STORE_VERSION,
  buildIancarPhotoPointer,
  iancarManifestObjectName,
  iancarPhotoObjectName,
  iancarPlateDigest,
  iancarManifestSha256,
  sha256Hex,
  type IancarPhotoManifest,
  type IancarPhotoStorePointer,
} from '../domain/iancar-photo-store.js';
import { isPublicIancarPhotoProduct } from '../domain/consumer-output-contract.js';
import type { PhotoObjectStore } from '../ports/photo-object-store.js';
import { stableDigest } from '../shared/stable-digest.js';

type Rec = Record<string, unknown>;

/** 원천 앨범의 한 장: 서빙 순서(대표 먼저)대로, 원천 순번과 대표 여부 포함. */
export type IancarAlbumPhoto = { photoId: string; sourceOrdinal: number; representative: boolean };
export type IancarPhotoBytes = { bytes: Buffer; contentType: string };

export type ReplicateIancarPhotosDeps = {
  /** ONE 호출은 모두 공통 제한기를 거쳐야 한다(호출자가 감싸서 넘긴다). */
  getAlbum: (vehicleId: string, plate: string) => Promise<IancarAlbumPhoto[]>;
  getPhotoBytes: (vehicleId: string, photoId: string) => Promise<IancarPhotoBytes>;
  renditioner: (original: Buffer) => Promise<{ list: Buffer; detail: Buffer }>;
  store: PhotoObjectStore;
  now: () => Date;
  /** 포인터 게시(조건부 트랜잭션). apply 가 아니면 호출하지 않는다. */
  publish?: (productId: string, pointer: IancarPhotoStorePointer, previousManifestSha256: string | null) => Promise<'PUBLISHED' | 'PRECONDITION_FAILED'>;
};

export type ReplicateVehicleResult = {
  productId: string;
  status: 'PUBLISHED' | 'DRY_RUN_OK' | 'SKIPPED_NOT_ELIGIBLE' | 'PRECONDITION_FAILED' | 'FAILED';
  photos: number;
  uploadedObjects: number;
  existingObjects: number;
  listBytes: number;
  detailBytes: number;
  manifestSha256?: string;
  reason?: string;
};

const JPEG = Buffer.from([255, 216, 255]);
const isJpeg = (bytes: Buffer) => bytes.length > 3 && bytes.subarray(0, 3).equals(JPEG);

/** 상품 한 대의 앨범을 저장소에 올리고(apply 면) 포인터를 게시한다. 객체는 내용 주소·덮어쓰기 없음. */
export async function replicateIancarVehicle(productId: string, product: Rec, deps: ReplicateIancarPhotosDeps, apply: boolean): Promise<ReplicateVehicleResult> {
  const base: ReplicateVehicleResult = { productId, status: 'FAILED', photos: 0, uploadedObjects: 0, existingObjects: 0, listBytes: 0, detailBytes: 0 };
  if (!isPublicIancarPhotoProduct(product)) return { ...base, status: 'SKIPPED_NOT_ELIGIBLE' };
  const vehicleId = product.iancar_one_vehicle_id as string, plate = product.car_number as string;
  try {
    const album = await deps.getAlbum(vehicleId, plate);
    if (!album.length || album.length > 200) return { ...base, reason: 'ALBUM_SIZE_INVALID' };
    const items: IancarPhotoManifest['items'] = [];
    let uploaded = 0, existing = 0, listBytes = 0, detailBytes = 0;
    // 내려받기+렌디션은 묶음(서빙 순서 보존)으로 병렬 처리한다. 호출 속도는 getPhotoBytes 를 감싼 공통 제한기가 정한다.
    const CHUNK = 6;
    const prepared: Array<{ photo: IancarAlbumPhoto; original: IancarPhotoBytes; rendered: { list: Buffer; detail: Buffer } }> = [];
    for (let from = 0; from < album.length; from += CHUNK) {
      prepared.push(...await Promise.all(album.slice(from, from + CHUNK).map(async photo => {
        const original = await deps.getPhotoBytes(vehicleId, photo.photoId);
        return { photo, original, rendered: await deps.renditioner(original.bytes) };
      })));
    }
    for (const [servingIndex, { photo, original, rendered }] of prepared.entries()) {
      if (!isJpeg(rendered.list) || !isJpeg(rendered.detail)) return { ...base, reason: 'RENDITION_INVALID' };
      const sha256 = sha256Hex(original.bytes), listSha = sha256Hex(rendered.list), detailSha = sha256Hex(rendered.detail);
      const listObject = iancarPhotoObjectName(vehicleId, listSha, 'list');
      const detailObject = iancarPhotoObjectName(vehicleId, detailSha, 'detail');
      if (apply) {
        for (const [name, bytes] of [[listObject, rendered.list], [detailObject, rendered.detail]] as const) {
          if (await deps.store.createObject(name, bytes, 'image/jpeg') === 'CREATED') uploaded += 1; else existing += 1;
        }
      }
      listBytes += rendered.list.length; detailBytes += rendered.detail.length;
      items.push({
        servingIndex, sourceOrdinal: photo.sourceOrdinal, representative: photo.representative, sha256,
        listObject, listSha256: listSha, listBytes: rendered.list.length,
        detailObject, detailSha256: detailSha, detailBytes: rendered.detail.length,
      });
    }
    const manifest: IancarPhotoManifest = {
      version: IANCAR_PHOTO_STORE_VERSION, vehicleId, plateDigest: iancarPlateDigest(plate),
      observedAt: deps.now().toISOString(), count: items.length, items,
    };
    const pointer = buildIancarPhotoPointer(manifest);
    const result: ReplicateVehicleResult = { ...base, photos: items.length, uploadedObjects: uploaded, existingObjects: existing, listBytes, detailBytes, manifestSha256: pointer.manifestSha256 };
    if (!apply) return { ...result, status: 'DRY_RUN_OK' };
    if (iancarManifestSha256(manifest) !== pointer.manifestSha256 || pointer.manifestObject !== iancarManifestObjectName(vehicleId, pointer.manifestSha256)) return { ...result, reason: 'MANIFEST_BINDING' };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    if (await deps.store.createObject(pointer.manifestObject, manifestBytes, 'application/json') === 'CREATED') result.uploadedObjects += 1; else result.existingObjects += 1;
    if (!deps.publish) return { ...result, reason: 'PUBLISH_PORT_MISSING' };
    const previous = (product.iancar_photo_store as Rec | undefined)?.manifestSha256;
    const published = await deps.publish(productId, pointer, typeof previous === 'string' ? previous : null);
    return { ...result, status: published };
  } catch (error) {
    return { ...base, reason: error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'REPLICATE_ERROR' };
  }
}

/** 승인 지문: 복제 대상 상품 집합과 렌디션 규격. 대상이 바뀌면 지문도 바뀐다. */
export function replicateIancarPhotosPlanDigest(productIds: string[], bucket: string) {
  return stableDigest({ schema: 'iancar-photo-store-plan/1', bucket, productIds: [...productIds].sort() });
}

export function eligibleIancarProductIds(products: Record<string, Rec>) {
  return Object.entries(products).filter(([, product]) => isPublicIancarPhotoProduct(product)).map(([id]) => id).sort();
}
