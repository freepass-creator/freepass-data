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

| 상품 허용 칸 | 형 | 출처 products 칸 | 비고 |
|---|---|---|---|
| `_key`, `product_code` | string | 문서 ID, `_key`, `product_code` | 공개 식별자. 내부 collection path는 노출하지 않는다. |
| `car_number`, `vin` | unknown | 동명 | 차량 식별. VIN은 기존 계약에 있으나 공개 최소화 관점에서 열린 질문이다. |
| `maker`, `model`, `sub_model`, `trim_name`, `trim_extra`, `variant` | unknown | 동명 | 차량명 표시용. |
| `vehicle_class`, `year`, `first_registration_date`, `fuel_type`, `engine_type`, `engine_cc`, `drive_type`, `seats`, `transmission`, `usage`, `battery_capacity` | unknown/number | 동명 | 제원 표시용. |
| `ext_color`, `int_color`, `mileage`, `accident_history`, `cert_car_name`, `location`, `note`, `options` | unknown | 동명 | 고객 표시 정보. |
| `product_type`, `vehicle_status` | unknown | 동명 | 목록 필터/상태 표시. |
| `insurance_included`, `annual_mileage`, `deposit_note`, `provider_name` | unknown | 동명 | 고객 안내 조건. 공급사 코드는 제외하고 표시명만 허용. |
| `price` | object | `price` | key는 `12`, `24_2만` 같은 기간/조건 키. 값은 `{ rent:number, deposit:number }`만 허용. `fee`는 제거. |
| `image_url`, `image_urls`, `photo_link` | string/array | `image_urls`, `images`, `photos`, `photo_cache`, `photo_link` | feed 목록은 ERP4처럼 `slimForList`로 `image_urls`를 뺄 수 있다. quote는 상세 갤러리용으로 유지한다. |
| `_policy` | object | `policy` 문서 | 정책 allowlist만 허용. |

정책 허용 칸: `policy_name`, `policy_type`, `insurance_included`, `injury_compensation_limit`, `injury_deductible`, `property_compensation_limit`, `property_deductible`, `self_body_accident`, `self_body_deductible`, `personal_injury_compensation_limit`, `personal_injury_deductible`, `uninsured_damage`, `uninsured_compensation_limit`, `uninsured_deductible`, `own_damage_compensation`, `own_damage_repair_ratio`, `own_damage_compensation_rate`, `own_damage_min_deductible`, `own_damage_max_deductible`, `annual_roadside_assistance`, `roadside_assistance`, `annual_mileage`, `max_annual_mileage`, `mileage_upcharge_per_10000km`, `deposit_installment`, `deposit_card_payment`, `rental_card_payment`, `payment_method`, `payment_timing`, `penalty_condition`, `rental_region`, `delivery_fee`, `screening_criteria`, `basic_driver_age`, `driver_age_lowering`, `age_lowering_cost`, `driver_age_upper_limit`, `license_period`, `personal_driver_scope`, `business_driver_scope`, `additional_driver_allowance_count`, `additional_driver_cost`, `maintenance_service`, `deposit_return_days`, `buyout_notice_days`, `credit_grade`.

구조적으로 금지할 칸: `fee`, `fee_rate`, `agent_payout_rate`, `commission_*`, `supplierBillingFee`, `channelPayoutFee`, `vehicle_price`, `provider_company_code`, `partner_code`, `partner_memo`, `sales_notes`, `source`, `sheet_meta`, RAW/provenance/audit/IAM 필드, 내부 collection path.

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

허용 목록 방식: 입력 product/policy를 그대로 spread하지 않는다. `PUBLIC_PRODUCT_FIELDS`, `PUBLIC_POLICY_FIELDS`, `publicPrice`처럼 이름 있는 allowlist 배열만 순회해 새 객체를 만든다. 스키마도 allowlist 칸만 열고 `additionalProperties:false`를 둔다. 수수료/내부 칸은 타입 검사가 아니라 출력 생성 경로와 스키마 양쪽에서 불가능해야 한다.

