# Codex 지시서 — 원천 신규 편입 경로 (엔진 PR #567 위, 2026-10-12)

대상 가지: `work/freepass-data/source-engine-core-20261012`(PR #567). 이 문서는 설계·지시서다. 실행은 지휘통제실이 Codex 로 한다. 운영 쓰기는 시험 실행 digest → 승인 뒤에만.

## 목적
대표 원칙: «원천이 전부다. 기존 프리패스 데이터·ERP5 값은 기준이 아니다.» 원천에는 있는데 `products` 에 없는 차를 **원천 행에서 새로 구성**해 편입한다(기존 문서에 맞추려 하지 않는다). 대상(2026-10-12 읽음, 끝 4자리는 계획 파일에만):
- 아이카(RP004) 원천에만 16 + 재노출 1 / 공통 시트 편입 16(스타 5·경진카 8·제이앤제이 3) / 아이언 10 / (번호 미배정 5줄은 UID 부여 선행 — 아래 5)

## 1. 편입 레코드 = 원천 행에서만 만든 `SourceProductRecord` (PR #567 의 표준 레코드 재사용)
- 입력은 어댑터의 `toRecords()` 결과뿐. `products`·ERP5·기존 정제 시트 값을 읽어 채우지 않는다. 필수: 차량번호(또는 UID), 상태 원문, 기간별 월대여료·보증금, 연주행, 관측 시각.
- **공통 시트**: PR #567 `shared-sheet-engine.ts` 가 이미 `terms`·`status`·`vehicleText`·`raw.cells/headers` 를 만든다. 편입에 필요한 칸 매핑(F05 머리글 → products 칸): 차량번호→`car_number`, 제조사→`maker`, 모델→`model`, 세부모델→`sub_model`, 세부트림→`trim_name`, 외부색상→`ext_color`, 내부색상→`int_color`, 연식→`year`, 주행거리→`mileage`, 배기량→`engine_cc`, 연료→`fuel_type`, 최초등록일→`first_registration_date`, 인승→`seats`, 차량상태→`status`/`status_label_raw`, 옵션 원문→`options`, 차명 원문→`원문.차명`, 1/6/12/24/36/48/60개월·보증금→`price.<개월>.rent|deposit`.
- **아이카**: 보이는 탭 장기특별이벤트·신차선출고·중고재렌트(숨김 탭·숨긴 줄 제외, `scripts/source-read.mjs read RP004` 의 읽기 규칙 그대로). 칸 매핑: 차량번호→`car_number`, 제조사→`maker`, 트림(전체 차명)→`원문.차명`·`sub_model`/`trim_name` 은 마스터 판정 후, 연료→`fuel_type`, 외장/내장→`ext_color`/`int_color`, Km→`mileage`, 최초등록→`first_registration_date`, 배기량→`engine_cc`, 소비자가격→`원문.전체.소비자가격`, 월렌트→`price.1.rent`, 36/48/60개월→`price.<개월>.rent`, 장기보증→`price.<개월>.deposit`(무보증=0, 텍스트 근거 ZERO), 배차상태→`status`(배차문의=출고협의, 수리중=상품화중, 둘 다 판매 가능), 옵션→`options`. 사진·갱신 시각 칸은 원천에 없다.
- **아이언**: 홈페이지 상세 HTML(차량당 1회·동시 2, `source-read.mjs read RP006` 읽기 규칙): 제목→`원문.차명`, 차량번호→`car_number`, 유종→`fuel_type`, 주행거리→`mileage`, 외장 색상→`ext_color`, `<N>개월` 요금→`price.<N>.rent`, 보증금 문구→`price.<N>.deposit`(예 «보증금 50만원 무보증가능…» → 500000, 문구는 `deposit_note` 원문 보존), 판매완료 표시는 판매 불가.

## 2. 새 상품 문서 구성 규칙
- 문서 ID: 번호 있는 차는 차량번호(기존 규약), 번호 미배정(«신차»)은 `vehicle_uid`(`va_…`). **생성만**(`currentDocument.exists=false` 조건) — 이미 있으면 편입이 아니라 갱신 경로로.
- 필수 칸: `provider_company_code`, `partner_code`, `provider_name`, `source`(sheet/iron), `sheet_source_tab`/`source_schema`(공급사 코드), `sheet_source_row`(위치 포인터일 뿐 신원 아님), `원문`(원천 행 그대로 `전체` 맵 + `차명`·`옵션`), `price`, `status`/`vehicle_status`/`status_kind`/`status_label_raw`, `listable`(상태가 판매 가능이고 신선도 통과일 때만 참), `vehicle_uid`(`resolveVehicleUid`: 번호 정상·유일하면 기존 자산 재사용, 아니면 새 `va_`+ULID, 애매하면 새로 만들지 않고 보류), `_direct_ingest_at`·`_var_polled_at`=원천 관측 시각(신선도 규칙의 근거 — 이 시각을 현재 시각으로 부풀리지 않는다).
- **차종 3칸(`maker`·`model`·`sub_model`·`trim_name`)**: 원천 원문을 `원문` 에 그대로 두고, 정리 칸은 F03 차종 마스터(별칭 포함)로 «뜻으로 하나일 때만» 채운다. 하나로 안 정해지면 비우고 확인 동선(`확인/등록.ps1`)에 등록, `listable` 은 상태 기준대로 두되 `vehicleHold` 사유 표시. 임의 추정·자유 입력 금지.
- 정책 연결(`policy_code`): 공급사 기본 정책만(아이카 `RP004_P01` 등 기존 공급사 기본), 새로 만들지 않는다. 수수료·견적 확정은 별도 경로.

## 3. 계획·승인·적용 (PR #567 `planSourceRecords`/`applySourceRecords` 재사용)
- 시험 실행: 어댑터 → 레코드 → 계획(신규/갱신/보류) → digest. 보고는 숫자 한 줄 + 끝 4자리 목록.
- 적용: 승인 digest 일치 → 생성 대상 ID 목록을 비공개 백업(되돌리기 = 생성 취소 목록) → 문서별 `exists=false` 조건 생성 → 되읽기로 기대 칸 대조 → 실패는 PARTIAL_HOLD, 재전송 금지. 한 회차에서 신규 편입이 원천 대수의 1.5배를 넘거나 기존 판매 대비 비정상 급증이면 쓰기 전 중단.
- 계약 잠금(`locked_by_contract`)·«계약중» 문서는 어떤 경우에도 변경하지 않는다. 삭제 없음.

## 4. 시험(필수)
단위: ① 원천 행만으로 레코드 구성(기존 문서가 없어도) ② 무보증=ZERO·«-»=빈칸 ③ 번호 미배정은 UID 로 문서 ID ④ 이미 있는 문서는 생성 거부 ⑤ 상태 «출고불가»/숨긴 줄은 `listable` 거짓 ⑥ 관측 시각이 신선도 한도를 넘으면 `listable` 거짓 ⑦ 아이카 배차문의=출고협의·수리중=상품화중. 실데이터 읽기 시험: 아이카 16·공통 시트 16·아이언 10 이 계획에 정확히 잡히는지(`판매가능대수 --plan-out` 의 enroll 목록과 대조).

## 5. 선결 조건·열린 질문
1. 번호 미배정 5줄(렌트존 4·퍼시픽 1)은 F05 UID 칸이 있어야 편입 가능(시트 UID 부여는 별도 승인 — docs/SUPPLIER-ORIGIN-MAP.md §15). UID 가 없으면 `UID_REQUIRED` 로 보류(PR #567 동작 그대로).
2. PR #567 차단급 지적 해소가 선행: 판매 가능을 조건 검증에서 분리(상태만으로 판매 가능, 조건 보류는 견적 확답 차단만) — 안 고치면 편입한 차의 34% 가 판매 불가로 들어간다.
3. ERP4 엔진(매시)이 같은 문서를 옛 시트 값으로 덮지 않도록 F05 공급사 제외(동결 저장소라 담당 승인).
4. 아이카 «월렌트» 탭은 차량번호 없는 차종별 1개월 가격표 → 차량 편입 대상이 아니다(별도 상품 종류로 다룰지 결정 필요).
