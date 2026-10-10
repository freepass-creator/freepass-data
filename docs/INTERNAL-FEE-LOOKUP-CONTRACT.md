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

# 계약→가격행→수수료 조회

정산 줄처럼 계약 기록 한 줄에서 내부 수수료를 확인할 때는 새 저장·새 API 없이 `resolveContractFeeLink(input, data)` 또는 얇은 읽기 어댑터 `readContractFeeLink(store, input)`만 사용한다. 입력은 `{ plate, supplierId, termMonths, monthlyRent, deposit? }`이며 번호판은 공백 제거 후 비교한다. `deposit`이 없으면 보증금 대조를 생략하고, 무보증은 반드시 `deposit: 0`으로 대조한다. 데이터는 `VehicleAsset[]`, `Product[]`, `Offer[]`이고 어댑터는 `CatalogStore.listVehicleAssets`, `listProducts`, `listOffers`만 호출한다.

| 순서 | 규칙 | 실패 코드 |
| --- | --- | --- |
| 1 | `VehicleAsset.plateNumber` 정확 일치. 0개/2개 이상은 중단한다. | `NO_ASSET`, `MULTI_ASSET` |
| 2 | `Product.vehicleAssetId` 일치. 0개/2개 이상은 중단한다. | `NO_PRODUCT`, `MULTI_PRODUCT` |
| 3 | `Offer.productId` 일치. 0개/2개 이상은 중단하고, 단일 Offer의 공급사도 입력 RP 코드와 같아야 한다. | `NO_OFFER`, `MULTI_OFFER`, `SUPPLIER_MISMATCH` |
| 4 | `Offer.priceTerms`에서 `termMonths`가 같은 행을 찾는다. | `NO_TERM` |
| 5 | 같은 개월이 여럿이면 월대여료와 보증금으로 좁힌다. 일치 0개면 `rent`, `deposit`, `DEPOSIT_UNKNOWN` 상세와 참고 수수료를 함께 반환하지만 확정하지 않는다. 일치 2개 이상은 중단한다. | `CONDITION_MISMATCH`, `MULTI_TERM` |
| 6 | 선택된 가격행의 `termKey`로 `toInternalFeeLookup(offer.id, offer.priceTerms, offer.internalEconomicsTerms)` 결과를 가져온다. 청구·지급 중 하나라도 미확정이면 확정 연결이 아니라 보류한다. | `FEE_UNCONFIRMED` |

결과 모양은 `{ status, failure?, detail?, assetId?, productId?, offerId?, offerRevision?, priceTerm?, fees? }`다. `status`는 `LINKED`, `FEE_UNCONFIRMED`, `FAILED` 중 하나이며 가능한 단계까지의 id는 실패 결과에도 남긴다. `priceTerm`은 `{ termKey, termMonths, monthlyRent, deposit, depositState }`, `fees`는 기존 `InternalFeeLookupTerm`이다. `CONDITION_MISMATCH`는 참고 수수료를 줄 수 있어도 `FAILED`이며 정산 확정으로 쓰지 않는다.

접수 시점 스냅샷 계획: 접수 줄에는 조회 결과의 `offerRevision`과 선택된 `priceTerm.termKey`를 남긴다. 과거 revision 값을 다시 열람하는 기능은 후속 PR에서 `catalog_entity_revisions`를 읽어 같은 `offerRevision`의 당시 Offer를 복원하는 방식으로 추가한다. 이 PR은 현재 Catalog 목록에 대한 읽기 전용 연결만 제공하고 과거 revision 조회·저장·운영 API 추가는 하지 않는다.

## HTTP 문: Admin 계약-가격행-수수료 링크

- 경로: `POST /v1/consumers/freepass-admin-catalog/contract-fee-links`
- 권한: `freepass-admin-catalog` 소비자 전용 Bearer token + `contract-fee-link-read` capability. `erp-com`, 화이트라벨, 카카오, internal-ai 등 다른 소비자는 403이다.
- 성격: 읽기 전용. 요청 1회마다 `listVehicleAssets`, `listProducts`, `listOffers`를 각각 1회만 읽고, 각 항목은 `resolveContractFeeLink` 순수 함수로 판정한다. 새 저장·수정·쓰기 포트 호출은 없다.
- 본문: `{ "items": [{ "key": "admin-row-id", "assetId": "optional", "plate": "optional", "supplierId": "supplier_demo", "termMonths": 36, "monthlyRent": 690000, "deposit": 3000000 }] }`
- 제한: `items` 1~500건, `key` 필수 1~120자·요청 안에서 중복 금지. `supplierId`, `termMonths` 양의 정수, `monthlyRent`, `deposit` 형식 오류나 중복 key는 전체 400이다.
- 응답: `{ "contract": "contract-fee-links/v1", "results": [{ "key": "...", "...ContractFeeLinkResult": "..." }] }`. 입력 순서와 key를 보존한다. 조회 실패는 항목별 `status:"FAILED"`와 `failure`로 반환한다.
- 공개 차단: 이 라우트는 Admin 내부 수수료 확인용이다. 공개 `/catalog`, `catalog-reference`, `internal-ai-reference` 소비자 응답에 수수료 필드를 추가하지 않는다.