## 4. 보증금 처리

새 계산 금지. Data는 이미 `withCompatibilityDepositEvidence(product)`가 `resolveDepositWithRuleNote`를 호출한다. 공개 feed/quote는 이 호환 응답을 받은 뒤 `price.*.deposit`만 공개 allowlist로 복사한다.

ERP4의 `depositFromRule` 사본은 display helper였고, 0 보증금을 보면 규칙 문자열에서 값을 계산할 수 있었다. Data의 새 기준은 evidence다. 자리표시자 0은 무보증 확정이 아니며, 근거가 없으면 `UNKNOWN`이다.

| 상황 | ERP4 display helper | Data 공개 응답 |
|---|---|---|
| source deposit 양수, 충돌 없음 | 양수 유지 | `KNOWN/SOURCE_AMOUNT`, 같은 금액 |
| 명시 무보증 근거 있음 | 0 | `ZERO/EXPLICIT_ZERO_DEPOSIT`, 0 |
| source deposit 0 + 공급사 규칙 note + 기간/월렌트 확인 | 규칙 계산값 | `KNOWN/SUPPLIER_RULE_NOTE:*`, 같은 계산값 |
| source deposit 0 + 규칙/근거 없음 | 0처럼 보일 수 있음 | `UNKNOWN`, 공개 금액은 null 또는 quote 표시에서 미확인으로 처리 |
| 양수와 규칙 note 충돌 | 양수 또는 규칙값으로 보일 위험 | `UNKNOWN/POSITIVE_AMOUNT_WITH_RULE_REQUIRES_REVIEW` |
| RP031 Iancar | ERP4 로컬 helper 범위 밖 | `readIancarPublishedDeposit` 검증 통과 시 `KNOWN/ZERO`, 아니면 `UNKNOWN` |

공개 v1에서 `depositState`, `depositStatusLabel`, `depositEvidenceReason`을 함께 노출할지, ERP4 호환을 위해 `price.*.deposit`만 노출하고 미확인은 `null`로 둘지는 결정 필요다. 단, 미확인을 0으로 내보내면 안 된다.

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

검사: feed HTTP status, 최상위 키, `contractVersion`, `count`, `brand`, `product_code` 기준 교집합과 누락/추가, 각 상품의 공개 key 집합, 내부 금지 칸, `price` term key/rent/deposit, quote의 200/404 동작을 비교한다.

허용 차이: 보증금 개선분만 허용한다. ERP4가 0 또는 규칙 미적용 값이고 Data가 `resolveDepositWithRuleNote` 근거로 양수/UNKNOWN을 낸 경우만 `ALLOWED_DEPOSIT_EVIDENCE_IMPROVEMENT`로 기록한다. rent, count, 상품 존재, 채널 fence, 내부 칸 차이는 허용하지 않는다.

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
| 2026-10-11~12 | 구현 PR | 공개 route, allowlist schema, 보증금 재사용 테스트, 내부 칸 차단 테스트 |
| 2026-10-12 | 증명 | ERP4 vs Data feed/quote 읽기 전용 비교 evidence, 허용 차이는 보증금 개선분만 |
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

1. 공개 price에서 미확인 보증금을 `null`로 내보낼지, 기존 ERP4 shape 유지를 위해 `deposit` 숫자를 유지하되 `depositState`를 추가할지 결정 필요.
2. 공개 응답에 `vin`을 계속 포함할지 결정 필요. ERP4 계약에는 포함되어 있으나 공개 최소화 관점에서는 제거 후보다.
3. 안정화 뒤 CDN 캐시를 켤지, 계속 `no-store`로 둘지 결정 필요.
4. ERP4 종료일 2026-10-14에 route를 삭제할지, 짧은 기간 Data proxy로 남길지 결정 필요.
