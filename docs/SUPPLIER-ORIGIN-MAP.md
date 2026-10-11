# 공급사 원천 지도와 직접 확인 도구 (2026-10-12)

상태: CODED / 1차 전수 실행(F05 공급사 15곳) 완료. 시트 ID·차량번호 없음(ID 는 비공개 ai-ops `docs/지도/SHEET_MAP.md` 와 환경변수 `FREEPASS_SHEET_F05_ID`). 대표 요구: «공급사 원천을 어디서 어떻게 불러오는지 지도로 알고, 의심되면 원천을 직접 읽어 프리패스 데이터와 대조, 초기엔 전수, 이후 정기 점검».
기반 문서: [SUPPLIER-COLLECTION-ROUTES.md](SUPPLIER-COLLECTION-ROUTES.md)(수집 경로·신선도·대조 틀), `contracts/supplier-input-sheet-spec.v1.json`의 `supplierChannels`(공급사↔탭 정본), ai-ops 연동지도 4절.

## 0. 원천 정본 정의 (대표 2026-10-12 확정, 지휘통제실 전달)
| 구분 | 공급사 | 정본 원천 | 직접 확인 방식 |
| --- | --- | --- | --- |
| 별도 시트(실시간) | 아이카 RP004 | 공급사 자체 «아이카 장기차량 리스트» 시트(재고 3탭: 중고재렌트·장기특별이벤트·신차선출고). 재고가 수시로 바뀜 | **가장 자주, 매번 원천 직접 읽기.** 수집 주기가 길면 «기준 시각»을 명시 — 도구 출력에 `sourceReadAt`(원천을 읽은 시각)·`dataReadAt`(데이터를 읽은 시각)·`판매중 중 원천에 없는 차`를 항상 같이 낸다 |
| 온라인 원천 | 손오공 RP012 | 손오공 ERP(공급사 API) | 전담 세션의 읽기 도구→`supplier-field-reconcile` |
| | 이안카 RP031 | 이안카 ERP(ONE API) | 동일 |
| | 아이언 RP006 | 아이언 홈페이지 | 동일(차량당 1회, robots 판정 선행) |
| | 오토플러스 RP023 | 홈페이지 + 공급사 시트(두 원천) | 동일. 필드별 정본 정리는 아래 |
| 공통 시트 | 나머지 전부 | F05 공통 시트 탭이 최신 정본 | `supplier-origin-verify` |
**전수 확인 순서(확정): 아이카 → 온라인 4곳(손오공·이안카·아이언·오토플러스) → 공통 시트 공급사.** `supplier-origin-verify --all` 은 아이카 → F05 순으로 돌고(온라인 4곳은 전담 세션이 만든 원본 JSON 을 `supplier-field-reconcile` 에 넣어 같은 대조를 한다), 출력에 각 공급사의 원천 읽은 시각이 남는다.

### 오토플러스 RP023 — 필드별 정본 후보 (확정 필요)
코드 근거: ERP4 `lib/domain/sheet-autoplus.ts`(시트 2탭 «판매차량리스트»·«전기차 프로모션» 병합, 재고 대수 집계의 기준)와 `ingest-reborncar-to-firestore`(홈페이지 `mainImage`를 photo_link 후보로 사용, 기존 값이 비었을 때만 채움). products 의 RP023 출처는 website 33 · sheet 50 · legacy 52(전체 155).
| 필드 | 정본 후보 | 근거 |
| --- | --- | --- |
| 차량 존재(재고 대수)·상태·가격·프로모션 | 시트 | 시트 코드가 재고 대수 집계 기준 |
| 사진 | 홈페이지 | `mainImage` 만 홈페이지에 있음 |
| 제원·차종 이름 | 시트가 기본, 홈페이지는 보조 | 홈페이지 필드가 확인되지 않음 — **미확정** |
두 원천의 차량 겹침·값 충돌은 아직 읽어 보지 않았다(원천 읽기 도구 없음). 확정 전에는 «시트=재고·가격·상태, 홈페이지=사진»만 가정하고 나머지는 모른다로 둔다.

