# 공개 상품 응답 설계

상태: DESIGN / 2026-10-10

목적: ERP5가 읽는 ERP4 `/api/catalog/feed`와 `/api/catalog/quote`를 FreePass Data가 대신 내보내 ERP4 데이터 서버 의존을 끊는다. 인증 없는 공개 상품 목록과 공개 상품 안내만 다루며 수수료, 내부 원가, 정산, writer, Canonical ACTIVE 전환은 범위 밖이다.

재사용 판정: `CREATE_NEW_JUSTIFIED`. 기존 문서는 소비처 전환 준비와 상위 계약이고, ERP4 공개 feed/quote 응답을 Data 공개 라우트로 대체하는 단일 설계서는 없다. 구현은 기존 `src/infra/erp5-compat-catalog-reader.ts`, `withCompatibilityDepositEvidence`, `src/domain/deposit-evidence.ts`의 `resolveDepositWithRuleNote`와 ERP4 공개 allowlist 계약을 재사용한다.

## 1. ERP4 feed 응답 계약 v1

기존 ERP4 라우트는 `GET /api/catalog/feed?p={providerCode}&wl={whitelabel}`이고 인증 없이 호출된다. 응답 헤더는 `Cache-Control: no-store`다.

| 최상위 키 | 형 | 설명 |
|---|---|---|
| `contractVersion` | string | ERP4 `FREEPASS_CATALOG_CONTRACT_VERSION`, 현재 `1.0` |
| `count` | integer | `products.length` |
| `products` | array | 공개 allowlist를 지난 상품 목록 |
| `brand` | string | `p`/`wl`로 공급사 또는 화이트라벨이 확정될 때 노출할 표시명, 없으면 빈 문자열 |

| 쿼리 | 동작 |
|---|---|
| `p` | 공급사 코드. `wl`이 공급사 고정 채널이면 채널 fence가 우선하고, 그 외에는 해당 `provider_company_code` 또는 `partner_code` 상품만 반환한다. |
| `wl` | 화이트라벨 채널. host 또는 쿼리에서 채널을 결정하고, 채널이 팔 수 없는 상품은 목록/상세에서 제외한다. |
| `a` | feed 주석상 영업 사용자 코드이나 공개 응답에는 개인정보를 싣지 않는다. quote에서 링크 보존용으로만 받는다. |

| 상품 허용 칸 | 형 | 출처 products 칸 | 내용 제한 |
|---|---|---|---|
| `publicProductKey` | string | 공개용 상품 키 | 1~80자, `^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$`. 내부 UID(`va_...`), Firestore 문서 ID, collection path, RAW/source ID를 쓰지 않는다. ERP4 호환 규칙의 유일한 예외로 추가하는 칸이며 ERP5는 읽지 않아도 된다. |
| `_key`, `product_code` | string | ERP4 공개 호환 키 | ERP4 공개 feed/quote가 현재 손님에게 내는 값과 호환되는 별칭. 새 구현 내부에서는 `publicProductKey`를 canonical 공개 식별자로 쓰고, `_key`/`product_code`에는 내부 UID를 넣지 않는다. |
| `car_number` | string|null | 동명 | ERP4 공개 feed/quote가 현재 손님에게 내는 범위만 그대로 호환한다. `ERP4 공개 feed의 필드 이름 목록과 대조` 검증에서 현재 feed에 없는 차량번호 칸 또는 변형 칸은 v1에 넣지 않는다. |
| `maker`, `model`, `sub_model`, `trim_name`, `trim_extra`, `variant`, `vehicle_class`, `fuel_type`, `engine_type`, `drive_type`, `transmission`, `usage`, `ext_color`, `int_color`, `accident_history`, `cert_car_name`, `location`, `provider_name` | string|null | 동명 | 정제 문자열 0~80자. 제어문자, HTML, URL, 내부 경로, 계정, 토큰, 시트 ID 금지. |
| `year`, `engine_cc`, `seats`, `mileage`, `battery_capacity`, `annual_mileage` | number|null | 동명 | 정수 또는 소수 1자리까지의 수치. 음수 금지. 미확인은 `null`. |
| `first_registration_date` | string|null | 동명 | `YYYY-MM` 또는 `YYYY-MM-DD`. 미확인은 `null`. |
| `note`, `options`, `deposit_note` | string|null | 동명 | 고객 안내용 정제 문자열 0~300자. 줄바꿈은 공백으로 접고, 내부 금지어/금액 패턴 검사 통과분만 허용. |
| `product_type` | enum|null | 동명 | `NEW_SUBSCRIPTION`, `USED_SUBSCRIPTION`, `RENTAL`, `LEASE`, `UNKNOWN_PUBLIC_TYPE` 중 하나. 원천 값이 다르면 공개 매핑표에 없으면 `UNKNOWN_PUBLIC_TYPE`. |
| `vehicle_status` | enum|null | 동명 | `AVAILABLE`, `CONSULT_REQUIRED`, `CONTRACTING`, `UNAVAILABLE`, `UNKNOWN` 중 하나. 내부 진행 상태를 그대로 복사하지 않는다. |
| `insurance_included` | boolean|null | 동명 | true/false/null만 허용. |
| `price` | object | `price` | key는 `^[0-9]{1,3}(_[A-Za-z0-9가-힣.-]{1,20})?$`. 값은 `{ rent:number|null, deposit:number|null, depositState:enum }`만 허용. `fee`와 내부 수수료 칸은 제거. |
| `image_url`, `image_urls`, `photo_link` | string|null 또는 string[] | `image_urls`, `images`, `photos`, `photo_cache`, `photo_link` | `https://` URL만 허용, 단일 URL 500자 이하, 배열 최대 20개. feed 목록은 ERP4처럼 `slimForList`로 `image_urls`를 뺄 수 있다. |
| `_policy` | object|null | `policy` 문서 | 아래 정책 허용 칸과 하위 타입만 허용. `additionalProperties:false`. |

