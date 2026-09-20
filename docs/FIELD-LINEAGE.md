# Catalog V1 Field Lineage

Status: **IMPLEMENTED — RAW → NORMALIZED → CANONICAL → PROJECTION**

FreePass Data records field-level provenance as an append-only evidence chain.

## Stages

1. `RAW_TO_NORMALIZED`
2. `NORMALIZED_TO_CANONICAL`
3. `CANONICAL_TO_PROJECTION`

Each stage is immutable. Later evidence references the prior source-lineage record when that exact Canonical revision/value still comes from source data.

When a Canonical value was changed by a reviewed command, Projection evidence points to the immutable Canonical Revision Snapshot instead of falsely attributing the new value to old RAW data.

## RAW → normalized

Source ingestion records:

- source ID
- source record ID
- source fingerprint
- observed timestamp
- raw source field path/value
- normalized candidate ID
- normalized field path/value
- transform ID/version

Examples:

- `product_type → commercialType`
- `price.24_3만.rent → priceTerms.source:24_3만.monthlyRent.amount`
- `price.24_3만.deposit → ...depositState`

Blank/unknown deposit remains source evidence and is never rewritten as zero.

## Normalized → Canonical

Reviewed Canonicalization records:

- parent RAW_TO_NORMALIZED lineage record
- Canonical entity type / ID
- exact Canonical revision
- Canonical field path/value
- canonicalizer transform/version

Critical Canonical fields cannot be promoted without normalized lineage evidence.

## Canonical → Projection

Every field emitted by ERP Public has Projection evidence containing:

- projection ID
- release ID
- Canonical entity type / ID / revision
- Canonical field path/value
- stable Projection field path/value
- evidence origin

Evidence origin:

- `SOURCE_LINEAGE` — exact matching Canonical lineage exists
- `REVISION_HISTORY` — current Canonical revision came from a reviewed mutation or otherwise resolves through its immutable Revision Snapshot

## Release evidence

Every ACTIVE Release has an exact manifest containing:

- exact Canonical input revisions
- product/offer counts
- field evidence count
- input digest
- data digest

The complete inspectable chain is now:

`RAW → Candidate → Canonical revision → Projection field → Release → Consumer`

See also [PROJECTION-RELEASE-EVIDENCE.md](./PROJECTION-RELEASE-EVIDENCE.md).