### 연동지도(ai-ops 4절)에서 이 정의와 어긋나는 행
1. **아이카**: 연동지도에는 폐기 행 «F51 아이카»만 있고, 정본인 «공급사 자체 아이카 장기차량 리스트 시트» 행이 없다. 새 행(정본, 실시간·기준 시각 필수) 추가 필요.
2. **오토플러스**: «F53 오토플러스»(폐기 개별 시트)만 있고 실제 원천(홈페이지 + 공급사 시트 2탭) 행이 없다. 원천 행 추가와 두 원천의 필드별 정본 표기 필요.
3. **아이언**: «F52 아이언»(폐기)만 있고 홈페이지 원천 행이 없다.
4. **손오공**: 「F50 사용 중 예외·개별 시트」로 적혀 있으나 정의는 손오공 ERP 이다. F50 예외 행은 정본 정의와 다르다(products 출처도 API).
5. **이안카**: 「F54 사용 중 예외」 행이 있으나 정의는 이안카 ERP(ONE)이다. F54 는 정본이 아니다.
6. F05 공급사 15곳은 정의와 맞으나, products 출처 표시가 아직 옛 개별 시트 탭이다(1절 아래 어긋남 1번).

## 1. 원천 지도 (공급사 한 줄씩)
공통 규칙: 프리패스 데이터 `products` 문서 ID = 차량번호이고 `car_number` 칸이 같은 값이다. 대응 키는 모든 공급사가 차량번호다(이안카 `iancar_<해시>`는 RAW 쪽 ID이고 products 키가 아니다). 출처는 `source`·`sheet_source_tab` 칸에 남는다.

| 공급사 | 원천 종류 | 읽는 코드·워크플로 | 주기 | 마지막 성공(2026-10-12 읽음) | products 의 현재 출처 표시(판매 중 아님, 전체) |
| --- | --- | --- | --- | --- | --- |
| 웰릭스 RP013 · 우리캐피탈 RP020 · KH RP010 · 리더스 RP008 · 제이앤제이 RP030 · 에코 RP032 · 센트로 RP017 · 퍼시픽 RP022 · 렌트존 PT-0001 | F05 탭(탭 이름=공급사) | Data `shared-sheet-daily`(capture-shared-sheet→source_runs) + ERP4 `erp5-ssot-refresh` 매시 17분(products 갱신) | 하루 1회 + 재시도, 15분 갱신은 준수율 낮음 | shared-sheet-daily 10-11 16:42Z(수동 실행) | `sheet / 재고` 또는 `시트1` — 개별 시트 탭 이름 |
| 빌린카 RP021(+엘씨 PT-0026, 같은 탭 회사명으로 구분) | F05 탭 `빌린카` | 위와 동일 | 위와 동일 | 위와 동일 | `sheet / 빌린카재고`(옛 개별 시트 탭) |
| 스타 RP018(+스카이 RP033) · 경진 RP015(+경진카 RP016) | F05 탭 `스타` · `경진` | 위와 동일 | 위와 동일 | 위와 동일 | `sheet / 스타재고` · `경진렌트재고` · `경진카재고` |
| 연카 RP011 · 스위치플랜 RP014 · 에스에이 PT-0023 | 규격엔 F05 탭이 있으나 **F05 에 탭 없음** | 읽을 원천 없음 | — | — | 데이터에 연카 0 · 스위치플랜 8 · 에스에이 33대가 남아 있음(출처 `sheet / 재고`) |
| 이안카 RP031 | 공급사 API(ONE) | `collect-iancar-one-api` + ERP4 이안카 2·32·47분 회차 | 신선도 목표 15분 | ERP4 `erp5-ssot-refresh` 10-11 20:32Z 성공, 직후 20:38Z 실패(성공/실패 혼재) | `EANCAR_ONE_API`(약 153) · `sheet / 이안카`·`이안카 재렌트`(137, 옛 시트 흔적) · `legacy_provider_atom`(60) |
| 손오공 RP012 | 공급사 API(구독·픽업) | Data `sonogong-erp-reader` CODED(운영 미연결) / ERP4 엔진이 실제 갱신 | 매시 | 위 ERP4 회차와 동일 | `sonokong / 손오공API`(478) · `legacy_provider_atom`(258) |
| 아이카 RP004 | 공급사 자체 원본 시트(F05 아님) | Data `collect-aica`(CODED, 적재 HOLD) / ERP4 `ingest-aica-to-firestore` | 매시(ERP4) | 동일 | `sheet / 장기특별이벤트`(143) · `중고재렌트`(51) · `legacy_provider_atom`(55) |
| 아이언 RP006 | 홈페이지 HTML | Data `iron-detail-reader` 포트(실 fetch 없음) / ERP4 엔진 | 매시 | 동일 | `iron / ironrentcar.com`(48) · `legacy_provider_atom`(18) |
| 오토플러스 RP023 | 홈페이지 + 공급사 시트 | ERP4 `ingest-reborncar-to-firestore`(Data 수집기 없음) | 매시 | 동일 | `website`(33) · `sheet / 판매차량리스트`(50) · `legacy_provider_atom`(52) |
| 뮤카 RP035 · 마음카 RP034 | 미연결 / F05 제외(마음카 3대 남음) | 없음 | — | — | `sheet / 재고` 3 |

