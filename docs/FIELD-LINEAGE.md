# Catalog V1 Field Lineage

Status: **BASELINE IMPLEMENTED — RAW → NORMALIZED**

FreePass Data records field-level provenance as an append-only chain.

## Stages

1. `RAW_TO_NORMALIZED`
2. `NORMALIZED_TO_CANONICAL`
3. `CANONICAL_TO_PROJECTION`

Each stage is a new immutable record. Later stages reference earlier evidence instead of mutating history.

## Implemented now

Legacy `freepasserp3/firestore/products` ingestion records:

- source ID
- source record ID
- source fingerprint
- observed timestamp
- raw source field path/value
- normalized candidate ID
- normalized field path/value
- transform ID/version
- deterministic lineage ID

Examples:

- `product_type → commercialType`
- `price.24_3만.rent → priceTerms.source:24_3만.monthlyRent.amount`
- `price.24_3만.deposit → ...depositState`

Blank/unknown deposit remains observable as source evidence and is not rewritten as zero.

## Next lineage packet

The next implementation should emit `NORMALIZED_TO_CANONICAL` records when a reviewed candidate becomes a canonical VehicleModel/Product/Offer/PriceTerm, then `CANONICAL_TO_PROJECTION` when an ACTIVE projection release is built.

This makes the final path inspectable:

`RAW → candidate → canonical revision → projection release`
