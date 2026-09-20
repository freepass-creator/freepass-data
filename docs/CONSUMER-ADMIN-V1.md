# FreePass Admin Catalog Consumer Contract V1

Status: CONTRACT LOCKED / ENDPOINT NOT ACTIVE
Date: 2026-09-21

## Purpose

FreePass Admin의 상품찾기/접수 화면이 FreePass Data internal Firestore collection을 직접 알지 않게 한다.
Admin은 ACTIVE Projection Release의 versioned consumer contract만 읽는다.

Target endpoint:

`GET /v1/views/admin-catalog/products`

Envelope schema:

`freepass-data.admin-catalog/v1`

JSON Schema:

`contracts/admin-catalog-view-v1.schema.json`

## Ownership

FreePass Data owns:
- VehicleModel / VehicleAsset / Product / Offer / PriceTerm / Policy canonical facts
- projection release id / revision / freshness
- supplier-specific Offer identity
- deposit state semantics
- normalized policy values
- source/canonical lineage

FreePass Admin owns:
- search interaction and workflow
- Application Snapshot
- contract/progress facts
- Performance review
- Settlement/Billing/Collection/Payout workflow

Admin must not infer internal Data collection paths.

## Critical shape differences from erp-public

`erp-public` is not sufficient as the Admin contract.

Admin additionally requires:
- VIN and registration facts when available
- exact supplier on each Offer
- Offer revision
- PriceTerm key provenance
- policy values as typed facts (`policyId`, `type`, `value`)
- explicit deposit state; UNKNOWN must never become zero
- release metadata for Snapshot provenance

## Offer/PriceTerm rule

FreePass Data keeps:

`Product -> Offer -> PriceTerm[]`

Admin may flatten one PriceTerm into one searchable runtime Offer, but must retain:
- `sourceOfferId`
- `sourceOfferRevision`
- `sourcePriceTermKey`

This preserves same-Offer search while keeping a reversible reference to Data Canonical.

Supplier authority is Offer-level.
A Product may contain Offers from more than one supplier.
Consumers must not assume one Product = one supplier.

## Deposit semantics

- `ZERO` -> 0
- `KNOWN` -> explicit KRW amount
- `UNKNOWN` -> unknown; never 0
- `NOT_APPLICABLE` -> not applicable; never silently 0

Projection release must fail validation if `KNOWN` has no valid KRW amount.

## Policy parity gate

Admin read cutover is BLOCKED until policy values used by Admin search are normalized into the consumer projection.

At minimum parity must be demonstrated for currently used searchable policies such as:
- driver age
- annual/max mileage
- deposit/card/installment facts
- payment timing/method facts that are exposed as searchable policy
- other approved Policy Definition keys

Raw Policy `facts` objects are not a stable consumer contract.
Admin must not parse legacy policy documents itself after Data cutover.

## Cutover sequence

1. OBSERVE
2. SHADOW_READ
3. compare legacy ERP5 adapter vs `admin-catalog/v1`
4. PARITY_VERIFIED
5. set Admin `FPA_PRODUCT_SOURCE=freepass-data`
6. DATA_GATEWAY_READ
7. remove direct ERP5 Product read only after runtime evidence

Application/Performance/Settlement write migration is separate.
Catalog read cutover must not force operational writer cutover.

## Parity dimensions

- product identity
- VehicleModel identity/axes
- VehicleAsset plate/VIN/odometer
- Offer identity
- supplier per Offer
- term months
- monthly rent
- deposit value + deposit state
- mileage limit
- policy values
- active/suspended availability
- release freshness
- missing/extra records

## Fail-closed rules

Do not activate the release for Admin if:
- schema validation fails
- active Product has no searchable Offer terms
- monthly rent is invalid
- known deposit is incomplete
- Offer supplier is missing
- policy parity is incomplete for an approved searchable field
- release freshness exceeds the agreed threshold

## Write boundary

Catalog V1 Admin consumer is READ ONLY.
Admin product edits later use FreePass Data Commands with expectedRevision / authority / audit / receipt.
Admin must not write Data Firestore collections directly.