### 연동지도(ai-ops 4절)와 어긋난 곳
1. **F05 공급사 15곳의 products 는 F05 탭이 아니라 옛 개별 시트 탭 이름(`재고`·`빌린카재고` 등)을 출처로 달고 있다.** 연동지도는 «F05 공급사 탭→shared-sheet-daily→Data»로 그리지만, 상품 칸의 현재 출처 표시는 폐기 예정 F50~F69 경로다. 폐기 결정(10-10)이 실제 데이터에는 아직 반영 안 됨 — 개발 관제 판정 필요.
2. 연동지도는 손오공을 «F50 개별 시트 사용 중»으로 적었으나 실제 products 출처는 공급사 API(`sokrc`)이고 F50 이름은 쓰이지 않는다. 이안카는 반대로 옛 시트 출처 137대(전체의 40%)가 남아 있다.
3. 연동지도는 마지막 성공 «모른다»가 많다. 이 문서의 마지막 성공은 GitHub 실행 이력 직접 읽기이며, 개별 공급사 성공 시각은 여전히 모른다(실행 단위만 안다).
4. 규격이 F05 탭을 가정하는 연카·스위치플랜·에스에이는 F05 에 탭이 없고 데이터에는 41대가 남아 있다(주인 없는 상품 후보).
5. 연동지도의 F05 «공급사 직접 탭 입력»은 하루 1회 박제이고, products 갱신 경로는 ERP4 매시 회차다. 두 경로는 서로 다른 시각의 같은 원천을 읽을 수 있다.

## 2. 직접 확인 도구
- `scripts/supplier-origin-verify.mjs`: F05 탭을 `gws sheets +read`로 읽고(읽기 전용) products 를 Firestore REST 로 읽어 항목별 대조한다. 차량번호 마지막 4자리만 출력, 쓰기 없음, 시트 ID 는 `FREEPASS_SHEET_F05_ID` 환경변수.
  - 공급사 하나: `node scripts/supplier-origin-verify.mjs --supplier RP021 [--json] [--out 결과.json]`
  - 전수: `node scripts/supplier-origin-verify.mjs --all --out-dir <폴더>` (F05 15곳 약 10초). `--report-line` 은 점검 리포트용 한 줄 JSON.
  - 비교 항목: 차량번호 · 제조사 · 모델 · 세부모델 · 세부트림 · 외부색 · 연식 · 주행거리 · 배기량 · 연료 · 최초등록 · 차량상태 · 옵션 · 차명 원문 · 기간별(1/6/12/24/36/48/60개월) 월대여료·보증금. 보증금은 1·6개월=단기보증, 12개월 이상=장기보증 열로 비교한다.
  - 유형: `MISSING_IN_DATA` · `ONLY_IN_DATA` · `EMPTY_IN_DATA` · `EMPTY_IN_RAW` · `FORMAT_ONLY`(공백·쉼표·단위·날짜 자리수) · `NEAR_NUMERIC`(배기량 반올림 6% 이내) · `VALUE_DIFF` · `DUPLICATE_PLATE`.
