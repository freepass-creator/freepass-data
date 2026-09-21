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

1. Re-run the full integrated test suite on the updated branch.
2. Connect the proven Data Health read model to the existing authenticated/read-only consumer API boundary.
3. Keep the API response read-only and versioned; do not expose raw Firestore topology.
4. Preserve `PARTIAL_MULTI_READ` until an atomic snapshot/revision-token strategy exists.
5. Add Source Registry/freshness only as a later isolated unit.
6. Add Consumer Registry health only after migration-state contracts are fixed.

No production writer cutover, Firebase IAM change, or consumer cutover is authorized by this health read model.
