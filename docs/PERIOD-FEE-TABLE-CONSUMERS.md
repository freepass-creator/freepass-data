# 차량번호 하나 → 기간별 월 대여료·보증금·청구·지급: 소비처 연결 설계 (한 장)

## 지금 있는 것(코드 확인)
- 계산 엔진은 하나: `buildKakaoCatalogReferenceProduct`(수수료)·`planPeriodFeeLedger`(기간별 장부 행). 장부 = 프리패스 데이터 `period_fee_ledger` ACTIVE run(첫 박제 스냅샷).
- 카톡 소비처(`kakao-ops`): `catalog-reference` 응답(`kakao-catalog-reference-v1`)에 청구·지급 칸이 이미 있다(스키마 확인). 단 로컬 8789 그림자 서버는 수수료 칸이 없는 옛 복사본이라 대상이 아니다.
- 어드민(`freepass-admin-catalog`): `contract-fee-link-read` 권한의 `contract-fee-links` 경로가 장부 행으로 계약별 청구·지급을 읽는다. `admin-catalog-view-v1` 스키마에도 수수료 참조 칸이 있다.
- 조회 명령(PR #529 + 후속): 장부에서 차량번호별 기간 표를 읽고, 결과가 비면 사유(판매 중 아님·가격 행 없음·장부에 없음·상품 없음)를 돌려준다.

## 문제
카톡과 ERP(어드민)가 서로 다른 경로에서 값을 읽으면 값이 갈린다(장부 = 박제 시점 값, 응답 = 읽는 순간 엔진 값).

## 설계 — 읽기 함수 하나, 값의 출처 한 줄 표시
1. `readPeriodFeeTable(key)` 하나를 application 에 둔다(조회 명령의 `lookupFeeWithReason` 을 승격). 입력: 차량번호 또는 vehicle_uid. 출력: 기간별 행 + `valueSource`(`LEDGER` | `ENGINE_NOT_IN_LEDGER`) + 사유 코드.
2. 카톡(`catalog-reference`)과 어드민(`contract-fee-links`·카탈로그 뷰)은 둘 다 이 함수를 통해 청구·지급을 채운다. 각자 엔진을 다시 부르지 않는다. 공개(ERP5) 응답에는 수수료를 싣지 않는 원칙 유지.
3. 값의 기준 시점 통일: 기본은 «ACTIVE 장부», 장부에 없는 상품만 엔진 값을 `ENGINE_NOT_IN_LEDGER` 로 표시. 손오공 새 규칙은 재박제(승인된 digest) 뒤 장부에 반영되어야 두 소비처가 같은 값이 된다.
4. 적합성 시험: 같은 차량번호 20대를 두 소비처 응답으로 읽어 청구·지급이 같은지(read-contract 적합성 시험 틀 재사용). 어긋나면 배포 중단.

## 일정(제안)
- ① 읽기 함수 승격 + 시험(후속 PR): 0.5일
- ② 어드민 `contract-fee-links` 가 같은 함수를 쓰도록 정리 + 적합성 시험: 1일
- ③ 카톡 `catalog-reference` 응답의 수수료 칸을 같은 함수로 채우기 + 적합성 시험: 1일
- ④ 손오공 재박제는 별도 대표 승인(digest) 뒤 — ②③ 이전에 하면 값이 한 번 더 바뀐다.

## 열린 결정
- 장부(박제 시점) 대 현재 엔진 중 «응대 시점에 보여 줄 값»: 이 설계는 장부를 정본으로 한다. 일 단위 재박제 주기가 확정되면 신선도 한계를 응답에 표시한다.
