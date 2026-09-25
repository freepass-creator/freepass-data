# FreePass Estimate New-car Master Contract v1

Status: **CONTRACT IMPLEMENTED / ACTIVE RELEASE NOT YET AVAILABLE**  
Date: 2026-09-25

## Purpose

FreePass Estimate must not reconstruct its own vehicle master from ERP4/static snapshots.

The approved read path is:

`FreePass Data Canonical -> estimate-newcar-master ACTIVE Release -> FreePass Estimate`

This projection is separate from `erp-public`. ERP publication data is optimized for product/offer distribution and does not carry the stable model-year/trim/powertrain/option/color identity required to seal an immutable Quote.

## Contract

Schema:

`contracts/estimate-newcar-master-v1.schema.json`

Projection ID:

`estimate-newcar-master`

Consumer:

`freepass-estimate`

Capability:

`estimate-newcar-master`

Endpoint:

`GET /v1/consumers/freepass-estimate/estimate-newcar-master`

The service token is unique to Estimate and must not be shared with ERP/white-label consumers.

## Required stable identity

Every record carries:

- productId
- vehicleModelId
- modelYearId
- trimId
- powertrainId
- maker/model/modelYear
- trim/powertrain labels
- base price
- options with optionId, price, requires, excludes, exclusiveGroupId
- exterior colors with stable colorId and price
- interior colors with stable colorId and price
- configuration axes
- ACTIVE/HOLD status

A label, sequence number, legacy `master_id`, or UI-generated hash is not a substitute for a missing stable ID.

## Semantic gates

Schema validity alone is not sufficient.

The gateway rejects releases when:

- productId or trimId is duplicated
- optionId is duplicated within a product
- requires/excludes references an unknown option
- an option requires/excludes itself
- the same option is both required and excluded
- color IDs are duplicated in the same color domain
- ACTIVE records have no exterior or interior color
- ACTIVE records carry HOLD reasons
- HOLD records have no reason

## Release evidence

The consumer only receives a release when all of the following are true:

- status = ACTIVE
- projectionId = estimate-newcar-master
- schemaVersion = 1.0.0
- manifest/release identity matches
- canonical input digest matches
- data digest matches the returned payload
- activation time is valid

The response includes:

- authority = CANONICAL_ACTIVE
- releaseId
- manifestId
- revision
- inputDigest
- dataDigest
- generatedAt
- activatedAt

These values are the evidence FreePass Estimate seals into Quote source provenance.

## Current blocker: model year

The current FreePass Estimate static DB builder contains a legacy `year: 2026` display default.

That value is **not** accepted as model-year authority.

An Estimate Master record may be ACTIVE only when the model year and `modelYearId` come from reviewed FreePass Data source/canonical evidence. Until then the affected record must remain HOLD.

## Current blocker: publication

This change defines the read contract and fail-closed consumer boundary. It does not fabricate an ACTIVE release.

The next implementation unit is a reviewed builder/ingestion path that supplies this projection from FreePass Data-owned source evidence with stable IDs and a complete release manifest.

RTDB is not a fallback.
