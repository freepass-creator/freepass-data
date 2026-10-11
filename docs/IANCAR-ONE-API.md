# RP031 이안카 ONE API — FreePass Data 연동 계약

Status (2026-10-01): **1차 Data 상품/ERP/F01/F86 실제 발행 및 readback 완료 · 정책/15분 자동 writer/Catalog cutover는 미완료**

최신 적용 회차: source `2026-10-01T08:13:03.756Z`, 117대/2,808개 요금에서 공개109대(출고가능108·계약중1). Data apply `b6a8ac1e-a86a-49c8-a53a-9037a760303a`, 운영 시트 apply `36837674105` SUCCESS. F01/F86 새 원문 조회로109대 차량번호·상태·기준금액·24개 기간/월연거리/보증금·정책 확인중 표시 mismatch0. 별도 공급사 원천표 없이 Data 소유 RP031 compatibility bridge를 기존 소비처에 적용했다. Catalog V1 ACTIVE release/cutover나 현재 API 실시간 신선도를 주장하지 않는다. 아래 미실행/111대 문구는 이전 관측 이력이며 최신 적용 증거는 [handoff](NEXT-START-HERE.md)에 있다.

최신 전량 관측(서울13:24 source): 111대 상세·availability·요금2,664개 및 종료 inventory 대사 성공, issues0. 기존301대와 match89/신규22/미관측212보존, 타 공급사 차번호 충돌0. 실제 ERP/F01/F86 발행은 아직 미실행이며 기간·월/연 거리·기간별 보증금의 소비처 표현 범위를 사용자에게 확인 중이다. 정확한 digest/private evidence 및 다음 단계는 [전량 수집 기록](NEXT-START-HERE.md#날짜별-작업-이력)에 있다. 수집기는 독립 endpoint 병렬×2worker(최대6), 실패 시 진행 중 요청을 정리하고429/Retry-After를 보존한다.

## 2026-10-01 실제 연결 확인

- 사용자 최신 결정: 제공한 기존 키를 그대로 사용한다. 교체를 실행 조건으로 다시 요구하지 않는다.
- 서버 자격증명 정본: `freepasserp5` Secret Manager의 `freepass-data-iancar-one-api`, version `1` (enabled). 별도 IAM grant/운영 scheduler 활성화는 하지 않았다. 값은 Git/명령행/파일/출력에 넣지 않고 비출력 stdin으로 등록하고 실행 프로세스 메모리에서만 사용했다.
- 원천 관측 `2026-09-30T22:55:34.446Z` (2026-10-01 KST): 전체 목록 108대 / 2페이지, API `stale=false`. 상태 AVAILABLE 101 / UNAVAILABLE 4 / PREPARING 2 / RESERVED 1. source digest `8dc5c186a4ea7e682068ae7f064751a4ad1871661ae3f7fc71af3468f52d41ae`.
- 실제 공식 목록/상세/availability/rates 조회 성공. 요금 샘플 24개, 목록 사진 참조 보유 52대. 사진 보유 차량 상세 샘플에 사진 47개; 인증 사진 샘플 HTTP 200, image/jpeg, 490351 bytes. 전 차량 사진/요금 수집 완료를 뜻하지 않는다.
- 초기 목록 probe는 HTTP 200 뒤 Windows PTY 종료 오류로 process exit 1이었다. 이후 Secret readback 및 실제 클라이언트 목록/상세/요금/사진 재조회는 exit 0으로 별도 확인했다.
- 안전 보강: 공식 origin 외 credential 전송 금지, RFC3339 offset 필수, capturedAt 기준 15분 초과/60초 이상 미래 timestamp 및 페이지 total drift는 HOLD. 페이지 상한 1,000. 전용 회귀 16 PASS, build PASS.
- Claude 독립 검토 ANSWERED/exit 0: 공식 origin 고정과 신선도 검사 방향에 동의했으나 fixture 벽시계 의존, 0초 skew, timezone 누락, pagination 상한 반례를 발견했다. Date-only 고정 테스트/60초 제한 skew/offset 필수/상한 및 회귀검사로 수정했다. 마지막 페이지 page_size가 반환 개수일 수 있다는 제안은 total drift만 검증하도록 반영했다. 실제 원천 대수의 독립 대사와 Canonical/운영 전환은 여전히 HOLD다.
- 남음: provider stable ID와 기존 차량/정책 연결의 검증된 mapping, 상세 요금/계약조건/사진의 전체 수집과 원천 범위 증거, reviewed Canonical 반영, 전용 writer/runtime secret binding, ERP/운영시트 실제 readback. 이번 연결 확인은 READ VERIFIED이며 RAW/CANONICAL/DEPLOYMENT/CUTOVER 완료가 아니다.

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

RP031 재고 정본은 이안카 시스템 하나다(2026-10-04 사용자 결정). ONE API가 기본이고, ONE API가 막히면 같은 ERP의 로그인 `/api/inventory`를 기존 열쇠로 대체 사용한다([대체 순서](IANCAR-SOURCE-CAPTURE.md)). Google Sheet(`이안카_프리패스`)/F54/F86과 ERP4 DOM/요금 스크랩은 **원천 authority가 아니며** fallback으로도 쓰지 않는다.

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

### 운영 기준 — 2026-10-04 사용자 결정

- **정본:** 이안카 재고는 이안카 시스템 하나만 본다. ONE API가 기본이고, ONE API가 막히면 같은 ERP의 우리 계정 로그인 `/api/inventory`를 기존 열쇠로 대체 사용한다([대체 순서](IANCAR-SOURCE-CAPTURE.md)). 공급사 원본 구글 시트(`이안카_프리패스`)·F54는 출처가 아니다.
- **신선도 15분 유지:** 공급사 `stale=true` 또는 `synced_at`이 15분을 넘으면 그 회차는 HOLD하고 마지막 정상 자료를 그대로 둔다. 기준을 늘리지 않는다 — 오래된 재고를 출고 가능으로 보여 주는 위험이 더 크다. 우리 기준만 늘려도 공급사가 직접 다는 `stale=true` 때문에 막히므로 효과도 없다.
- **10-03 관측:** 공급사 `syncedAt`(UTC) 04:55 → 05:13 → 06:34 → 07:36 → 08:44 → 14:29 → 14:56. 갱신 간격 20~60분, 08:44~14:29(한국시간 17:44~23:29) 약 6시간 공백. 같은 날 대체 출처(원본 시트 09-23 수정, 공개 사이트·로그인 경로는 같은 ERP)를 조사했으나 더 최신 출처는 없었다.
- **공급사 문의:** 갱신 주기·공백 사유 문의를 확인 동선용으로 준비했다. 발송은 대표 확인 뒤(2026-10-04 기준 미발송). 답을 받으면 신선도 기준을 다시 판단한다.
- **실패 원인 구분:** 사진 상세 검증 오류를 `IANCAR_PHOTO_IDENTITY_MISMATCH` / `IANCAR_PHOTO_DETAIL_STALE` / `IANCAR_PHOTO_LIST_MISSING` / `IANCAR_PHOTO_LIMIT_EXCEEDED` 네 코드로 나눴다([#293](https://github.com/freepass-creator/freepass-data/pull/293)). 운영 로그에 찍히려면 ERP4가 고정한 Data 실행기 버전을 올려야 한다.

재고 상태는 `AVAILABLE / RESERVED / RENTED / PREPARING / UNAVAILABLE`을 그대로 보존한다. `available_from=null` 등 미확인 값은 추정하지 않는다.

2026-10-01 사용자 직접 결정: 예약 `RESERVED`의 ERP·Admin·F01/F86 공통 표시값은 **계약중**이다. 호환 projection은 `vehicle_status/status=계약중`, `status_kind=선점`, `available=false`, `source_inventory_status=RESERVED`로 보존한다. 출고가능으로 표시하지 않으며 실제 계약 레코드·계약 ID·계약 잠금을 만들어내지 않는다. 기존 adapter의 `projectIancarOneReservation(payload, capture)`은 이 표시 규칙만 준비하며, 신선도 검증된 source를 소비처에 발행하는 writer는 아직 미연결이다. 수집기가 계산한 `readyForRawIngest=true`와 envelope `stale=false`를 모두 요구하며 행의 자체 stale 값으로 신선도 검증을 대체하지 않는다. 미검증 capture 또는 available 모순은 HOLD다. 이 규칙 확정으로 현재 withdrawal guard나 전량 검증 HOLD를 해제하지 않는다.

## 요금·보증금·계약조건

### 2026-10-01 사용자 결정 — 차량번호·대여료 우선, 정책 후속

후속 사용자 결정: 공급사가 15분 단위로 갱신하므로 실시간 벽시계 대수의 순간 차이는 허용하고 다음 동기화에서 따라잡는 eventual convergence가 목적이다. 공급사 갱신 시각만 바뀌고 ID/차량번호/상태/판매가능일 사실이 같으면 수집을 실패시키지 않는다. 각 응답의 15분 신선도/미래 시각/원천 역행은 별도로 검사하며 시작·종료 관측 창을 `BOUNDED_OBSERVATION_NOT_ATOMIC`으로 보존한다. 실제 차량 집합·상태 차이는 해당 회차 재대사 대상이다. 같은 발행본의 소비처 parity는 계속 정확히 검사한다. 순간 최신 원천과 이전 성공 발행본의 차이를 영구 오류로 세거나 대수를 맞추려고 임의 삭제하지 않는다. 이 규칙 변경은 운영 writer/15분 스케줄러 활성화를 대신하지 않는다.

- 1차는 공식 API 차량번호와 차량별 월 대여료를 연결한다. 계약기간·약정거리·월/연 기준·VAT는 대여료의 식별 차원이므로 같이 보존한다. 최저가 하나로 축약하거나 미제공 6개월 요금을 만들지 않는다.
- 정책 보강/연결은 2차다. 기존 S01~S04 또는 공통 정책을 최신 API 정책으로 확인된 것처럼 표시하지 않는다. 정책 후속 단계에서 카드결제, 해지 산식, 연령, 심사·서류, 보험, 정비 등 전체 항목을 다룬다.
- 이안카 ERP 원천과 화이트라벨 이안카의 **차량 집합 및 상태별 대수**가 같아야 한다. 숫자 합계만 같은 것은 PASS가 아니다. 예약은 `계약중` 표시이며 원천 RESERVED를 보존한다. 전체 재고와 출고가능 필터를 다른 모수로 비교하지 않는다.
- 동일 sourceDigest/syncedAt의 차량 ID·차량번호·원천 상태·표시 상태·관측된 기간/거리별 요금 전부를 실제 소비처 readback과 대조한다. API의 미관측 기존 재고는 삭제하지 않고 별도로 보존한다. 새로운 snapshot이면 다시 대사한다.
- 준비 함수 `projectIancarOnePhaseOne`은 정책·보증금·계약락·공개 여부를 수정하지 않는 REVIEW ONLY payload다. `compareIancarOnePhaseOneParity`는 snapshot/차량/상태/요금 검증 gate이며, 운영 writer와 실제 소비처에 연결하기 전에는 cutover 완료가 아니다.
- 조회 명령: `npm run source:iancar:one -- --phase-one --save-private`. Secret은 실행 프로세스 메모리에서만 주입한다. 기본 실행은 공개/DB 쓰기를 수행하지 않는다. API 503/429 및 source drift는 HOLD이며 과거 캡처로 우회하지 않는다.
- `--phase-one`은 목록과 차량별 요금 GET만 수집한다. 상세·availability·정책 GET은 하지 않는다. 요금 귀속은 `REQUEST_PATH_BOUND_BY_LIST_ID`로 명시하며 상세 echo 검증과 혼동하지 않는다. 수집 후 마지막 목록의 상태를 사용하고 새 ID/번호 변경은 최대 3회 목록 대사에서 요금을 추가 조회한다. 계속 늘어나는 미조회 ID는 HOLD이며 추정 요금·삭제를 만들지 않는다. 요금 GET 관측도 15분/미래60초를 검사한다. PHASE_ONE_FACTS RAW coverage는 UNKNOWN이며 정책·원천 부재 권한이 없다.

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

### 동기화 잠금 상품 격리 — 2026-10-10

`--sync --apply-sync`는 계약 잠금 또는 삭제 표시가 있는 관측 상품만 반영 대상에서 제외한다. 제외 상품에는 쓰기를 하지 않으며 기존 상태·가격·사진·증거·잠금을 그대로 보존한다. 신원 불일치, 번호판/소스 식별자 충돌, 중복, 신선도 오류는 여전히 전체 실패다. 동시 변경 감지와 백업·되읽기 검증도 유지한다.

- 영수증/collector `publication`: `skippedCount`, `skippedByReason`, `skippedRatio`, `maxSkippedRatio`, `warnings`. 사유는 `CONTRACT_LOCK`, `DELETION_LOCK`, `CONTRACT_AND_DELETION_LOCK` 중 하나이며 중복 집계하지 않는다. 새 공개 필드는 건수·코드만 포함한다.
- 분모는 이번 원천의 전체 관측 상품 수다. `IANCAR_PUBLICATION_MAX_LOCK_SKIP_RATIO` 한 상수에서 0.20을 정의한다. 정확히 20%까지 경고와 성공 종료(0), 초과하면 `IANCAR_PUBLICATION_LOCK_SKIP_RATIO_EXCEEDED`로 백업·쓰기 전에 전체 실패한다.
- `matched`/`created`와 `open`/사진 건수는 제외 후 반영 대상 기준이다. `sourceCount`는 제외 전 원천 수다. 잠금 상품의 오래된 증거가 갱신됐다고 보고하지 않는다.
- 원천 미관측 이력의 기존 잠금 보존 규칙은 유지하며 위 비율의 분모·분자에 넣지 않는다. 계획 digest에 제외 집합과 revision을 묶고 거래 시 전체 revision을 다시 검사한다.

## 운영 개통 순서

1. 사용자 승인된 provider key를 사용한다. 2026-10-01 기존 키 사용 결정과 Secret version 1 등록을 확인했다.
2. 키를 Git/명령행/브라우저가 아닌 FreePass Data runtime Secret에서 실행 프로세스로만 주입한다.
3. 첫 live read에서 전체 목록의 `total/synced_at/stale` 및 schema shape를 확인한다.
4. 차량 상세·요금·계약조건 schema를 값이 없는 shape 보고서로 확인한다.
5. allowlist 기반 Canonical mapper를 확정한다.
6. ONE API → Data Canonical → ERP.com/Admin의 같은 vehicle_id/상태/기간·거리별 요금 readback을 대사한다.
7. 대사 후 RP031의 Sheet/ERP4 fallback을 종료한다. 로그인 `/api/inventory`는 ONE API가 막힐 때만 쓰는 대체 경로로 남긴다(2026-10-04 사용자 결정).
8. 이후 Data-owned scheduler에서 15분 freshness 기준으로 수집/감시한다.

사용자가 최종 결정한 운영 기준은 **ONE API → FreePass Data → ERP 직접 연동**이다. 이안카 시트를 다시 운영 원천으로 승격하지 않는다.
