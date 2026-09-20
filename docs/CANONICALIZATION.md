# Safe Catalog Canonicalization — Catalog V1

Status: **IMPLEMENTED BASELINE**

This is the first controlled path from a normalized source candidate into Canonical Catalog entities.

## 1. Canonicalization is a reviewed command

FreePass Data does not auto-promote every normalized candidate.

The command requires:

- candidate ID
- expected accepted source-head run ID
- reviewed VehicleModel identity decision: CREATE or LINK
- reviewed VehicleAsset identity decision when a real car number exists
- reviewed supplier ID
- explicit approval of every warning issue
- actor and reason

## 2. Source evidence gate

The candidate may be canonicalized only when:

- source run is completed
- run is the current accepted source head
- source head completeness is COMPLETE
- candidate/run/head/checkpoint source identities agree
- expected head still matches inside the same persistence transaction
- candidate envelope fingerprint and normalized payload fingerprint agree

This makes head verification and Canonical persistence one atomic decision in the Firestore adapter.

## 3. Identity rules

VehicleModel and VehicleAsset identities are never guessed from a raw string alone.

A reviewer must explicitly choose CREATE or LINK.

Product and Offer identities are source-binding scoped opaque IDs derived from:

- source ID
- source record ID

The source record therefore does not create duplicate Product/Offer entities when reprocessed with the same canonical binding.

VehicleModel now keeps `generation` and `subModel` as separate fields. A supplier `sub_model` value is not silently rewritten as generation.

## 4. Source binding

Every first successful canonicalization creates one immutable source binding containing:

- source ID / record ID / fingerprint
- source run ID
- source observation time
- checkpoint revision/checksum
- VehicleModel / VehicleAsset / Product / Offer IDs
- actor and timestamps

Same source record + same fingerprint:

- no duplicate Canonical entities
- returns a `NO_CHANGE` canonicalization receipt

Same source record + changed fingerprint:

- does not overwrite Canonical automatically
- returns `SOURCE_CHANGED_REVIEW_REQUIRED`

A later explicit re-canonicalization/update command will own reviewed source changes.

## 5. Lineage gate

Fields written into Canonical must already have normalized lineage evidence.

The baseline requires lineage for:

- maker / model
- subModel / trim / fuel / drive / seats when present
- commercial type
- real-car number / mileage when present
- every PriceTerm monthly rent
- deposit state
- deposit amount when present
- term months
- mileage limit when present

Canonicalization writes a second append-only lineage stage:

`RAW_TO_NORMALIZED -> NORMALIZED_TO_CANONICAL`

Each new record points to its parent lineage record.

## 6. Transaction contents

The first successful Canonical commit writes, in one Catalog transaction:

- VehicleModel CREATE when reviewed
- VehicleAsset CREATE when reviewed
- Product
- Offer + PriceTerms
- Canonical source binding
- NORMALIZED_TO_CANONICAL lineage
- Audit evidence
- durable Outbox event
- Canonicalization receipt

The Outbox worker then rebuilds and activates a new validated ERP Public projection release.

## 7. Deliberately not implemented in this packet

- automatic update of an existing binding after source fingerprint change
- automatic VehicleModel merge
- automatic VehicleAsset merge
- Policy mapping from an external policy code
- public HTTP canonicalization route before authentication/authorization work
- GitHub Actions
- production writer cutover