공개 응답에는 `vin`을 절대 넣지 않는다. 원천에 VIN이 있어도 allowlist, schema, fixture, snapshot 비교 결과 모두에서 금지한다.

정책 허용 칸은 아래 하위 스키마만 쓴다. 공개 응답의 정책 값은 정해진 공개 코드 enum과 number 필드만 허용하며, 비율 문자열은 내보내지 않는다. 비율이 필요한 정책은 문자열이 아니라 정해진 코드로 바꿔 쓴다.

| 정책 칸 | 형 | 내용 제한 |
|---|---|---|
| `policy_name`, `policy_type`, `payment_method`, `payment_timing`, `penalty_condition`, `rental_region`, `screening_criteria`, `basic_driver_age`, `driver_age_lowering`, `driver_age_upper_limit`, `license_period`, `personal_driver_scope`, `business_driver_scope`, `maintenance_service`, `credit_grade` | enum|null | 정해진 공개 코드만 허용. 자유 문자열, 비율 문자열, 내부 문구는 내보내지 않는다. |
| `insurance_included`, `deposit_installment`, `deposit_card_payment`, `rental_card_payment`, `roadside_assistance` | boolean|null | true/false/null만 허용. |
| `injury_compensation_limit`, `injury_deductible`, `property_compensation_limit`, `property_deductible`, `self_body_accident`, `self_body_deductible`, `personal_injury_compensation_limit`, `personal_injury_deductible`, `uninsured_compensation_limit`, `uninsured_deductible`, `own_damage_compensation`, `own_damage_min_deductible`, `own_damage_max_deductible`, `annual_roadside_assistance`, `annual_mileage`, `max_annual_mileage`, `mileage_upcharge_per_10000km`, `age_lowering_cost`, `additional_driver_allowance_count`, `additional_driver_cost`, `deposit_return_days`, `buyout_notice_days` | number|null | 0 이상. 금액/일수/횟수처럼 고객에게 공개되는 정책값만 허용. |
| `uninsured_damage`, `own_damage_repair_ratio`, `own_damage_compensation_rate` | enum|null 또는 number|null | 비율은 0~100 number만 허용한다. 표시가 필요한 비율 정책은 정해진 공개 코드로 바꿔 쓰며 `%` 포함 문자열은 내보내지 않는다. |

구조적으로 금지할 칸: `fee`, `fee_rate`, `agent_payout_rate`, `commission_*`, `supplierBillingFee`, `channelPayoutFee`, `vehicle_price`, `provider_company_code`, `partner_code`, `partner_memo`, `sales_notes`, `source`, `sheet_meta`, RAW/provenance/audit/IAM 필드, 내부 collection path.

문자열 값 생성 검사는 모든 칸에 공통 적용한다. 값 안에 `수수료`, `청구`, `지급`, `마진`, `commission`, `payout` 또는 숫자 금액 패턴(`\d[\d,]*(원|만원|%|KRW)`)이 있으면 응답 생성은 실패해야 한다. 예외는 `rent`, `deposit`, 고객 공개 보험/정책 보상 한도처럼 스키마가 number로 지정한 칸뿐이며, 정책 비율도 문자열로 우회 표기하지 않는다.

