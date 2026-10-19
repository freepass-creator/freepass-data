/** 이안카(RP031) 원문 payload 의 «값 지문 안정화»(기본 꺼짐, 운영 변수 SOURCE_CYCLE_IANCAR_STABLE_FACTS=1).
 *
 * 실측(2026-10-16 23:50 회차 백업·영수증 113건): 가격·상태·조건 변화가 0 인데도 매 회차 전 차량이 UPDATE 로 쓰였다. 원인은 compactRaw 가
 * 중첩 객체를 digest 로 축약하기 «전에» 관측 시각·자격 토큰이 섞여 있어서다 — rateRequestEvidence.captured_at(호출 시각), 목록 행·상세의
 * photos(photo_id·url 이 요청마다 바뀌는 자격 URL). 비교(facts)는 시각 키를 digest 뒤에 빼므로 복구할 수 없다(Codex P1: 최초 compact 이전에
 * 정규화하고 저장에도 같은 규칙).
 *
 * 규칙(이안카 전용 계약 — 다른 공급사에는 적용하지 않는다):
 *  - detail·availability·rateRequestEvidence 봉투 «안»의 synced_at·captured_at·details_updated_at 제거(재읽기 회차의 봉투 시각이 digest 를 흔들지 않게).
 *    details_updated_at 은 상류가 동기화마다 내용 변화 없이도 갱신하는 시각(10-17 실측: 146호77xx 신차 묶음이 회전 재읽기마다 1~5건 UPDATE)이라
 *    시각으로 본다 — 실제 변화는 다른 상세 칸(주행·옵션·사진 수·상태)으로 잡힌다. 사진 경로(copy-iancar-photos)는 라이브 상세의 이 값을 읽으므로 영향 없음.
 *  - rateRequestEvidence.captured_at → null (fingerprint 가 이미 같은 방식, response_digest 등 나머지는 보존)
 *  - 목록 행 photos / detail.data.photos → 자격 URL 목록을 빼고 { count, representative_ordinal } 만 남긴다.
 *    사진 교체 감지는 엔진 책임이 아니다(사진 경로 iancar_one_photo_* · copy-iancar-photos 가 라이브 상세로 판정). 같은 개수·같은 대표 위치의
 *    교체는 이 요약으로 감지되지 않는다 — 그 책임은 사진 경로에 있음을 명시한다.
 *  - 그 밖의 값(요금·가용·제원·상태·동기화 시각 synced_at)은 그대로. synced_at·observedAt 는 비교 단계가 이미 뺀다.
 * 켜는 첫 회차는 저장된 옛 digest(시각·토큰 포함)와 달라 전량 1회 UPDATE 가 나고, 그다음 회차부터 값이 같으면 0 이다. */
export const IANCAR_STABLE_FACTS_VERSION = 'iancar-stable-facts/1';

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** 자격 URL 사진 목록 → 안정 요약. 배열이 아니면 그대로 둔다(모르는 꼴은 바꾸지 않는다). */
export function stableIancarPhotos(photos: unknown): unknown {
  if (!Array.isArray(photos)) return photos;
  const representative = photos.findIndex(p => isObject(p) && p.representative === true);
  return { count: photos.length, representative_ordinal: representative >= 0 ? representative : null, credential_urls_omitted: true };
}

/** 상세·가용·요금 증거 봉투 안의 관측 시각 키. digest 로 축약되기 전에 빼야 비교(withoutObservationClocks)가 닿지 않는 중첩 시각이 지문을 흔들지 않는다.
 * 상위(payload.synced_at)는 비교 단계가 이미 빼고 읽기 검증이 쓰므로 그대로 둔다. */
const NESTED_CLOCK_KEYS: ReadonlySet<string> = new Set(['captured_at', 'synced_at', 'observedAt', 'details_updated_at']);
const withoutNestedClocks = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutNestedClocks);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !NESTED_CLOCK_KEYS.has(k)).map(([k, v]) => [k, withoutNestedClocks(v)]));
};

export function stableIancarPayload<T extends Json>(payload: T): T {
  const out = structuredClone(payload) as Json;
  if (isObject(out.rateRequestEvidence)) out.rateRequestEvidence = { ...withoutNestedClocks(out.rateRequestEvidence) as Json, captured_at: null };
  if ('photos' in out) out.photos = stableIancarPhotos(out.photos);
  if (isObject(out.detail)) {
    const detail = withoutNestedClocks(out.detail) as Json;
    out.detail = isObject(detail.data) && 'photos' in detail.data ? { ...detail, data: { ...detail.data, photos: stableIancarPhotos(detail.data.photos) } } : detail;
  }
  if (isObject(out.availability)) out.availability = withoutNestedClocks(out.availability);
  return out as T;
}
