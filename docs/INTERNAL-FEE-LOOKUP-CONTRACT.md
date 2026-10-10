# 내부 수수료 조회 계약 v1 (2026-10-10)

대표 결정: 기간별 청구·지급 수수료는 **프리패스 데이터에만 저장**하고, 조회는 **내부 응답으로만** 한다. ERP5·공개 응답·공통 시트 사영·내보내기에는 내보내지 않는다.

- **필드**: `supplierBillingFee`(공급사 청구) · `channelPayoutFee`(영업채널 지급), 가격행(`Offer.priceTerms[].termKey`) 기준 1:1 위치는 기존 `Offer.internalEconomicsTerms`(새 칸 없음). 정본 `src/domain/internal-fee-lookup-contract.ts`, 변환 `toInternalFeeLookup`.
- **가격행 1:1**: `toInternalFeeLookup(offerId, priceTerms, internalEconomicsTerms)`는 `priceTerms` 순서와 개수를 결과 `terms`의 유일한 기준으로 삼는다. 경제 조건에 값이 있어도 가격행에 없으면 결과 행으로 만들지 않는다.
- **중복**: 경제 조건에 같은 `termKey`가 둘 이상 있으면 어느 쪽도 쓰지 않고 해당 가격행의 청구·지급을 모두 `UNKNOWN` 미확정, `reasonCode: DUPLICATE_TERM_KEY`로 채운다.
- **고아**: 경제 조건에는 있지만 가격행에는 없는 `termKey`는 결과 `terms`에 넣지 않고 `orphanTermKeys` 배열로만 보고한다.
- **누락**: 가격행에는 있는데 경제 조건이 없으면 해당 가격행의 청구·지급을 모두 `UNKNOWN` 미확정, `reasonCode: NO_EVIDENCE`로 채운다.
- **상태**: `CONFIRMED`(KNOWN 금액 / ZERO 무료 / NOT_APPLICABLE) · `UNCONFIRMED`(UNKNOWN). 미확정 `reasonCode`는 trim 후 빈 문자열이면 `REASON_NOT_RECORDED`로 보정하며 항상 비어 있지 않은 문자열이다. 0과 모름을 섞지 않는다.
- **읽기 권한**: 내부 전용 어드민(프리패스 정산), 카카오 PC 조회(`프리패스안내.mjs`, `/catalog-reference`·`/internal-ai-reference`). 공개 응답(교환 응답 `withoutInternalFeeFields`, `/catalog` 허용 목록 스키마)은 수수료를 내보내지 않는다.
- **근거**: 값은 저장된 그대로(계산 없음). 규칙·정책 id 및 근거(`sourceRefs`)를 같이 둔다. 수수료 규칙 정본은 정산 수수료 규칙(`settlement_fee_rules`)과 정책 `sales-commission-*`.
- **소비처**: 프리패스 정산 어드민 PR(예정), 카톡 안내 도구(`프리패스안내.mjs`) — 연결하는 PR에서 옛 응답 모양을 지운다.
- **재사용 결정**: 기존 `OfferTermEconomics`/`TermEconomicAmount`를 그대로 재사용 + 필수 변환과 문서만 추가. 어드민 사영(`admin-catalog.ts`)과 카카오 참조(`kakao-catalog-reference.ts`)는 같은 저장값을 내부 읽기 전용으로 맞추되 실제 소비처 연결은 별도 PR에서 진행한다.