## 2. quote 응답 계약 v1

기존 ERP4 라우트는 `GET /api/catalog/quote?code={segment}&a={share}&wl={whitelabel}`이고 인증 없이 호출된다.

| 요청 쿼리 | 필수 | 설명 |
|---|---:|---|
| `code` | 예 | `/q/{code}` 조각. `_key`, `product_code`, share token, `{token}-{agent}` 형태를 기존 규칙으로 찾는다. |
| `a` | 아니오 | 영업 공유 코드. 개인정보 조회에는 쓰지 않고 링크 보존만 한다. |
| `wl` | 아니오 | 채널 fence. 해당 채널이 팔 수 없는 상품이면 404. |

| 상태 | 본문 |
|---|---|
| 200 | `{ "product": FreepassCatalogProduct }` |
| 400 | `{ "error": "상품 코드가 없습니다." }` |
| 404 | `{ "error": "현재 안내 가능한 상품이 아닙니다." }` |
| 503 | `{ "error": "상품 안내를 불러오지 못했습니다." }` |

`product`는 feed와 같은 allowlist를 통과하지만 상세용으로 `image_urls`를 유지할 수 있다.

## 3. FreePass Data 구현 위치

현재 `src/api/consumer-gateway.ts`의 `/v1/consumers/:consumerId/catalog`와 `/catalog-compat`는 Bearer 토큰 인증 뒤에 있다. 새 공개 응답은 대표 결정상 인증 없이 읽어야 하므로 같은 Fastify app 안에 인증 게이트 앞의 별도 public route로 둔다.

| 라우트 | 인증 | 내부 reader |
|---|---|---|
| `GET /v1/public/catalog/feed?p=&wl=` | 없음 | `compatReader.read(publicConsumerId)` |
| `GET /v1/public/catalog/quote?code=&a=&wl=` | 없음 | 같은 snapshot에서 상품 1건 resolve |

`publicConsumerId`는 `wl`에 따라 `erp-com` 또는 `whitelabel-{key}`로 서버가 결정한다. 요청자가 consumerId, collection, projection, source path를 고르지 못하게 한다.

새 파일 최소화:

| 파일 | 용도 |
|---|---|
| `src/api/public-product-feed.ts` | ERP4 `public-catalog.ts`와 `guest-quote.ts`의 공개 allowlist/resolve 규칙을 Data 쪽 순수 함수로 이식 또는 adapter화 |
| `src/api/consumer-gateway.ts` | 공개 route 등록만 추가 |
| `contracts/public-product-feed-v1.schema.json` | allowlist 응답 스키마. `additionalProperties:false`로 내부 칸 통과를 구조적으로 차단 |
| `tests/public-product-feed.test.ts` | allowlist, p/wl fence, quote resolve, 내부 칸 차단, 보증금 증거 비교 |

허용 목록 방식: 입력 product/policy를 그대로 spread하지 않는다. `PUBLIC_PRODUCT_FIELDS`, `PUBLIC_POLICY_FIELDS`, `publicPrice`처럼 이름 있는 allowlist 배열만 순회해 새 객체를 만든다. 스키마도 allowlist 칸만 열고 모든 object에 `additionalProperties:false`를 둔다. `unknown` 형은 쓰지 않는다. 수수료/내부 칸은 타입 검사가 아니라 출력 생성 경로와 스키마 양쪽에서 불가능해야 한다.

## 4. 보증금 처리

새 계산 금지. Data는 이미 `withCompatibilityDepositEvidence(product)`가 `resolveDepositWithRuleNote`를 호출한다. 공개 feed/quote는 이 호환 응답을 받은 뒤 `price.*.deposit`만 공개 allowlist로 복사한다.

ERP4의 `depositFromRule` 사본은 display helper였고, 0 보증금을 보면 규칙 문자열에서 값을 계산할 수 있었다. Data의 새 기준은 evidence다. 자리표시자 0은 무보증 확정이 아니며, 근거가 없으면 `UNKNOWN`이다.

