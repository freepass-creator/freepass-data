# RP031 이안카 ONE API — FreePass Data 연동 계약

Status (2026-10-01): **공식 공개 가이드/인증 방식 검증 완료 · Data 클라이언트 구현 중 · 운영 키 미주입 · Canonical/소비처 전환 전**

## 확정된 연동 경로

기존 이안카 주소는 현재 `https://eancarone.com`으로 이동한다. ONE의 공개 제휴 API 가이드와 무키 401 응답으로 아래 계약을 확인했다.

```text
이안카 ONE
  https://eancarone.com
       ↓  Authorization: Bearer <partner API key>
FreePass Data
       ↓
RAW / Source Head
       ↓
reviewed Canonical Product · Offer · Policy · Photo reference
       ↓
ERP.com · Admin · 필요한 FreePass 소비처
```

RP031의 Google Sheet/F54/F86, 과거 로그인 `/api/inventory`, ERP4 DOM/요금 스크랩은 앞으로 **원천 authority가 아니다**. ONE API 전환 검증 후 비교·이력 외 fallback으로 사용하지 않는다.

## 공식 조회 API

- `GET /v1/vehicles` — 차량 목록
- `GET /v1/vehicles/{vehicle_id}` — 차량 상세
- `GET /v1/vehicles/{vehicle_id}/availability` — 최신 저장 재고 상태
- `GET /v1/vehicles/{vehicle_id}/rates` — 대여기간·약정거리별 요금
- `GET /v1/vehicles/{vehicle_id}/photos/{photo_id}` — 차량 사진

인증은 모든 조회 및 사진에 다음 형식이다.

```http
Authorization: Bearer <API key>
```

무키 `GET /v1/vehicles?page=1&page_size=1`은 401과 `WWW-Authenticate: Bearer`, `INVALID_API_KEY`를 반환하는 것을 확인했다.

## 차량 목록과 검색

목록은 페이지 기반이며 `page_size`는 1~100이다. 대표 검색 조건은 다음과 같다.

```text
?manufacturer=현대&fuel=hybrid&available=true&page=1&page_size=50
?max_monthly_rate=700000&rental_period=12&contracted_mileage=20000
```

목록 응답은 최소한 다음 운영 메타데이터를 제공한다.

```json
{
  "success": true,
  "data": [],
  "pagination": { "page": 1, "page_size": 50, "total": 0 },
  "synced_at": "2026-09-30T00:00:00.000Z",
  "stale": false
}
```

`vehicle_id`는 차량번호와 별개의 고정 ID다. FreePass Data의 원천 레코드 키는 차량번호가 아니라 이 provider stable ID를 사용하고 차량번호는 사실 필드로 보존한다.

원천 갱신 기준은 15분이다. `stale=true`이면 신규 대여 가능으로 표시하지 않는다. 페이지별 `synced_at`이 서로 다르거나 전체 행 수가 `pagination.total`과 다르면 FULL source head로 승격하지 않는다.

재고 상태는 `AVAILABLE / RESERVED / RENTED / PREPARING / UNAVAILABLE`을 그대로 보존한다. `available_from=null` 등 미확인 값은 추정하지 않는다.

## 요금·보증금·계약조건

- 금액 단위는 원화, VAT 포함 기준.
- `rental_period`: 개월.
- `contracted_mileage`: 약정거리 km.
- `mileage_period`: `month | year`.
- 12개월 이상은 ONE 장기 조건과 같이 연 약정거리 기준.
- `monthly_rate`: 해당 제휴사에 적용된 월 대여료.
- `deposit`: 보증금.
- 제공되지 않는 기간/거리 요금은 추정하지 않는다.
- 선택 추가금은 기본 `monthly_rate`에 임의 합산하지 않는다.

요금 항목에는 `contract_conditions.version`, `contract_conditions.items`, `contract_conditions.fields`가 포함될 수 있다. 조건 필드는 `label/status/value/note?`를 보존하며 상태는 다음 의미를 가진다.

- `confirmed`
- `rate_table`
- `current_terms`
- `needs_confirmation`
- `not_applicable`

**null을 0원 또는 불가로 바꾸지 않는다.** 조건의 의미와 버전은 요금과 함께 갱신한다.

## 사진

목록에는 대표사진, 상세 조회에는 전체 사진이 포함될 수 있다. 사진 참조는 24시간 유효하며 사진 경로도 Bearer 인증이 필요하다.

따라서 브라우저/ERP.com에 ONE API 키를 넘기지 않는다. 사진이 필요하면 FreePass Data 서버가 인증해 가져오거나 안전한 FreePass projection/proxy를 통해 제공한다.

## 오류와 재시도

- 400: 요청 오류
- 401: 키 오류
- 403: 차단/권한 없음
- 404: 정보 없음
- 405: 지원하지 않는 요청
- 429: 호출 한도 — `Retry-After` 존중
- 503: 일시적 제공 불가 — backoff
- 문의/추적에는 `X-Request-Id` 사용

오류 로그에는 API 키, 차량 원문, 계약조건 원문을 출력하지 않는다.

## FreePass Data 구현

`src/adapters/iancar-one-api.ts`

- 현재 공식 origin 기본값 `https://eancarone.com`
- Bearer 인증 고정
- GET-only, redirect 거부, 동일 origin 강제
- `/v1/vehicles` page_size=100 전량 수집
- stable `vehicle_id` 중복/누락 차단
- 페이지 전체 `synced_at` 일치와 `pagination.total` 대사
- `stale=true`이면 PARTIAL/INCOMPLETE
- 기존 `SourceIntakeBatch → append-only RAW → SourceHead` 재사용
- detail / availability / rates / authenticated photo 클라이언트 제공
- 값 없는 필드는 추론하지 않음

`src/jobs/collect-iancar-one-api.ts`

기본은 읽기와 안전한 수치/digest 보고만 수행한다.

```sh
npm run source:iancar:one
npm run source:iancar:one -- --inspect-detail-shape
```

실제 RAW 적재는 별도 운영 승인과 Data writer IAM이 있을 때만 수행한다.

```sh
EANCAR_ONE_RAW_INGEST_APPROVED=true npm run source:iancar:one -- --apply-raw
```

RAW 적재는 Canonical 발행이나 ERP.com 전환을 의미하지 않는다.

## 운영 개통 순서

1. 채팅에 노출된 기존 키는 폐기하고 새 read-only partner key를 재발급한다.
2. 새 키를 Git/명령행/브라우저가 아닌 FreePass Data runtime Secret에만 넣는다.
3. 첫 live read에서 전체 목록의 `total/synced_at/stale` 및 schema shape를 확인한다.
4. 차량 상세·요금·계약조건 schema를 값이 없는 shape 보고서로 확인한다.
5. allowlist 기반 Canonical mapper를 확정한다.
6. ONE API → Data Canonical → ERP.com/Admin의 같은 vehicle_id/상태/기간·거리별 요금 readback을 대사한다.
7. 대사 후 RP031의 Sheet/login/ERP4 fallback을 종료한다.
8. 이후 Data-owned scheduler에서 15분 freshness 기준으로 수집/감시한다.

사용자가 최종 결정한 운영 기준은 **ONE API → FreePass Data → ERP 직접 연동**이다. 이안카 시트를 다시 운영 원천으로 승격하지 않는다.
