# FreePass Vehicle Master — Reference Import

Status: implementation baseline, 2026-10-04. **실행 막음(2026-10-04, AI 상황실 사후 검토)** — `npm run ingest:vehicle-reference` 는 어떤 환경 변수로도 쓰지 않고 `VEHICLE_REFERENCE_IMPORT_BLOCKED` 로 끝난다. 기존 차종 마스터 적재 경로(capture → ingest → promote)로 합친 뒤에만 다시 연다. 이유: 시험 실행 기본값·Catalog 쓰기 주인(EXCLUSIVE) 검사·access.write 기록 없이 운영 Firestore·Storage 에 바로 쓰는 두 번째 쓰기 길이었다.

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
