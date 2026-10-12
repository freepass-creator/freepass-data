# 상품 전수 조회(상품 도시에) 설계 — 차량번호/상품ID/UID 하나로 프리패스 데이터에 있는 모든 것

대표 10-12: 「조회는 상품당 수집된 모든 정보를 알아야 하고, 수집된 정보가 원천과 정확하게 맞아야 한다」. 내부 조회 전용(읽기만). 공개(ERP5) 응답에는 수수료·내부 칸을 싣지 않는 원칙은 그대로.

## 접근 계약 (구현 필수 조건 — `PERIOD-FEE-TABLE-CONSUMERS.md` 의 «접근 계약»과 같은 한 규칙, 두 문서가 서로 가리킨다)
1. 허용 호출자는 인증된 내부 소비자 id 허용 목록(카톡 조회 `kakao-ops`·어드민 `freepass-admin-catalog`)뿐. 미인증·권한 부족은 거부한다(기본 거부).
2. 권한 검증은 서버 측에서 한다. 호출자가 보낸 신원·권한 선언은 믿지 않고, 인증된 소비자 등록(게이트웨이 바인딩)에서 읽은 권한만 쓴다.
3. 공개 소비자(ERP5·공개 상품 피드·화이트라벨)의 호출은 거부하고 전수 결과를 공개 경로로 전달하지 않는다. 공개 응답 허용 필드 스키마(`additionalProperties:false`)에 dossier 필드(식별정보·원문·청구·지급·원장)가 없음을 시험으로 검증하고, 이 시험은 구현 PR 의 반영 조건이다.
4. 로그와 산출 파일(점검 상세·시험 증거)에는 차량번호 대신 해시(실행마다 다른 salt 의 sha256 앞 12자) 또는 `vehicle_uid` 만 남긴다. 번호가 꼭 필요하면 사람이 실행한 터미널 출력(저장하지 않음)으로만 보여 준다.

## 1. 입력·출력
- 입력: 차량번호(전체) | 끝 4자리(후보 목록 반환) | 상품 문서 ID | `vehicle_uid`.
- 출력 둘, 같은 내용: ① 사람이 읽는 요약 표(칸 이름·값·출처·기준 시각) ② JSON `ProductDossier/v1`.
- 읽기 함수 하나(`readProductDossier`)를 application 에 두고 카톡 응대 조회 도구·어드민이 같은 함수를 쓴다(앞선 연결 설계 `PERIOD-FEE-TABLE-CONSUMERS.md` 에 포함, 수수료 칸은 `readPeriodFeeTable` 를 부분으로 쓴다).

## 2. 칸 묶음과 읽는 곳 (코드·실측 확인: 상품 문서 1,776개의 실제 칸 이름)
| 묶음 | 내용 | 읽는 곳 · 칸 | 출처 라벨 |
|---|---|---|---|
| 기본 | 제조사·모델·세부모델·세부트림·연식·최초등록·주행거리·연료·배기량·인승·구동·색상·옵션·차급·원산지 | `products` : maker·model·sub_model·trim_name·year·first_registration_date·mileage·fuel_type·engine_cc·seats·drive_type·ext_color·int_color·options·vehicle_class·origin | 정제 |
| 식별 | 차량번호·`vehicle_uid`·차대번호·`vehicle_uid_registry` | car_number·vehicle_uid·vin·vehicle_uid_registry | 정제 |
| 상태 | 판매 가능 여부·출고불가·계약 잠금·listable 이유 | listable·vehicle_status·status·status_kind·status_reason·status_label_raw·locked_by_contract·source_hold·publication_withdrawal·ssot_status·ssot_hold_reasons | 정제 |
| 공급사·원천 | 공급사 코드·이름·원천 종류·원천 ID·시트 탭/행 | provider_company_code·provider_name·partner_code·source·source_schema·source_external_id·product_code·source_url·sheet_source_* | 원문 |
| 가격 행 | 기간·월 대여료·보증금(+상태)·약정거리·인수/반납형 | `price`(키별) → `buildKakaoCatalogReferenceProduct` 의 priceTerms | 정제 |
| 청구·지급 | 상태(확정·근사·미확정)·사유·규칙 | `period_fee_ledger`(ACTIVE) + 장부에 없으면 엔진 값(표시) | 장부 / 엔진 |
| 사진 | 개수·대표·원천 | photo_link·image_urls·photo_cache·photo_source_hash·iancar_one_photo_*·`catalog_vehicle_assets` | 원문/정제 |
| 정책 연결 | 보험·연령 등(원문 기준) | policy_code·policy_code_source_original·policy_reference_state → `policy` 문서 | 원문 |
| 원문 대응 | 처음 들어온 원문 + 최신 원문 ↔ 정리값 | `원문`(차명·전체·옵션)·`원문_정정`·`원문_정정_이력`·`raw_records`·`field_lineage` | 원문 / 정제 대응 |
| 수집 이력 | 수집 시각·마지막 성공·변경 이력 | _direct_ingest_at·_refined_at·erp_first_seen_date·updated_at·`product_change_history`·`source_runs` | 이력 |
| 카톡 후보 | T0/T1 신호(확정 아님 라벨) | `normalized_candidates` 중 source `kakao-info-candidate` — `readKakaoKnownFacts`(차량·공급사 필터, 유효기한 재계산) | 후보 |

## 3. 값마다 출처·기준 시각
모든 칸은 `{ value, source: 원문|정제|후보|장부|엔진, asOf, ref }`. 정제값과 원문이 다르면 `mismatch: true` 와 두 값을 함께 낸다(정리값을 손으로 덮지 않는다). 없는 칸은 `null` + 이유 코드(`NOT_COLLECTED`·`NOT_APPLICABLE`·`READ_FAILED`). 읽기 실패를 빈 값으로 바꾸지 않는다.

## 4. 원천 직접 대조 도구와 맞추기 (🚚공급사 이식·신선도)
출력 JSON 은 `fields[]` 를 평평한 배열로도 낸다: `{ path, normalizedValue, rawValue, rawRef(시트 탭/행 또는 원천 ID), source, asOf }`. 대조 도구는 `rawRef` 로 원천에서 값을 읽어 `rawValue` 와 필드별 비교한다. 칸 이름은 `contracts/` 의 JSON 스키마 한 개로 고정하고 두 쪽 모두 같은 스키마로 검사한다.

## 5. 일정(제안, 읽기 전용·새 컬렉션 없음)
1. 스키마 + 기본·식별·상태·공급사·가격 행·청구 지급(기존 부분 재사용): 1일
2. 원문 대응·정책·사진·수집 이력(`product_change_history`·`raw_records` 읽기 포함) + 요약 표 출력: 1.5일
3. 카톡 후보 칸(`readKakaoKnownFacts` 연결) + 원천 대조 도구용 `fields[]` 평면 출력 + 시험(합성 + 실제 20대 읽기): 1일
4. 카톡 응대 도구·어드민 연결 + 두 소비처 일치 시험: 1~1.5일 (앞선 연결 설계와 합산)
- PR 은 단계별로 나눠 올리고 개발 2 검토 후 반영. 각 단계 점검(구조·표준·데이터 접근 경계) 통과 필수.

## 6. 열린 결정
- 사진 원천 대조 범위(링크 존재까지 vs 이미지 내용): 1차는 개수·대표·원천 종류까지.
- 장부(박제 시점)와 현재 엔진 값 중 응대 기준: 장부 정본, 장부에 없는 상품만 엔진 값(출처 표시).
