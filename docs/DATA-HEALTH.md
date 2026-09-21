# FreePass Data — Catalog Data Health v1

Status: **IMPLEMENTATION BASELINE / HOLD FOR FULL VALIDATION**
Date: **2026-09-21**

## Purpose

Catalog Data Health answers a narrow operational question:

> Can the current Catalog Canonical state and ERP public ACTIVE release be trusted for the checks that FreePass Data can prove now?

It is evidence-based. It does not return a vanity percentage and it does not claim that the whole FreePass Data platform is healthy when a dimension has not been implemented.

Implementation:

- `src/application/catalog-health.ts`
- `src/shared/stable-digest.ts`
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

New Projection Release Manifests carry `fieldEvidenceDigest`, a deterministic SHA-256 digest over the complete projection-lineage record set sorted by `lineageRecordId`.

The same shared stable-digest implementation is used by:

- release construction
- Memory/Firestore evidence staging
- Memory/Firestore READY promotion
- Catalog Data Health verification

This closes the previous gap where equal row counts could hide modified evidence content.

For new manifests:

- matching count + matching `fieldEvidenceDigest` → `PASS`
- same count but changed lineage content → `BLOCKED`
- mismatched count → `BLOCKED`

For legacy manifests that predate `fieldEvidenceDigest`:

- `lineageContentIntegrity.status = NOT_EVALUATED`
- `ACTIVE_RELEASE_LINEAGE_DIGEST_MISSING` warning
- overall result is at least `DEGRADED`
- an existing ACTIVE release without the digest is not reused by a new projection build

The field remains optional in the TypeScript manifest contract only for read compatibility with already-persisted legacy manifests. New evidence staging requires the digest.

Release promotion also re-reads persisted evidence and recomputes the digest before READY, so the check is not limited to post-activation health reporting.

## ACTIVE release reuse safety

Release reuse is an optimization, not an authority shortcut.

Before returning an existing ACTIVE release, the builder now re-verifies the **actual stored contents**:

- `stableDigest(currentActive.data) === currentActive.dataDigest`
- `stableDigest(currentManifest.canonicalInputs) === currentManifest.inputDigest`
- release ↔ manifest input/data digest agreement
- manifest/release IDs, projection/schema metadata, product/offer counts
- ACTIVE canonicalRevision ↔ manifest canonical inputs
- lineage count
- lineage content digest

If the stored ACTIVE payload or manifest canonicalInputs were modified while their digest strings were left unchanged, the release is **not reused**. The builder proceeds through a new release path instead.

Regression tests cover both payload tamper and canonical-input tamper on the ACTIVE reuse path.

## READY / ACTIVE promotion consistency

The evidence digest is enforced both when staging and when promoting a release.

Memory adapter:
- revalidates lineage before READY
- revalidates lineage again before ACTIVE

Firestore adapter:
- READY transition reads release + manifest + lineage query and writes READY inside one Firestore transaction
- ACTIVE transition again reads release + manifest + lineage query and switches the active pointer inside one Firestore transaction

This removes the previous read-then-separate-update TOCTOU window from the normal adapter path. Firestore server transactions provide serializable isolation; concurrent changes to data read by the transaction cause contention/retry rather than silently committing against the older read.

This does not authorize arbitrary external writers to projection evidence. Writer/IAM boundaries remain separate controls.

## Versioned read contract

Catalog Data Health now has an explicit response contract:

- `contractVersion = catalog-data-health-v1`
- `schemaVersion = 1.0.0`
- `contracts/catalog-data-health-v1.schema.json`

The JSON Schema uses `additionalProperties: false` at contract boundaries so accidental API drift is rejected rather than silently accepted.

Contract tests validate generated reports and reject changed contract identity or undeclared top-level fields.

## Shared projection integrity verifier

`src/application/projection-integrity.ts` is the single pure verifier used by both:

- ACTIVE release reuse
- Catalog Data Health

It verifies the actual release payload, manifest canonical inputs, release/manifest identity and metadata, product/offer counts, canonical revision, evidence count, and lineage content digest.

This prevents the previous failure mode where Health and release reuse implemented similar integrity checks independently and one path lagged behind the other.

## ACTIVE observation fence

Catalog Data Health re-reads the ACTIVE release at the end of the observation.

The report includes:

- `startActiveReleaseId`
- `endActiveReleaseId`
- `activeReleaseStable`

If the ACTIVE release changes during the observation window, the report emits `ACTIVE_RELEASE_CHANGED_DURING_OBSERVATION` and is at least `DEGRADED`.

This does not create an atomic snapshot. `CONSISTENT_SNAPSHOT` remains not evaluated, but a detected release switch can no longer be hidden behind a clean report.

## Projection evidence snapshot capability

Projection evidence can now be read through an optional `ProjectionEvidenceSnapshotStore` capability.

Memory and Firestore implement:

- active pointer
- ACTIVE release
- Projection Release Manifest
- projection lineage

as one evidence snapshot.

