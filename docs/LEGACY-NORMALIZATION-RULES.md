# Legacy Normalization Rules — Catalog V1

The first legacy normalizer is intentionally conservative.

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
