# 공급사별 대수 정합 한 장 표 (2026-10-14 21:46 KST 기준, 읽기 전용, DATA)

> 요청: 커맨드 센터(대표 지시 «전 공급사를 같은 방식으로 맞춘다»). **이 표의 «측정» 칸은 라이브 값이 필요하다.** DATA 세션은 배포 catalog·비공개 heartbeats 에 접근하지 못하므로 숫자를 지어내지 않고, 칸마다 «어디서 얻는지»와 코드로 확정된 원인만 적었다. 숫자 입력은 B3Q 가 아래 «채우는 법» 두 명령(읽기 전용)으로 한다. 기준값(커맨드 센터 제공): 전체 605, 손오공 266(진행 중).

## 열 정의와 값의 출처
| 열 | 출처(읽기 전용) |
|---|---|
| 원천 판매가능 | heartbeats 원천별 마지막 줄 `reconciliation.sourceSellable`(원천을 읽은 값, 계약중 포함) |
| 데이터 상품 | `reconciliation.registeredCount` |
| 출고가능 노출 | `reconciliation.exposedCount` (`dispatchableExposedCount` = 계약중 제외) |
| 계약중·잠금 | `contractMarkedExposedCount`·`missingLockedCount`·`lockOverrideCount` |
| 판매불가 편입 | `notSellableEnrolledCount`·`infoIncompleteCount`(비노출 편입) |
| dispatchableGap | `dispatchableGap` = 원천 출고가능 − 노출 출고가능, 사유 분해: `pureNewCount`(NEW)·`missingCount`·`mismatchCount`·`heldReasons`(#619) |
| 마지막 수집·신선도 | heartbeat `lastCompleteAt`·`error`·`failures`; 90분 경보 = RP012(손오공 API), 나머지는 전역 120분·6시간 에스컬레이션 |
| 사진 없음 | 카탈로그: `photo_original_refs` 비어 있고 노출 중인 문서 수(공급사 코드별) |
| 보증금 UNKNOWN | 카탈로그: 노출 문서 중 `price.*.deposit` 가 null/미확인(KNOWN·ZERO 제외) |
| productType «없음» | 카탈로그: 노출 문서 중 `product_type` 빈 값 |

## 행(공급사)과 코드로 확정된 수집 경로·원인
| 공급사(코드) | 수집 경로 | 현 상태(코드·문서 확인분) | 원인 분류 | 누가 고치나 |
|---|---|---|---|---|
| 손오공 RP012 | 공식 파트너 API(키·URL 환경) | 첫 APPLY 34/330 일치 후 UNCERTAIN(계약중 locked 불일치). 수정 #622+#625 배포, 계약중 표식 3f3f639 대기, CAP 300 재무장. productType 탭 값 기록됨 | **수집 결함(수정 완료·반영 대기)** + 가드(편입 상한 100/회차) | B3Q: 엔진 교체·정시 APPLY 진행 / DATA 없음 |
| 이안카 RP031 | ONE API(전체 사실) | **UPSTREAM_STALE**: 마지막 완전 읽기 08:04Z(상류 갱신 정지) → 쓰기 0·노출 유지. productType: 원천에 구분 칸 없음(현상 유지 결정) | **원천 사정**(상류 정지) / productType 은 원천 칸 없음 | 이안카 ONE 운영(상류 재개), 응대가 구분 필드 문의 |
| 오토플러스 RP023 | 시트(정본)+홈피 교차 | product_type «오플구독» 정책 고정 채움 PR(product-type-fill) 합침 후 노출 문서 1회 재기록. ERP4 RP023 쓰기 정지 선행 필요 | **미반영**(PR 합침·ERP4 정지 대기) | B3Q 합침, ERP 개발(ERP4 쓰기 정지) |
| 아이언 RP006 | 홈피 어댑터(SOURCE_CYCLE_IRON_HOMEPAGE=1, 미가동) | 어댑터 있음, ERP4 RP006 쓰기 정지 후 SOURCES 추가해야 가동. 사진 링크 미연결(정체성 승격으로 7대 보정 이력) | **미반영**(가동 전) | ERP 개발(ERP4 정지)→B3Q 가동 |
| 아이카 RP004 | 공급사 원본 시트(장기 3탭+월렌트) | `구분` 칸 값이 어휘와 같을 때만 product_type 채움(PR). 사진 셀 링크: values-only 읽기라 누락 이력 | **수집 결함**(사진 링크)·**원천 사정**(구분 표기) | DATA(사진 연결 승격·변환표 확대), B3Q 집계 |
| 스타 RP018·스카이 RP033 | 공동 입력 시트 «스타» 탭 | F05 계열: `상품구분` 칸 어휘 일치 시 채움 | 시트 입력 | 공급사 입력(응대)·DATA 변환표 |
| KH RP010 | 공동 입력 시트 | 〃 | 〃 | 〃 |
| 에코렌트카 RP032 | 공동 입력 시트 | 〃 | 〃 | 〃 |
| 경진렌트카 RP015·경진카 RP016 | 공동 입력 시트 «경진» 탭 | 〃 (RP016 일부는 시트 연결 위치 미기록 — 대조 불가 이력) | 〃 | 〃 |
| 빌린카 RP021·엘씨 PT-0026 | 공동 입력 시트 «빌린카» 탭 | 〃 (RP021 정책 정합 이력 있음) | 〃 | 〃 |
| 리더스 RP008 | 공동 입력 시트 | 〃 | 〃 | 〃 |
| J&J RP030 | 공동 입력 시트 | 〃 | 〃 | 〃 |
| 센트로 RP017 | 공동 입력 시트 | 〃 | 〃 | 〃 |
| 우리캐피탈 RP020 | 공동 입력 시트 | 〃 (제조사 «르노코리아» 정제 규칙 이력) | 〃 | 〃 |
| 웰릭스 RP013 | 공동 입력 시트 | 〃 | 〃 | 〃 |
| 렌트존 PT-0001 | 공동 입력 시트 | 〃 (번호 미배정 행 FP 키 편입 이력) | 〃 | 〃 |
| 퍼시픽 RP022 | 공동 입력 시트 | 〃 (번호 미배정 행 이력) | 〃 | 〃 |

(경진카·엘씨·스카이 등 숨김 탭 코드는 공동 입력 시트 18코드→15탭 정본 기준: SUPPLIER-INPUT-SHEET-RUNBOOK.)

## 불일치 칸별 원인 한 줄 규칙(채움 시 이 분류만 쓴다)
- **수집 결함**: 원천에 값이 있는데 어댑터·쓰기 경로가 못 담은 것(예: 아이카 사진 셀 링크, 계약중 되읽기). → 고치는 곳: DATA 코드.
- **원천 사정**: 원천에 값이 없거나 원천이 멈춤(이안카 상류 정지, 구분 칸 없음, 시트 입력 공란). → 공급사/응대/상류 운영.
- **가드**: 안전장치가 의도적으로 보류(편입 상한, 55분 간격, 하향 비율 가드, 계약 잠금, 번호 불명 보류). → 정상 동작, 사유 코드로 보고.
- **미반영**: 수정·설정이 합침/가동 대기(PR 합침, ERP4 쓰기 정지, 환경 변수). → B3Q/ERP 개발.

## 채우는 법 (B3Q, 읽기 전용 두 단계)
1. 원천별 5칸+dispatchableGap: `node scripts/source-five-column-report.mjs <비공개 heartbeats.jsonl> --json` (번호는 끝 4자리만, 네트워크·쓰기 0). 신선도: 각 원천 마지막 줄의 `lastCompleteAt`·`error`.
2. 사진 없음·보증금 UNKNOWN·productType 없음: 배포 catalog 스냅샷(products)을 공급사 코드별로 집계(노출 문서만). 집계 스크립트는 코드 PR(커맨드 센터 확인 후)로 제공할 수 있다 — 승인되면 `scripts/ops/supplier-alignment-table.mjs`(스냅샷 JSON → 이 표의 마지막 3열) 작성.
3. 채운 표는 커맨드 센터가 정한 위치(ai-ops docs/handoffs/)에 올린다 — DATA 는 이 저장소 밖에 쓰지 않는다.

## 이 표로 이미 확정된 사실(수치 없음)
- 어휘가 모자란 곳은 이안카 한 곳(원천 칸 없음). 나머지 시트 계열은 칸이 있고 어휘 일치분만 채운다(변환표는 «장기렌트→재렌트»만).
- 지금 숫자를 못 맞추는 큰 덩어리는 손오공의 미적용분(UNCERTAIN 중단)과 이안카 상류 정지, 그리고 가동 전인 아이언·오토플러스 경로다.
