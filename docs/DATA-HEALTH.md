# FreePass Data — Catalog Data Health v1

Status: **IMPLEMENTATION BASELINE / HOLD FOR FULL VALIDATION**
Date: **2026-09-21**

## Purpose

Catalog Data Health answers a narrow operational question:

> Can the current Catalog Canonical state and ERP public ACTIVE release be trusted for the checks that FreePass Data can prove now?

It is evidence-based. It does not return a vanity percentage and it does not claim that the whole FreePass Data platform is healthy when a dimension has not been implemented.

Implementation:

- `src/application/catalog-health.ts`
- `src/application/stable-digest.ts`
- `tests/catalog-health.test.ts`

## Reuse pre-review — COMPOSE_OR_EXTEND

This work must not create another health truth or another persistence layer.

Existing capabilities were reviewed first:

- `GET /health` — runtime/process liveness only. It cannot prove data integrity.
- Projection Release / Manifest / Lineage — already owns projection evidence and is reused directly.
- CatalogStore — already owns Canonical reads and is reused directly.
- `docs/ARCHITECTURE-V2-APPROVED.md` — requires stable serving contracts and evidence-driven migration.
- `docs/FIREBASE-CONTROL-PLANE.md` — defines Console/read surfaces over existing contracts rather than raw Firestore CRUD.

Decision: **COMPOSE_OR_EXTEND**.

Catalog Data Health is a read model that composes existing Catalog + Projection contracts. It adds no database, collection, writer, parallel SSOT, or generic Firestore health store.

## Evaluated checks

### 1. Canonical validation

Counts Canonical entities marked `INVALID` across:

- VehicleModel
- VehicleAsset
- Product
- Offer
- Policy

An INVALID entity degrades the report.

### 2. Referential integrity

Fails closed when a Canonical reference points to a missing entity:

- VehicleAsset → VehicleModel
- Product → VehicleModel
- Product → VehicleAsset
- Offer → Product
- Offer → Policy

A broken reference makes the report `BLOCKED`.

### 3. ACTIVE projection metadata and payload integrity

For `erp-public`, the read model checks:

- ACTIVE release existence and status
- Projection Release Manifest existence
- stored release ↔ manifest ID/digest agreement
- manifest product/offer counts ↔ release data counts
- manifest field-evidence count ↔ stored projection-lineage count
- **actual `release.data` SHA-256 stable digest recomputation**
- **actual `manifest.canonicalInputs` SHA-256 stable digest recomputation**

The same canonical stable-digest implementation is shared with the release builder so the verifier does not invent a second serialization rule.

If `release.data` or `manifest.canonicalInputs` is changed while the stored digest is left unchanged, the report is `BLOCKED`.

## Projection lineage content integrity

Current `ProjectionReleaseManifest` stores `fieldEvidenceCount`, but it does **not** store a digest over projection-lineage contents.

Therefore v1 can prove the count but cannot authenticate the content.

When evidence rows exist:

- `lineageContentIntegrity.status = NOT_EVALUATED`
- `PROJECTION_LINEAGE_CONTENT_INTEGRITY` stays in `coverage.notEvaluated`
- the projection check is `WARN`
- overall result cannot become `HEALTHY`; it remains at least `DEGRADED`

A regression test explicitly changes lineage content while preserving the same row count and verifies that the system does not claim content integrity.

Do not upgrade this to PASS until the evidence contract includes a deterministic lineage-content digest or equivalent authenticated proof.

## Observation consistency

Catalog Data Health v1 is **not an atomic snapshot**.

Catalog entities, ACTIVE release, manifest, and lineage are read through separate non-transactional calls. During concurrent updates, the report can combine values observed at different moments.

The response therefore includes:

- `observation.readAt`
- `observation.consistency = PARTIAL_MULTI_READ`
- `observation.partialObservation = true`
- observed Canonical revision range
- ACTIVE release canonical revision

`CONSISTENT_SNAPSHOT` remains explicitly not evaluated.

Do not interpret a clean check result as proof that every value came from one transaction/read timestamp.

## Overall status

- `HEALTHY` — all implemented checks pass and no evaluated/critical evidence warning exists
- `DEGRADED` — warning or explicit critical non-evaluation exists, but no implemented invariant is broken
- `BLOCKED` — at least one implemented invariant fails

With the current lineage contract, a non-empty ACTIVE release is expected to be at least `DEGRADED`, not `HEALTHY`.

## Explicitly not evaluated yet

- `PROJECTION_LINEAGE_CONTENT_INTEGRITY`
- `CONSISTENT_SNAPSHOT`
- `SOURCE_FRESHNESS`
- `SOURCE_TO_CANONICAL_PARITY`
- `CONSUMER_MIGRATION_STATE`

These must not be inferred from other PASS checks.

## Counterexample coverage

Tests include:

1. broken Canonical reference
2. no ACTIVE release
3. evidence-count mismatch
4. **release.data content tamper with unchanged digest**
5. **manifest canonicalInputs tamper with unchanged digest**
6. **same-count lineage content tamper**

## Next safe extension

1. Add lineage-content digest/equivalent evidence to the release contract.
2. Add an atomic/snapshot read boundary or revision-token strategy for health observation.
3. Add a versioned Source Registry read contract.
4. Add source-head listing and freshness thresholds.
5. Add Consumer Registry health after migration-state contracts are fixed.
6. Expose the read model through an authenticated/read-only API only after the contract is stable.

No production writer cutover, Firebase IAM change, or consumer cutover is authorized by this health read model.