| 상황 | ERP4 display helper | Data 공개 응답 |
|---|---|---|
| source deposit 양수, 충돌 없음 | 양수 유지 | `deposit:number`, `depositState:"AMOUNT"` |
| 명시 무보증 근거 있음 | 0 | `deposit:0`, `depositState:"VERIFIED_NO_DEPOSIT"` |
| source deposit 0 + 공급사 규칙 note + 기간/월렌트 확인 | 규칙 계산값 | `deposit:number`, `depositState:"AMOUNT"` |
| source deposit 0 + 규칙/근거 없음 | 0처럼 보일 수 있음 | `deposit:null`, `depositState:"UNKNOWN"` |
| 양수와 규칙 note 충돌 | 양수 또는 규칙값으로 보일 위험 | `deposit:null`, `depositState:"UNKNOWN"` |
| 해당 상품/기간에 보증금 개념이 없음 | 빈 값 또는 0처럼 보일 수 있음 | `deposit:null`, `depositState:"NOT_APPLICABLE"` |
| RP031 Iancar | ERP4 로컬 helper 범위 밖 | `readIancarPublishedDeposit` 검증 통과 시 `AMOUNT` 또는 `VERIFIED_NO_DEPOSIT`, 아니면 `UNKNOWN` |

공개 v1의 `price.*.deposit`은 `number|null`이다. `depositState`는 항상 함께 싣고 값은 `AMOUNT`, `VERIFIED_NO_DEPOSIT`, `UNKNOWN`, `NOT_APPLICABLE` 네 가지뿐이다. 이 값은 운영 중인 ERP4 #562 형식과 맞춘다. 미확인을 0으로 내보내면 안 된다.

## 5. 증명 계획

읽기 전용 비교 스크립트 제안: `scripts/compare-public-product-feed.mjs`.

| 인자 | 설명 |
|---|---|
| `--erp4-base` | 기존 ERP4 서버 주소 |
| `--data-base` | 새 FreePass Data 공개 주소 |
| `--wl` | 채널 |
| `--p` | 공급사 코드, 선택 |
| `--sample` | 같은 차 N대. 기본 30, 공급사/기간/보증금 상태가 섞이게 선택 |
| `--out` | 비공개 evidence JSON 경로 |

검사: feed HTTP status, 최상위 키, `contractVersion`, `count`, `brand`, `product_code` 기준 교집합과 누락/추가, 각 상품의 공개 key 집합, 내부 금지 칸, `price` term key/rent/deposit/depositState, quote의 200/404 동작을 비교한다.

허용 차이: 보증금 개선분만 허용한다. ERP4가 0 또는 규칙 미적용 값이고 Data가 `resolveDepositWithRuleNote` 근거로 양수/UNKNOWN을 낸 경우만 `ALLOWED_DEPOSIT_EVIDENCE_IMPROVEMENT`로 기록한다. rent, count, 상품 존재, 채널 fence, 내부 칸 차이는 허용하지 않는다.

ERP4 공개 feed/quote 호환 검증은 필수다. 현재 ERP4 공개 feed의 필드 이름 목록과 v1 schema를 대조하고, 현재 feed에 없는 칸은 v1에 넣지 않는다. 단, `publicProductKey` 하나만 ERP4 호환 규칙의 유일한 예외로 추가하며 ERP5는 이 칸을 읽지 않아도 된다. 특히 `vin`은 현재 여부와 관계없이 금지하고, `car_number`는 ERP4가 손님에게 이미 내는 범위만 유지한다.

ERP5 소비처 호환 검증도 필수다. ERP5가 목록 응답과 상세 응답에서 읽는 필드 이름을 아래 표로 고정하고, v1이 모두 채우는지 같은 차로 ERP4 응답과 비교한다.

| ERP5 사용처 | 필드 이름 | v1 의무 |
|---|---|---|
| 목록 카드/검색 | `product_code`, `publicProductKey`, `maker`, `model`, `sub_model`, `trim_name`, `year`, `fuel_type`, `mileage`, `vehicle_status`, `price`, `image_url`, `provider_name` | 모두 제공. 값 미확인은 타입에 맞는 `null`만 허용. |
| 상세 안내 | 목록 필드 + `trim_extra`, `variant`, `car_number`, `first_registration_date`, `engine_type`, `engine_cc`, `drive_type`, `seats`, `transmission`, `usage`, `ext_color`, `int_color`, `accident_history`, `cert_car_name`, `location`, `note`, `options`, `insurance_included`, `annual_mileage`, `deposit_note`, `_policy`, `image_urls`, `photo_link` | ERP4 공개 feed/quote에 존재하는 이름만 v1에 포함하고 같은 차 비교에서 누락 0이어야 한다. |
| 보증금 표시 | `price.*.deposit`, `price.*.depositState` | `depositState` 항상 존재. `deposit:null`이면 `UNKNOWN` 또는 `NOT_APPLICABLE`만 허용. |

추가 시험 항목:

