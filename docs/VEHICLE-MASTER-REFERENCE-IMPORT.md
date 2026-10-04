# FreePass Vehicle Master — Reference Import

Status: implementation baseline, 2026-10-04.

## Decision

- Vehicle Master lives only in FreePass Data.
- This ingestion path has no dependency on F03.
- Repository, folder, branch, job, and schema names use FreePass-owned neutral naming.
- External provenance is retained only as private/opaque evidence needed for audit.
- Source bytes are immutable; normalized records never overwrite source evidence.

## Canonical target

FreePass Vehicle Master hierarchy remains:

`MAKE -> MODEL -> GENERATION -> PHASE -> MODEL_YEAR -> POWERTRAIN -> VARIANT -> TRIM`

The reference import first preserves the external taxonomy exactly as RAW and normalized evidence. Canonical promotion remains governed by the existing Vehicle Master evidence and revision rules.

## Input contract

Schema: `freepass-vehicle-reference/v1`

Top level:
- `observedAt`
- `revision` (optional)
- `provenanceRef` (opaque reference; persisted only as a digest)
- `records[]`

Each record:
- `maker`
- `series`
- `model`
- `generation` / `phase` (optional)
- `fromYear` / `toYear` (optional)
- `aliases[]`
- `sourceIds{}`
- `attributes{}`
- `variants[]`

The import lane is intentionally source-neutral so additional licensed/reference datasets can use the same path.
