# 손오공(RP012) 규격 일치 점검표 — 한 장 (2026-10-16, 박대표 «데이터가 우리 규격에 맞게 들어오면 좋겠음»)

상태: 읽기 전용 점검(쓰기 0) + 규격 검증 단계 제안. 마스터에 없는 이름은 만들지 않는다(차종 기준 한 장 규칙 8) — 이 점검은 값을 고치지 않고 보고만 한다.
**채움률(③)은 이 PC 가 라이브 문서를 읽을 수 없어 «측정 대기»** — 아래 §4 명령으로 B3Q 가 18:00 회차 전·후 캡처에 돌린다(번호 끝 4자리·사례 3개씩). ①②④⑤ 는 코드·문서 사실이다.

## 1. 필드별 점검표

| 필드(문서 칸) | ① 우리 규격 | ② 손오공 원천 → 변환(어댑터) | ④ 손실·미채움 원인 | ⑤ 규격 검증(제안, 위반 시 그 칸만 보류) |
| --- | --- | --- | --- | --- |
| 제조사 `maker` | 마스터 제조사 목록의 표기(옛 표기 르노삼성 등 불가) | `brand` → `raw.source_maker` → 입구 매핑(#685), 빈 칸에만 | 마스터 목록에 없는 표기(UNMAPPED)·입구 매핑 첫 적용 전 빈칸·정제 대기 | 원문 형태(밑줄)·숫자만이면 위반 |
| 모델 `model` | 마스터 모델 이름 | `model` → `raw.source_model` → 입구 매핑(#685) | 위와 같음 | 밑줄 원문 형태 위반 |
| 세부모델 `sub_model` | 마스터 세부모델(세대명) 이름 | API 에 없음. 상세명 `carName`(«타스만_2.5T 가솔린 2WD») 한 줄 → 정체성 적용(#655)·후보 CSV 로 마스터 매칭 | API 가 세부모델을 안 줌 + 마스터 행 부재 시 규칙 8 로 생성 불가 → 임시값=원문(`vehicle_title_source=RAW_VEHICLE_TEXT`) | 밑줄 원문 형태·표식+원문 그대로는 «정제 대기» 위반으로 센다(고치지 않음) |
| 트림 `trim_name` | 마스터 트림 이름 | API 가 안 줌(원문 상세명에서 마스터 트림 별칭 매칭만) | API 미제공 | 값이 있으면 밑줄 위반만 |
| 연식 `year` | 4자리 연도 | 목록 `manufactureYearMonth` → `spec.year`(YYYY)·`manufacture_year_month` (sonogong-api.ts) | 제조연월 없음 | `^(19\|20)\d{2}$` 아니면 위반 |
| 최초등록 `first_registration_date` | 실제 달력 날짜 YYYY-MM[-DD] | 상세 `firstRegistrationDate` → `registrationDate()` (제조연월과 섞지 않음) | 상세를 못 읽은 차(캐시·상한)·원천 미기재 | 달력에 없는 날짜 위반 |
| 연료 `fuel_type` | 8종(가솔린·디젤·LPG·하이브리드·플러그인 하이브리드·전기·수소·가솔린+LPG) | `fuel` → `fuelName()` 공통 별칭표 | 별칭표 밖 표기는 빈칸(원문은 `raw.list.fuel` 보존) | 8종 밖이면 위반 |
| 배기량 `engine_cc` | 단위·쉼표 없는 정수 cc(3~5자리), 전기·수소 불가 | 목록 `displacementCc`(number) → 문자열 | 원천 0·미기재, 입구 매핑 전 | 리터·단위·쉼표·전기 차 배기량 위반 |
| 구동 `drive_type` | 차종 기준 한 장 구동 표기 | **API 필드 미확인**(어댑터가 읽지 않음) | API 가 주는지 확인 필요(B3Q 응답 키 이름 확인 요청 중) | 값이 생기면 목록 검증 추가 |
| 변속기 `transmission` | 한 장 변속기 표기 | **API 필드 미확인** | 위와 같음 | 위와 같음 |
| 인승 `seats` | 1~99 정수 | API 필드 미확인(`seats` 입구 매핑 칸만 준비) | 원천 미제공 | 정수 범위 위반 |
| 외장색 `ext_color` | 짧은 색 이름(≤20자) | `exteriorColor` → `spec.ext_color` | 원천 미기재 | 20자 초과·숫자 4자리 위반 |
| 내장색 `int_color` | 짧은 색 이름 | 상세/목록 `interiorColor` → `spec.int_color` (#696 에서 추가, 이전엔 미수집) | 이전 회차 미수집 → 입구 매핑으로 채워짐 | 위와 같음 |
| 주행 `mileage` | 0~1,000,000 정수(km), **값 없음은 null(0 아님)** | 목록 `mileageKm`(number) → 문자열 | 원천 미기재(0 으로 쓰지 않음) | 정수 아님·음수 위반 |
| 보증금 `price[개월].deposit` | 원 단위 정수, 양수는 1만원 이상 | 상세 `prices[종류].deposit[개월]`; 양수=원문, 0·빈칸=자리채움 → 공급사 정책 산출(구독·픽업구독: 월 대여료×약정연수 최대 3개월, 중고렌트는 UNKNOWN) | 상세 미읽음(캐시·상한)·중고렌트 자리채움 0 | 만원 단위 혼동(0<값<1만)·1억 초과 위반 |
| 월 대여료 `price[개월].rent` | 원 정수, 100,000~50,000,000 | 목록/상세 `prices[종류].monthly[개월]` → `parseSonogongAmount` | 파싱 불가(amountUnparseable)·«가격 없음» 낱말 | 범위 밖 위반(기존 RENT_REVIEW 보류와 일치) |
| 상품 구분 `product_type` | 중고렌트·오공구독·픽업구독 | 탭 rent·sub·pick → 고정 표(`PRODUCT_TYPE_BY_TAB`) | 없음(탭이 정함) | 3종 밖 위반 |
| 출고 가능일 | 날짜 | **어댑터가 읽지 않음**(API 필드 미확인) | API 가 주는지 확인 필요 | — |
| 상태 `status_kind` | 출고가능·계약중 등 상태 어휘 | `hasActiveContract` → «계약중», 아니면 «출고가능»; 판매 중단은 부재 하향 | 상세 상태 필드 미확인 | 상태 어휘 밖 위반 |
| 옵션 `api_options_*` | PRESENT·NONE·(UNKNOWN) + 이름·금액 | 상세 `options` → 분류 투영(기본 꺼짐 게이트, #674) | 상세 없음(NO_DETAIL)·게이트 꺼짐 | 상태 값 밖 위반 |
| 사진 `image_urls` | 주소 목록(URL 그대로) | 상세 `images[].url`, 없으면 목록 `thumbnailUrl` (#654) | 상세 미읽음 | — |

## 2. 알려진 규격 위반 사례 후보(코드로 확인된 것, 건수는 측정 대기)
1. 세부모델이 밑줄 원문(`타스만_2.5T 가솔린 2WD`)인 «원문 형태» 문서 — 입구 매핑·정체성 적용 대상(규칙 8: 마스터에 없으면 후보 큐).
2. 제원 칸이 비어 있는 노출 문서(802조3132 형태) — 제원은 #688 이전에는 새 문서에만 실렸다.
3. 신규 편입 문서의 제원은 `sheetSpecFields` 가 길이(≤40)만 보고 값 형식은 검증하지 않는다(허용 공급사는 입구 매핑의 형식 검증을 쓴다) — 위반이 들어갈 수 있는 유일한 쓰기 경로.

## 3. 규격 검증 단계 제안(회차마다 자동, 쓰기 없음 → 위반 칸 보류 + 경고 줄)
- 위치: 쓰기 직전(`nativeCycleFields`) 순수 검증 — 위반 값은 그 칸만 쓰지 않고 원문은 `raw` 에 보존(고쳐 쓰지 않음).
- 경고 줄: `SPEC_VIOLATION:<field>:<건수>`(번호 없음), 회차 요약에 합산. 위반이 노출 대수의 20% 를 넘으면 원천 형식 변경 의심으로 회차 보류(이안카 드리프트 한도와 같은 방식).
- 검증 규칙은 `SPEC_VALID`(제원 입구 매핑)·`RENT`·보증금 범위를 한 표로 합쳐 쓰고, 이 점검표의 `SONOGONG_CHECKS` 와 같은 정의를 쓴다(점검·회차 검증이 어긋나지 않게).
- 구현은 승인 뒤 별도 PR(기본 꺼짐 플래그 + Codex): 이 문서 승인 시 §2-3 의 신규 편입 경로부터 막는다.

## 4. 재계산 쿼리(읽기 전용)
```
npm run report:sonogong-conformance -- --capture <erp5-source-capture.json>        # 줄 단위
npm run report:sonogong-conformance -- --capture <erp5-source-capture.json> --json  # 전/후 비교용
```
캡처는 `export:identity-snapshot` 가 읽는 것과 같은 `erp5-source-capture/1` 파일이다. 18:00 회차 입구 매핑·제원 적용 «전/후» 두 번 돌려 필드별 채움률·위반 건수·사례 3개(끝 4자리)를 비교한다. 코드: `src/application/sonogong-spec-conformance.ts`(순수, 시험 4건).

## 5. 구조 필드 전수 확인(B3Q, 손오공 원문 355문서, 값 없음)
- 목록 키: id·tab·carNumber·brand·model·detailName·manufactureYearMonth·mileageKm·fuel·displacementCc·exteriorColor·thumbnailUrl·hasActiveContract·prices.
- 상세 키: 위 + carName·tabLabel·interiorColor·description·newCarOptionNote·images·options·inspection·insuranceHistory·insurance.
- 구동·변속기·인승·출고 가능일에 해당하는 **구조 필드는 없다**. 자유 텍스트(description·newCarOptionNote·detailName)·옵션명에만 있을 수 있어(구동 낱말 152·변속 101·«N인승» 52·출고 낱말 198문서) 텍스트 파싱은 «값을 만들지 않는다» 원칙상 입구 매핑에 넣지 않는다 — 차종 마스터/세부모델에서 구동·인승을 가져오는 쪽이 정답이고, 출고 가능일은 API 에 없다(상태는 hasActiveContract 뿐).
