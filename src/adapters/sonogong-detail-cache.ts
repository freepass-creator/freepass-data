/** 손오공 상세 캐시·상류 갱신 대기(대표 10-15 «손오공 사진 먼저» 후속, 커맨드 센터 승인 ③).
 * 상세 GET 은 1.5초 간격 직렬이라 336대면 8~9분이 하한이다 — 직전 회차에서 «목록 행 digest 가 같은 차»의 상세를 재사용해 읽기 시간을 줄인다.
 * 안전: ① 캐시 유효 상한(기본 6시간) 넘으면 재읽기 ② 주기적 전수 갱신(기본 24시간) ③ 상태 파일 손상·형식 불일치는 캐시 없음(전수 읽기)으로 폴백
 * ④ 캐시로 정한 값도 엔진의 CAS·되읽기 가드를 그대로 거친다(이 모듈은 읽기 입력만 줄인다) ⑤ 쓰기·네트워크 없음(순수 모듈, 파일 입출력은 호출자). */
export const DETAIL_CACHE_VERSION = 'sonogong-detail-cache/1';
export const DETAIL_CACHE_POLICY = Object.freeze({ maxAgeMs: 6 * 60 * 60_000, fullRefreshAfterMs: 24 * 60 * 60_000, maxEntries: 2_000 });

export type DetailCacheEntry = { rowDigest: string; detail: Record<string, unknown>; cachedAt: string };
export type DetailCache = {
  version: typeof DETAIL_CACHE_VERSION; writtenAt: string;
  /** 마지막 «전수 읽기(캐시 미사용)»가 끝난 시각. 없으면 전수 갱신 시기가 지난 것으로 본다. */
  lastFullAt: string | null;
  /** 직전 읽기가 본 상류 생성 시각(갱신 대기 판단용). */
  lastGeneratedAt: string | null;
  entries: Record<string, DetailCacheEntry>;
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const validTime = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));

/** 상태 파일 내용을 엄격히 검증한다. 하나라도 틀리면 null = 캐시 없음(전수 읽기). 일부만 믿지 않는다. */
export function parseDetailCache(raw: unknown): DetailCache | null {
  if (!isObject(raw) || raw.version !== DETAIL_CACHE_VERSION || !validTime(raw.writtenAt) || !isObject(raw.entries)) return null;
  if (raw.lastFullAt !== null && raw.lastFullAt !== undefined && !validTime(raw.lastFullAt)) return null;
  if (raw.lastGeneratedAt !== null && raw.lastGeneratedAt !== undefined && !validTime(raw.lastGeneratedAt)) return null;
  const keys = Object.keys(raw.entries);
  if (keys.length > DETAIL_CACHE_POLICY.maxEntries) return null;
  const entries: Record<string, DetailCacheEntry> = {};
  for (const key of keys) {
    const entry = raw.entries[key];
    if (!isObject(entry) || typeof entry.rowDigest !== 'string' || !/^[a-f0-9]{16,64}$/.test(entry.rowDigest)
      || !isObject(entry.detail) || !validTime(entry.cachedAt)) return null;
    entries[key] = { rowDigest: entry.rowDigest, detail: entry.detail, cachedAt: entry.cachedAt };
  }
  return { version: DETAIL_CACHE_VERSION, writtenAt: raw.writtenAt,
    lastFullAt: typeof raw.lastFullAt === 'string' ? raw.lastFullAt : null,
    lastGeneratedAt: typeof raw.lastGeneratedAt === 'string' ? raw.lastGeneratedAt : null, entries };
}

/** 이 회차가 전수 갱신 차례인가(캐시 없음·전수 시각 없음·전수 갱신 주기 초과). */
export function fullRefreshDue(cache: DetailCache | null, nowMs: number, policy = DETAIL_CACHE_POLICY): boolean {
  if (!cache || !cache.lastFullAt) return true;
  return nowMs - Date.parse(cache.lastFullAt) >= policy.fullRefreshAfterMs;
}

/** 캐시된 상세를 쓸 수 있는가: 같은 목록 행 digest 이고 유효 상한 안. */
export function cachedDetailFor(cache: DetailCache | null, id: string, rowDigest: string, nowMs: number, policy = DETAIL_CACHE_POLICY): Record<string, unknown> | null {
  const entry = cache?.entries[id];
  if (!entry || entry.rowDigest !== rowDigest) return null;
  const age = nowMs - Date.parse(entry.cachedAt);
  if (!Number.isFinite(age) || age < 0 || age > policy.maxAgeMs) return null;
  return structuredClone(entry.detail);
}

/** 상류 생성 시각이 바뀔 때까지 기다린다(이안카 onlyWhenSynced 와 같은 방식). 최대 대기 시간 상한을 넘으면 기다림 없이 그대로 읽는다 —
 * 정시 회차가 갱신을 기다리다 영영 시작하지 못하는 일이 없다. lastGeneratedAt 이 없으면(첫 회차) 기다리지 않는다. */
export async function waitForUpstreamRefresh(probe: () => Promise<string | null>, input: {
  lastGeneratedAt: string | null; maxWaitMs: number; pollMs: number; sleep: (ms: number) => Promise<void>; now?: () => number;
}): Promise<{ changed: boolean; waitedMs: number; generatedAt: string | null; probeFailed: boolean }> {
  const now = input.now ?? Date.now;
  const started = now();
  if (!input.lastGeneratedAt || input.maxWaitMs <= 0) return { changed: true, waitedMs: 0, generatedAt: null, probeFailed: false };
  for (;;) {
    let generatedAt: string | null = null;
    try { generatedAt = await probe(); } catch { return { changed: false, waitedMs: now() - started, generatedAt: null, probeFailed: true }; }
    if (generatedAt && generatedAt !== input.lastGeneratedAt) return { changed: true, waitedMs: now() - started, generatedAt, probeFailed: false };
    if (now() - started + input.pollMs > input.maxWaitMs) return { changed: false, waitedMs: now() - started, generatedAt, probeFailed: false };
    await input.sleep(input.pollMs);
  }
}
