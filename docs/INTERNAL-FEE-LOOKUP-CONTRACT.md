# 내부 수수료 조회 계약 v1 (2026-10-10)

대표 결정: 기간별 청구·지급 수수료는 **프리패스 데이터에만 저장**하고, 조회는 **내부 통로에서만** 한다. ERP5·공개 응답·공통 시트 투영·내보내기에는 내보내지 않는다.

- **필드**: `supplierBillingFee`(공급사 청구) · `channelPayoutFee`(영업채널 지급), 기간(`termKey`)별. 저장 위치는 기존 `Offer.internalEconomicsTerms`(새 칸 없음). 타입 `src/domain/internal-fee-lookup-contract.ts`, 변환 `toInternalFeeLookup`.
- **상태**: `CONFIRMED`(KNOWN 금액 / ZERO 무료 / NOT_APPLICABLE) · `UNCONFIRMED`(UNKNOWN — 반드시 `reasonCode`, 없으면 `REASON_NOT_RECORDED`). 0 과 모름을 섞지 않는다.
- **읽기 권한**: 내부 전용 — 어드민(프리패스 정산), 카톡 PC 조회(`프리패스안내.mjs`, `/catalog-reference`·`/internal-ai-reference`). 공개 응답(호환 응답 `withoutInternalFeeFields`, `/catalog` 허용 목록 스키마)은 수수료를 내보내지 않는다.
- **근거**: 값은 저장된 그대로(계산 없음). 규칙·정책 id 와 근거 행(`sourceRefs`)을 같이 낸다. 수수료 규칙 정본은 정산 수수료 규칙(`settlement_fee_rules`)과 정책 `sales-commission-*`.
- **재사용 판정**: 기존 `OfferTermEconomics`/`TermEconomicAmount` 를 그대로 쓴 순수 변환 + 문서 한 장. 새 저장·새 API 없음. 어드민 투영(`admin-catalog.ts`)과 카톡 참조(`kakao-catalog-reference.ts`)는 같은 저장값을 이미 읽는다 — 소비처가 이 타입으로 맞출 때 옛 모양을 같은 PR 에서 지운다.
