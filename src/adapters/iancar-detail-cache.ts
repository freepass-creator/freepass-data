/** 이안카(RP031) 상세·가용 캐시 — 손오공 상세 캐시(sonogong-detail-cache)와 같은 모양의 순수 모듈(쓰기·네트워크 없음).
 * 배경(1번 커맨드 오더 2026-10-16): 전량 직렬 읽기(≈114대 × 상세·가용·요금 3호출)가 24분 걸려 상세 신선도 창(15분)을 넘겨 보류·실패가 반복됐다.
 * 동시 읽기 수를 올리면 503 이 잦아 금지. 대신 «직전 회차에서 목록 행의 안정 필드가 같은 차»는 상세·가용 응답을 재사용해 호출을 3→1(요금만)로 줄인다.
 * Codex 상의(gpt-6-astra, P1 반영): ① 요금은 절대 캐시하지 않는다(가격이 조용히 바뀔 수 있어 매 회차 재읽기) ② 신선도 판정 기준을 회차 시작 시각으로 바꾸지 않는다
 * ③ 캐시 적중 차는 드리프트 한도 분모에서 빼서(실제 재읽기 수 기준) 비율이 희석되지 않게 한다 ④ 지문에 사진 URL·synced_at 같은 휘발 필드는 넣지 않는다.
 * 안전: 상태 파일 손상·형식 불일치는 캐시 없음(전수 읽기) · 유효 상한(기본 24시간) · 회차마다 가장 오래된 차 N대(기본 20)는 강제 재읽기(순환 전수)
 * · 재사용한 값도 엔진의 CAS·되읽기 가드를 그대로 거친다(이 모듈은 읽기 입력만 줄인다). */
import { createHash } from 'node:crypto';

export const IANCAR_DETAIL_CACHE_VERSION = 'iancar-detail-cache/1';
export const IANCAR_DETAIL_CACHE_POLICY = Object.freeze({ maxAgeMs: 24 * 60 * 60_000, rotationPerCycle: 20, maxEntries: 2_000 });
/** 지문에 넣는 목록 행 필드(안정 필드만): 번호·식별·제원·가용 상태. photos(자격 URL)·synced_at·stale 은 제외. */
export const IANCAR_ROW_DIGEST_FIELDS = Object.freeze(['plate_number', 'manufacturer', 'model', 'name', 'trim', 'year', 'fuel', 'color', 'mileage',
  'merchandising_status', 'inventory_status', 'available', 'available_from'] as const);

export type IancarDetailCacheEntry = {
  rowDigest: string;
  /** 캐시 시점에 검증을 통과한 상세·가용 응답 봉투(그대로 보존). */
  detail: Record<string, unknown>;
  availability: Record<string, unknown>;
  /** 실제로 읽은 시각(재사용으로 연장하지 않는다). */
  cachedAt: string;
  /** 읽을 때 상세 봉투가 말한 원천 갱신 시각(증거). */
  detailSyncedAt: string | null;
};
export type IancarDetailCache = { version: typeof IANCAR_DETAIL_CACHE_VERSION; writtenAt: string; entries: Record<string, IancarDetailCacheEntry> };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

/** 목록 행의 안정 필드 지문. 누락·null·false 를 구분하기 위해 키별로 «있음/없음»과 값을 함께 직렬화한다. 지문 규격은 버전에 묶인다. */
export function iancarListRowDigest(payload: Record<string, unknown>): string {
  const parts = IANCAR_ROW_DIGEST_FIELDS.map(key => [key, Object.hasOwn(payload, key), payload[key] ?? null]);
  return createHash('sha256').update(JSON.stringify([IANCAR_DETAIL_CACHE_VERSION, parts])).digest('hex');
}

/** 상태 파일을 엄격히 검증한다. 하나라도 틀리면 null = 캐시 없음(전수 읽기). */
export function parseIancarDetailCache(raw: unknown): IancarDetailCache | null {
  if (!isObject(raw) || raw.version !== IANCAR_DETAIL_CACHE_VERSION || !validTime(raw.writtenAt) || !isObject(raw.entries)) return null;
  const keys = Object.keys(raw.entries);
  if (keys.length > IANCAR_DETAIL_CACHE_POLICY.maxEntries) return null;
  const entries: Record<string, IancarDetailCacheEntry> = {};
  for (const key of keys) {
    const e = raw.entries[key];
    if (!isObject(e) || typeof e.rowDigest !== 'string' || !/^[a-f0-9]{64}$/.test(e.rowDigest) || !isObject(e.detail) || !isObject(e.availability)
      || !validTime(e.cachedAt) || (e.detailSyncedAt !== null && !validTime(e.detailSyncedAt))) return null;
    entries[key] = { rowDigest: e.rowDigest, detail: e.detail, availability: e.availability, cachedAt: e.cachedAt,
      detailSyncedAt: typeof e.detailSyncedAt === 'string' ? e.detailSyncedAt : null };
  }
  return { version: IANCAR_DETAIL_CACHE_VERSION, writtenAt: raw.writtenAt, entries };
}

/** 재사용 가능한 캐시 항목: 같은 행 지문 + 유효 상한 안(음수 나이는 시계 역행 → 재사용 안 함). */
export function cachedIancarDetailFor(cache: IancarDetailCache | null, vehicleId: string, rowDigest: string, nowMs: number,
  policy = IANCAR_DETAIL_CACHE_POLICY): IancarDetailCacheEntry | null {
  const entry = cache?.entries[vehicleId];
  if (!entry || entry.rowDigest !== rowDigest) return null;
  const age = nowMs - Date.parse(entry.cachedAt);
  if (!Number.isFinite(age) || age < 0 || age > policy.maxAgeMs) return null;
  return structuredClone(entry);
}

/** 순환 전수: 이번 회차 대상 중 캐시가 가장 오래된 N대는 캐시가 있어도 강제로 다시 읽는다(유효 상한과 별개로 24시간 안에 전부 한 번씩). */
export function iancarRotationIds(cache: IancarDetailCache | null, vehicleIds: readonly string[], policy = IANCAR_DETAIL_CACHE_POLICY): Set<string> {
  if (!cache) return new Set();
  const withAge = vehicleIds.filter(id => cache.entries[id]).map(id => [id, Date.parse(cache.entries[id]!.cachedAt)] as const)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  return new Set(withAge.slice(0, Math.max(0, policy.rotationPerCycle)).map(([id]) => id));
}
