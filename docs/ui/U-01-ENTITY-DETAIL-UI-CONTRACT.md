# U-01 Entity Detail UI contract

Status: presentation boundary over existing `CatalogProductTrace`

## Purpose

Entity Detail is the read-only lineage explorer for one product.

It must answer:

- where did this value come from?
- what was preserved in RAW?
- how was it normalized?
- which Canonical entity/revision owns it?
- what Projection field was emitted?
- which local consumer surface reads it?
- which stage is HOLD/LOCAL_ONLY?

## Data source

The actual local UI consumes the existing authorized endpoint:

`GET /v1/console/products/:productId/trace`

No new entity-detail data API is introduced.

That endpoint already runs through the local Console data-access boundary and returns
`CatalogProductTrace`.

## Visible structure

Stage trace:
- SOURCE
- RAW
- NORMALIZED
- CANONICAL
- PROJECTION
- RELEASE
- CONSUMER

Field lineage:
- label / projection field
- origin
- RAW field/value
- adapter transform/version
- normalized field/value
- adapter mode + decision
- Canonical entity/id/revision/field/value
- Projection field/value
- Consumer name/location/value

## Boundary

U may:
- format contract values
- search visible field lineage
- present stage/status labels
- show missing stage rows as "관측 없음" presentation

U must not:
- call catalog stores directly
- rebuild lineage
- choose lineage parents
- derive adapter mode
- recalculate field priority
- infer Canonical revision or Projection value

All lineage semantics remain owned by `buildCatalogProductTrace()` and its underlying data contracts.