1. `unknown` schema가 하나도 남지 않는지 schema lint로 확인한다.
2. 모든 object가 `additionalProperties:false`인지 확인한다.
3. `note`, `options`, `deposit_note`, 정책 문자열 값에 `수수료`, `청구`, `지급`, `마진`, `commission`, `payout`, 금액 패턴이 들어가면 응답 생성이 실패하는 fixture를 둔다.
4. `vin`, 내부 UID(`va_...`), Firestore path, 시트 ID, 계정, 토큰, RAW/provenance 필드가 입력에 있어도 출력에는 없고, schema snapshot에서도 금지되는지 확인한다.
5. 같은 차 N대를 ERP4 공개 feed/quote와 Data v1로 비교해 ERP5 목록/상세 필드 누락 0, rent/count/channel fence 차이 0을 증명한다.

## 6. 요청 제한과 캐시

현재 확인된 상태: ERP4 route는 `Cache-Control: no-store`이고, ERP4 FreePass Data compat client는 `FREEPASS_DATA_COMPAT_CACHE_MS` 기본 60초 in-memory cache를 둔다. Data gateway의 `/catalog-compat`도 `Cache-Control: no-store`다. Data 쪽 공개 요청 제한 구현은 확인되지 않았다.

| 항목 | 설계 |
|---|---|
| 응답 헤더 | cutover 증명 전 `Cache-Control: no-store`. 안정화 뒤 `public, max-age=30, stale-while-revalidate=60`은 별도 결정. |
| 내부 캐시 | consumerId+`p`+`wl`별 30~60초 process cache. 원본 Firestore read 폭주 방지. |
| 크기 제한 | feed gzip 1MB 또는 products 5,000대 초과 시 503 `PUBLIC_FEED_TOO_LARGE`; quote 단건 512KB 초과 시 503. |
| 요청 제한 | IP+route 기준 60초 120회, 초과 시 429와 `Retry-After: 30`. Cloud Run 앞 CDN/WAF가 있으면 그 계층에서 우선 적용. |
| 타임아웃 | Firestore/read adapter 2초 목표, 5초 hard timeout. timeout은 stale 추정으로 대체하지 않고 503. |

## 7. 단계와 날짜

오늘 기준 2026-10-10.

| 날짜 | 단계 | 완료 증거 |
|---|---|---|
| 2026-10-10 | 설계 | 이 문서와 `NEXT-START-HERE` 한 줄 |
| 2026-10-11~12 | 구현 PR | 공개 route, allowlist schema, 보증금 재사용 테스트, 내부 칸 차단 테스트, 민감 문자열/금액 패턴 차단 테스트 |
| 2026-10-12 | 증명 | ERP4 vs Data feed/quote 읽기 전용 비교 evidence, ERP5 목록/상세 필드 대조, 허용 차이는 보증금 개선분만 |
| 2026-10-13 | ERP5 주소 전환 | ERP5/ERP.com이 새 Data 공개 주소를 읽는 배포 revision과 실응답 readback |
| 2026-10-14 | ERP4 데이터 응답 끄기 제안 | ERP4 `/api/catalog/feed`와 `/quote`가 Data proxy 또는 410/redirect 정책으로 정리된 readback |

## 8. 전환 뒤 폐기 목록

| ERP4 대상 | 처리 |
|---|---|
| `app/api/catalog/feed/route.ts` | Data 공개 feed proxy로 축소 후 안정화 뒤 삭제 |
| `app/api/catalog/quote/route.ts` | Data 공개 quote proxy로 축소 후 안정화 뒤 삭제 |
| `lib/server/guest-listing.ts` | Data 공개 feed client로 대체 |
| `lib/server/guest-quote.ts` | Data 공개 quote client로 대체 |
| `lib/domain/public-catalog.ts` | Data allowlist 계약으로 이동 후 ERP4 사본 삭제 |
| `lib/domain/freepass-catalog-contract.ts` | Data 계약 패키지 또는 generated schema client로 대체 |
| `lib/domain/product.ts`의 `displayDeposit`/`depositFromRule` 의존 | 공개 응답 경계에서는 제거. 내부 화면 helper가 필요하면 별도 유지 여부 결정 |
| `FREEPASS_DATA_COMPAT_CACHE_MS`, ERP4 compat read env | ERP4가 public data server 역할을 그만두면 제거 |
| shadow-only 문서 | 전환 증명 문서로 흡수하고 stale shadow 문구 삭제 |

## 9. 열린 질문

1. 안정화 뒤 CDN 캐시를 켤지, 계속 `no-store`로 둘지 결정 필요.
2. ERP4 종료일 2026-10-14에 route를 삭제할지, 짧은 기간 Data proxy로 남길지 결정 필요.