Firestore performs this read inside a transaction and reports:

`projectionEvidenceConsistency = ATOMIC`

Legacy/mocked readers that do not implement the capability continue through an explicit fallback:

`projectionEvidenceConsistency = PARTIAL_MULTI_READ`

This improves Projection evidence consistency without falsely claiming that the entire Catalog Health report is one atomic snapshot.

## Current Canonical revision integrity

Catalog Data Health now compares every current Canonical entity with Revision History for the **same entity ID and revision**.

Checks cover:

- VehicleModel
- VehicleAsset
- Product
- Offer
- Policy

Results:

- matching immutable revision snapshot → PASS
- revision snapshot missing → WARNING / DEGRADED because integrity cannot be proven
- same revision but current entity content differs from revision snapshot → ERROR / BLOCKED

This closes the gap where a Canonical entity could be modified in-place without incrementing its revision and remain invisible until a projection rebuild.

## ACTIVE input parity with current Canonical

The ACTIVE manifest's exact `canonicalInputs` are compared with current Canonical state.

The check deliberately covers only inputs the manifest claims to use; it does not infer that every current Canonical entity must be published.

Results:

- same revision and validation status → PASS
- current Canonical revision newer than ACTIVE input → WARNING / DEGRADED
- ACTIVE input revision ahead of current Canonical → ERROR / BLOCKED
- ACTIVE input entity missing from current Canonical → ERROR / BLOCKED
- validation status mismatch → WARNING / DEGRADED

This is `ACTIVE_PROJECTION_INPUT_PARITY`, not Source → Canonical parity.

## Single projection integrity verifier

The pure verifier lives at:

`src/shared/projection-integrity.ts`

It is reused by:

1. release reuse
2. Catalog Data Health
3. Memory staging / READY / ACTIVE gates
4. Firestore staging / READY / ACTIVE gates
5. dedicated integrity tests

The verifier covers:

- actual release payload digest
- manifest data digest link
- actual manifest canonical-input digest
- release/manifest input digest link
- manifest/release/projection/schema identity
- product/offer counts
- canonical revision
- evidence count
- lineage content digest

The shared layer is now protected by the architecture checker: `shared` cannot depend on ports/application/adapters/infra/api/jobs/migration and cannot import Firebase SDKs.

## Projection lineage identity semantics

Lineage content integrity is not only a digest check.

The shared verifier also rejects evidence when:

- a lineage record points to the wrong `releaseId`
- a lineage record points to the wrong `projectionId`
- a lineage record stage is not `CANONICAL_TO_PROJECTION`
- duplicate `lineageRecordId` values exist

These checks still fail even if an attacker or broken writer recomputes `fieldEvidenceDigest` after changing the invalid records.

This prevents a semantically invalid evidence set from becoming trusted merely because its bytes are self-consistent.

## Firestore emulator validation hook

`tests/firestore-projection-integrity.emulator.test.ts` is conditional on `FIRESTORE_EMULATOR_HOST`.

When an emulator is available it verifies:

- >400 evidence rows, forcing multi-chunk evidence staging
- READY and ACTIVE promotion
- atomic active-evidence snapshot read
- READY → ACTIVE lineage tamper rejection

Without an emulator the test is skipped and must be reported as **NOT_RUN**, not PASS.

## Observation consistency

Catalog Data Health v1 is **not a whole-Catalog atomic snapshot**. Projection evidence may be atomic while Canonical entity/revision reads remain separate.

Canonical entities and Revision History are still read separately from the Projection evidence snapshot. Memory/Firestore Projection evidence can be read atomically, while legacy readers explicitly fall back to partial multi-read. During concurrent updates, the report can therefore still combine Canonical state from one moment with Projection evidence from another.

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

With a new manifest containing valid data, canonical-input, and lineage-content digests, a normal release can be `HEALTHY`. Legacy manifests without lineage digest remain `DEGRADED`.

## Explicitly not evaluated yet

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
7. **legacy manifest without lineage digest**
8. **same-count lineage tamper rejected before READY promotion**
9. **ACTIVE release without lineage digest is not reused**
10. **tampered ACTIVE payload with unchanged dataDigest is not reused**
11. **tampered ACTIVE manifest canonicalInputs with unchanged inputDigest is not reused**
12. **lineage tamper between READY and ACTIVE is rejected**

## Next safe extension

1. Run full integrated validation on the stacked consumer-runtime + Data-Health branch.
2. After PR #23 and PR #25 land, rebase the API integration into a small standalone follow-up.
3. Shadow-test the authenticated `catalog-health` route with a read-only service identity before any consumer cutover.
4. Preserve whole-report `PARTIAL_MULTI_READ` semantics until Canonical + Projection can share a snapshot/revision-token boundary.
5. Add Source Registry/freshness only as a later isolated unit.
6. Add Consumer Registry health only after migration-state contracts are fixed.

No production writer cutover, Firebase IAM change, or consumer cutover is authorized by this health read model.