- F05 밖 공급사(API·홈페이지·개별 시트)는 각 전담 세션이 만든 원본 JSON 을 `scripts/supplier-field-reconcile.mjs` 에 넣는다(같은 대조 라이브러리).
- 재사용 판정: ai-ops `읽기대조.mjs` 는 Firestore↔ERP5 공개 응답↔읽기 모듈 비교이고 `수집감시.mjs` 는 카톡 수집 감시라서 «공급사 원천↔데이터» 대조를 하지 않는다 → 새 파일은 정당화되며, 대조 라이브러리·Firestore 읽기 방식(`bogi`와 같은 REST)은 기존 것을 따른다.
- 한계: «원천»은 F05 탭의 정리된 값이다. 공급사 원문 그대로가 아니다(원문은 products `원문` 칸과 source_runs 에 보존). 그래서 제조사·모델·세부모델·세부트림 차이는 «정리 규칙/기준 버전 차이» 후보이지 데이터 오류 확정이 아니다.

## 3-0. 아이카 실시간 직접 읽기 (2026-10-12 08:25 KST 기준, 원천 읽은 시각 2026-10-11T23:25Z)
`FREEPASS_AICA_SHEET_ID=<아이카 시트 ID> node scripts/supplier-origin-verify.mjs --supplier RP004` (약 2초, 읽기 전용). 시트 ID 는 products `source_url` 에서 확인되며 공개 저장소에 두지 않는다.
- 원천(아이카 시트 3탭) 차량 **32대** — 장기특별이벤트 31 · 신차선출고 1 · 중고재렌트 0(탭에 머리글만 있음). 데이터 RP004 250대, 판매 중 89대.
- **판매 중 89대 중 75대가 현재 원천에 없다.** 원천에만 있는 차는 17대(데이터에 없음). 공통 차량은 15대뿐(차량 포함률 46.9%).
- 원천에서 사라진 차가 데이터에서 계속 판매 중으로 남는 구조적 문제 후보 — 아이카가 «재고가 수시로 바뀌는» 공급사라서 갱신·내림 반영 주기가 가장 중요한 곳이다. 단, 원천 시트가 지금 일시적으로 비어 있을 가능성(중고재렌트 탭이 비어 있음)을 배제하지 못하므로 같은 도구를 시간을 두고 다시 읽어 확인해야 한다.
- 약 1분 뒤 다시 읽어도 같은 값(32대 · 판매 중 중 원천 없음 75대)이었다. 이 수치는 읽은 순간의 값이며 기준 시각을 항상 함께 보고한다.

## 3. 1차 전수 결과 (2026-10-12, F05 공급사 15곳)
F05 에 데이터가 있는 공급사 12곳(엘씨·스카이는 공유 탭에 행이 없음, 연카·스위치플랜·에스에이는 탭 없음). 소요 약 10초, 쓰기 0.
| 유형 | 건수 |
| --- | --- |
| MISSING_IN_DATA(F05 에만 있는 차) | 14 — 스타 5 · 경진카 5 · 제이앤제이 2 · 렌트존 1 · 퍼시픽 1 |
| ONLY_IN_DATA(데이터에만 있는 차) | 22 — 우리캐피탈 6 · 웰릭스 4 · 렌트존 4 · 빌린카 3 · 스타 2 · 그 외 |
| EMPTY_IN_DATA / EMPTY_IN_RAW | 10 / 9 (스타 연식 7 등) |
| DUPLICATE_PLATE | 6 (렌트존 3 · 경진카 3) |
| FORMAT_ONLY / NEAR_NUMERIC | 1,278 / 37 (표기·반올림 차이는 일치로 집계) |
| VALUE_DIFF | 201 |

