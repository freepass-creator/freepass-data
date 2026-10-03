# Legacy Normalization Rules — Catalog V1

The first legacy normalizer is intentionally conservative.

## 정제 순서

차종은 제조사 → 해당 제조사의 모델 → 해당 모델의 세부모델 → 해당 세부모델의 세부트림 순서로만 확정한다. 앞 단계가 미정이면 뒤 단계는 비우거나 HOLD하며, 동명 트림으로 상위 계층을 역추정하지 않는다. 원문 사실 묶음은 제조사·모델·세부모델을 함께 보존하고 분리한다. 승격은 원문 계층과 ACTIVE anchor의 부모·참조 관계를 먼저 검증하며, 세부모델은 PHASE canonicalName과 대조한다. 명시적 세부모델이 없는 기존 원문은 anchor로 보충하지 않고 HOLD한다. Catalog는 세부모델 없는 트림 후보를 저장 전에 거부하고, LINK에서 어느 한쪽이라도 세부모델이 공백이면 일치로 취급하지 않는다. 원문과 입력은 변경하지 않는다.

## Product type

Exact mapping:

- 신차렌트 -> NEW_RENT
- 중고렌트 / 재렌트 -> USED_RENT
- 신차구독 -> NEW_SUBSCRIPTION
- 중고구독 / 재구독 -> USED_SUBSCRIPTION
- 오공구독 -> OGONG_SUBSCRIPTION
- 픽업구독 -> PICKUP_SUBSCRIPTION

Unknown values produce an issue and are not guessed.

## Price key

Confirmed legacy keys include forms such as:

- 24
- 24_3만

The canonical PriceTerm carries both a stable termKey and normalized dimensions.

Example:

- source key: 24_3만
- termKey: source:24_3만
- termMonths: 24
- mileageLimitKmPerYear: 30000

## Deposit

Blank/null deposit means UNKNOWN.

Explicit numeric zero means ZERO.

A blank value must never be promoted to zero.

## Private price fields

fee, commission and fee_memo are not copied into ERP Public PriceTerm.

They remain source facts/private pricing data for a later internal projection design.

## Candidate before Canonical

The normalizer emits a candidate plus issues.

It does not allocate final VehicleModel/Product/Offer IDs and does not silently merge records.

Vehicle identity and Canonical linking require a separate mapping/authority stage.
