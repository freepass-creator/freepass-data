# 정산 완성 P0 설계

목표: 기존 `settlement_rows`, `settlement_events`, 정책/수수료 계약, `field_lineage`를 확장한다. 새 정산 모음은 만들지 않는다. 원본 ID, 사람 입력, 실제 0원, UNKNOWN은 구분해 보존한다. 은행 접속이나 이체 실행은 하지 않는다.

| P0 항목 | 지금 있는 것 | 없는 것 | 다음 PR |
| --- | --- | --- | --- |
| 1. 은행 거래 배정 | `settlement_rows`의 청구/지급/수금/지급 기록값, 일부 `settlement_events` | 거래 사건의 안정 계약, 분할 배정, 취소/환불, 증빙 링크 | `settlement_events`에 `transactionId`, `amount`, `occurredAt`, `counterparty`, `allocation[]`, `cancelOrRefund`, `evidenceRef`, `sourceKind` 추가. 원천은 정산원장 시트와 은행 내보내기 파일만 사용 |
| 2. 안정 ID 연결 | `settlement_rows`의 `contractNo`, `contractId`, `contractCode`, `intakeRequestId`, `sourceProductId` 일부 필드 | 기존 행 전체의 보수적 연결 감사와 HOLD 분류 | `auditSettlementIdLinks` 결과 기준으로 `LINKED_EXPLICIT`, `LINK_CANDIDATE_BY_PLATE`, `ORPHAN`, `AMBIGUOUS`를 보고. 차량번호 후보는 확정이 아니며 번호를 만들어 채우지 않음 |
| 3. 계약 당시 조건·수수료 snapshot | 상품/정책 코드, 사람 입력 청구/지급 칸, 계산 칸 설계 | 계약 시점 정책 revision, VAT 근거, 계산 근거의 완전 snapshot | `settlement_rows`에 정책 revision, VAT, 계산 근거, 엔진 revision, observedAt, UNKNOWN 상태를 추가하되 사람 입력 칸은 덮지 않음 |
| 4. 청구·미수 잔액 | 청구/지급/수금/지급 기록과 일부 cash event 조회 | 검증된 배정액 기반 잔액 계약 | 잔액 = 확정 청구 - 검증된 배정 - 취소/환불. 하나라도 UNKNOWN이면 잔액도 UNKNOWN. 0은 증빙 있는 실제 0일 때만 0 |
| 5. 공급사 재고 확답 | 상품/재고 관측과 공급사 입력 출처 | 공급사 확답 시각, 유효기간, 확인자 계약 | `settlement_events` 또는 source lineage에 `confirmedAt`, `validUntil`, `confirmedBy`, `evidenceRef`를 남기고 만료 시 HOLD |

## 안정 ID 연결 규칙

- 명시 ID가 유효 계약 또는 상품 문서 ID/코드와 맞으면 `LINKED_EXPLICIT`.
- 명시 ID 없이 차량번호로 유효 계약 또는 상품이 유일하면 `LINK_CANDIDATE_BY_PLATE`.
- 차량번호 후보는 확정 ID가 아니며 `settlement_rows`에 자동 기입하지 않는다.
- 유효 계약/상품 후보가 없으면 `ORPHAN`.
- 유효 계약 또는 상품 후보가 다건이면 `AMBIGUOUS`.
- 테스트, 삭제, 초안 계약은 유효 후보에서 제외하고 별도 집계한다.

## 완료 경계

P0 감사는 읽기 전용이다. Firestore `get/list/getAll` 계열만 허용하고 `set/update/delete/add`는 사용하지 않는다. stdout에는 개수와 digest만 출력하고, 행별 보고서는 `SETTLEMENT_ID_LINK_AUDIT_OUT`의 비공개 폴더에만 저장한다.