항목별 일치율(표기 차이 포함 일치): fuel_type 100% · options 100% · 월대여료 100% · model 99% · mileage 99% · 최초등록 97% · ext_color 96% · 상태 95% · 보증금 90% · 배기량 90% · 차명 원문 92% · maker 86% · year 82% · sub_model 82% · trim_name 80%.
해석: 가격(월대여료)은 맞고, 차종 3~4칸과 연식은 F05 정리값과 products 정리값의 기준 차이가 큰 것으로 보인다(스타 연식 2025 vs 2020~2022 등은 실제 값 충돌 후보 — 아래). 보증금 불일치 61건 중 38건이 1개월 보증금(F05 단기보증 열 vs products 값; 12개월 5 · 24개월 10 · 36개월 8)이라 «단기보증이 1개월 보증금인가» 정의 확인이 먼저다.
공급사별: 항목 일치율 최저 리더스 85.6% · 렌트존 89.7%; 차량 포함률 최저 경진카 37.5%(F05 8대 중 3대만 데이터에 있음) · 퍼시픽 50% · 제이앤제이 77.8% · 스타 82.1%.
**우선 조사 후보:** ① 스타·경진카의 F05-only 차량 10대(데이터에 아직 안 들어옴 — 수집 누락 후보) ② 렌트존·경진카 중복 번호 6건 ③ 스타 연식 불일치 ④ 연카·스위치플랜·에스에이 41대의 주인 확인.

## 4. 초기 전수 계획
| 순서 | 공급사 | 방식 | 추정 시간 | 비고 |
| --- | --- | --- | --- | --- |
| 1 | F05 공급사 12곳 | `supplier-origin-verify --all` | 10초(완료) | 이 문서 3절 |
| 2 | 아이카 RP004 | 원본 시트 읽기(`aicaSheetsGridReader`)→`field-reconcile` | 약 1분(읽기 권한 확인 후) | 전담: 🚛 |
| 3 | 손오공 RP012 | `sonogong-erp-reader` 읽기 전용→`field-reconcile` | 목록+상세 호출 수에 비례, 수 분(차량당 1회 상세) | 전담: 🧩. 인증 정보는 담당 세션 |
| 4 | 이안카 RP031 | ONE API 읽기 경로→`field-reconcile` | 수 분 | 전담: 🛟 |
| 5 | 아이언 RP006 | 상세 페이지 차량당 1회, 동시 2 | 66대면 수 분 | robots·약관 판정 선행, 📦 |
| 6 | 오토플러스 RP023 | 홈페이지+시트 | 미정 | Data 수집기가 없어 읽기 도구부터, 📦 |
순서는 빠른 것부터지만 대표 우선순위(손오공 140·이안카 94)는 전담 세션이 2~4를 병렬로 진행한다. 이 세션은 도구와 1단계만 책임진다.

## 5. 정기 점검 편입
도구 공방이 점검 리포트에 붙일 출력은 `supplier-origin-verify --all --report-line` 의 한 줄 JSON 이다.
```json
{"kind":"supplier-origin-verify/v1","observedAt":"ISO","suppliers":[{"supplier":"RP021","tab":"빌린카","seconds":0.6,"rawVehicles":44,"dataVehicles":47,"commonVehicles":44,"vehicleCoverage":1,"fieldMatchRate":0.91,"fieldExactRate":0.0,"types":{"MISSING_IN_DATA":0,"ONLY_IN_DATA":3,"EMPTY_IN_DATA":2,"EMPTY_IN_RAW":4,"FORMAT_ONLY":500,"NEAR_NUMERIC":1,"VALUE_DIFF":88,"DUPLICATE_PLATE":0},"worstFields":[{"field":"price.1.deposit","compared":44,"matchRate":0.1}]}]}
```
- 경고 기준 제안: `vehicleCoverage` < 0.9 이거나 `MISSING_IN_DATA` > 0 이면 «수집 누락 후보», `fieldMatchRate` 가 직전 대비 5%p 이상 하락하면 «회귀». 판정 확정은 도구 공방.
- 주기 제안: 전수는 하루 1회(shared-sheet-daily 직후), 의심 시 공급사 단독 실행. 토큰 0, 약 10초.
- 예약 등록은 하지 않았다(지휘통제실 승인 필요).
- 시험: `tests/supplier-field-reconcile.node.mjs`·`tests/supplier-freshness.node.mjs` 11건.
