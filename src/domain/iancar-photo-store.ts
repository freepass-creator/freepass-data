import { createHash } from 'node:crypto';
import { orderedJsonDigest } from '../shared/stable-digest.js';

/**
 * 이안카(RP031) 사진 저장본 규칙. 저장본은 «원천 사진 읽기 함수»의 대체 공급자일 뿐이며,
 * 공개·철회·삭제 판정은 서빙 게이트가 매 요청 DB 로 계속 한다(여기서 하지 않는다).
 */
export const IANCAR_PHOTO_STORE_BUCKET = 'freepasserp5-iancar-photos';
export const IANCAR_PHOTO_STORE_VERSION = 1;
/** 사진 내용 갱신 지연 허용 상한(지휘통제실 10-12 판정: 24시간). */
export const IANCAR_PHOTO_STORE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const IANCAR_PHOTO_RENDITIONS = Object.freeze({
  list: Object.freeze({ width: 480, quality: 75 }),
  detail: Object.freeze({ width: 960, quality: 80 }),
});

export type IancarPhotoVariant = keyof typeof IANCAR_PHOTO_RENDITIONS;

export type IancarPhotoStoreItem = {
  /** 서빙 순서(대표 먼저). */
  servingIndex: number;
  /** 원천 앨범에서의 순번과 대표 여부. */
  sourceOrdinal: number;
  representative: boolean;
  /** 원본 바이트 sha256 — 내용 판정 기준(원천은 사진 ID 를 호출마다 새로 낸다). */
  sha256: string;
  listObject: string; listSha256: string; listBytes: number;
  detailObject: string; detailSha256: string; detailBytes: number;
};

export type IancarPhotoManifest = {
  version: typeof IANCAR_PHOTO_STORE_VERSION;
  vehicleId: string;
  plateDigest: string;
  observedAt: string;
  count: number;
  items: IancarPhotoStoreItem[];
};

/** 상품 문서 포인터(칸 이름: iancar_photo_store). 사진 주소·개인정보 없음. */
export type IancarPhotoStorePointer = {
  version: typeof IANCAR_PHOTO_STORE_VERSION;
  manifestObject: string;
  manifestSha256: string;
  count: number;
  observedAt: string;
};

const HEX64 = /^[a-f0-9]{64}$/;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const instant = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));

export const sha256Hex = sha;
export const normalizePlate = (plate: string) => plate.replace(/\s/g, '');
export const iancarPlateDigest = (plate: string) => sha(JSON.stringify(['plate', normalizePlate(plate)]));
/** 객체 경로의 차량 마디는 ID 를 그대로 쓰지 않고 해시한다(경로 주입·추측 방지). */
export const iancarVehiclePathKey = (vehicleId: string) => sha(JSON.stringify(['vehicle', vehicleId])).slice(0, 32);

export const iancarPhotoObjectName = (vehicleId: string, contentSha256: string, variant: IancarPhotoVariant) =>
  `iancar/${iancarVehiclePathKey(vehicleId)}/${contentSha256}-${variant}.jpg`;
export const iancarManifestObjectName = (vehicleId: string, manifestSha256: string) =>
  `iancar/${iancarVehiclePathKey(vehicleId)}/manifests/${manifestSha256}.json`;

/** 매니페스트는 내용 주소: 이름의 해시 == 정규화한 내용의 해시. */
export const iancarManifestSha256 = (manifest: IancarPhotoManifest) => orderedJsonDigest(manifest);

export function buildIancarPhotoPointer(manifest: IancarPhotoManifest): IancarPhotoStorePointer {
  const manifestSha256 = iancarManifestSha256(manifest);
  return {
    version: IANCAR_PHOTO_STORE_VERSION,
    manifestObject: iancarManifestObjectName(manifest.vehicleId, manifestSha256),
    manifestSha256, count: manifest.count, observedAt: manifest.observedAt,
  };
}

export function parseIancarPhotoPointer(value: unknown): IancarPhotoStorePointer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.version !== IANCAR_PHOTO_STORE_VERSION || typeof v.manifestObject !== 'string' || !/^iancar\/[a-f0-9]{32}\/manifests\/[a-f0-9]{64}\.json$/.test(v.manifestObject)
    || typeof v.manifestSha256 !== 'string' || !HEX64.test(v.manifestSha256) || !v.manifestObject.endsWith(`/${v.manifestSha256}.json`)
    || typeof v.count !== 'number' || !Number.isSafeInteger(v.count) || v.count < 1 || v.count > 200 || !instant(v.observedAt)) return null;
  return { version: IANCAR_PHOTO_STORE_VERSION, manifestObject: v.manifestObject, manifestSha256: v.manifestSha256, count: v.count, observedAt: v.observedAt };
}

/** 매니페스트 형식·결속 검증. vehicleId 가 주어지면 객체 경로가 그 차량 것인지도 확인한다. */
export function parseIancarPhotoManifest(value: unknown): IancarPhotoManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  if (m.version !== IANCAR_PHOTO_STORE_VERSION || typeof m.vehicleId !== 'string' || !m.vehicleId || m.vehicleId.length > 200
    || typeof m.plateDigest !== 'string' || !HEX64.test(m.plateDigest) || !instant(m.observedAt)
    || typeof m.count !== 'number' || !Number.isSafeInteger(m.count) || m.count < 1 || m.count > 200
    || !Array.isArray(m.items) || m.items.length !== m.count) return null;
  const items: IancarPhotoStoreItem[] = [];
  const ordinals = new Set<number>();
  let representatives = 0;
  for (const [index, raw] of m.items.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const i = raw as Record<string, unknown>;
    const ok = i.servingIndex === index && typeof i.sourceOrdinal === 'number' && Number.isSafeInteger(i.sourceOrdinal) && i.sourceOrdinal >= 0 && i.sourceOrdinal < m.count
      && !ordinals.has(i.sourceOrdinal) && typeof i.representative === 'boolean'
      && typeof i.sha256 === 'string' && HEX64.test(i.sha256)
      && typeof i.listSha256 === 'string' && HEX64.test(i.listSha256) && typeof i.detailSha256 === 'string' && HEX64.test(i.detailSha256)
      && typeof i.listBytes === 'number' && Number.isSafeInteger(i.listBytes) && i.listBytes > 0
      && typeof i.detailBytes === 'number' && Number.isSafeInteger(i.detailBytes) && i.detailBytes > 0
      && i.listObject === iancarPhotoObjectName(m.vehicleId, i.listSha256 as string, 'list')
      && i.detailObject === iancarPhotoObjectName(m.vehicleId, i.detailSha256 as string, 'detail');
    if (!ok) return null;
    ordinals.add(i.sourceOrdinal as number);
    if (i.representative) representatives += 1;
    items.push(i as unknown as IancarPhotoStoreItem);
  }
  // 대표가 있다면 서빙 맨 앞이어야 한다(원천 규칙: 대표 먼저).
  if (representatives > 1 || (representatives === 1 && !items[0]!.representative)) return null;
  return { version: IANCAR_PHOTO_STORE_VERSION, vehicleId: m.vehicleId, plateDigest: m.plateDigest as string, observedAt: m.observedAt as string, count: m.count, items };
}

export const isIancarPhotoStoreFresh = (observedAt: string, nowMs: number) => {
  const at = Date.parse(observedAt);
  return Number.isFinite(at) && nowMs - at <= IANCAR_PHOTO_STORE_MAX_AGE_MS && at - nowMs <= 5 * 60 * 1000;
};

/** 서빙 게이트(createVehiclePhotoReader)가 요구하는 원천 레이아웃 메타를 매니페스트에서 만든다. 아이디는 «내용해시:순번» 이라 중복 사진도 유일하다. */
export function iancarManifestLayout(manifest: IancarPhotoManifest) {
  const servedIds = manifest.items.map(item => `${item.sha256}:${item.sourceOrdinal}`);
  const bySource = [...manifest.items].sort((a, b) => a.sourceOrdinal - b.sourceOrdinal);
  return {
    count: manifest.count,
    photoIds: servedIds,
    upstreamPhotoIds: bySource.map(item => `${item.sha256}:${item.sourceOrdinal}`),
    upstreamRepresentatives: bySource.map(item => item.representative),
    servingSourceOrdinals: manifest.items.map(item => item.sourceOrdinal),
  };
}
