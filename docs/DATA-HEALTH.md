# FreePass Data — Catalog Data Health v1

Status: **IMPLEMENTATION BASELINE / CATALOG V1**
Date: **2026-09-21**

## Purpose

Catalog Data Health answers a narrow operational question:

> Can the current Catalog Canonical state and ERP public ACTIVE release be trusted for the checks that FreePass Data can prove now?

It is intentionally evidence-based. It does not return a vanity percentage and it does not claim that the whole FreePass Data platform is healthy when a dimension has not yet been implemented.

Implementation:

- `src/application/catalog-health.ts`
- `tests/catalog-health.test.ts`

## Evaluated checks

### 1. Canonical validation

Counts Canonical entities marked `INVALID` across:

- VehicleModel
- VehicleAsset
- Product
- Offer
- Policy

An INVALID entity degrades the report. It is not silently treated as publishable truth.

### 2. Referential integrity

Fails closed when a Canonical reference points to a missing entity:

- VehicleAsset → VehicleModel
- Product → VehicleModel
- Product → VehicleAsset
- Offer → Product
- Offer → Policy

A broken reference makes the report `BLOCKED`.

### 3. ACTIVE projection evidence

For `erp-public`, the read model checks:

- an ACTIVE release exists
- the active pointer resolves to release status `ACTIVE`
- a Projection Release Manifest exists
- release and manifest IDs/digests agree
- manifest product/offer counts agree with release data
- manifest field-evidence count agrees with stored projection lineage

Missing ACTIVE release is `DEGRADED`.
Contradictory or missing evidence on an existing ACTIVE release is `BLOCKED`.

## Overall status

The current implementation returns:

- `HEALTHY` — all implemented checks pass
- `DEGRADED` — warning exists, but no implemented invariant is broken
- `BLOCKED` — at least one implemented invariant fails

**Important:** overall status applies only to the explicitly listed evaluated checks.

## Explicitly not evaluated yet

Catalog Data Health v1 reports these dimensions as not evaluated:

- `SOURCE_FRESHNESS`
- `SOURCE_TO_CANONICAL_PARITY`
- `CONSUMER_MIGRATION_STATE`

They must not be inferred from a `HEALTHY` result.

The current CatalogStore does not expose a complete source-registry/source-head listing contract, so source freshness should not be guessed from partial records. Add that contract deliberately before implementing freshness.

## Next safe extension

1. Add a versioned Source Registry read contract.
2. Add source-head listing without exposing raw persistence topology.
3. Define freshness thresholds per source.
4. Extend Data Health with HEALTHY / STALE / BLOCKED source states.
5. Add consumer migration-state health only after the Consumer Registry contract is fixed.
6. Expose the read model through an authenticated/read-only API before building richer Console UI.

No production writer cutover, Firebase IAM change, or consumer cutover is authorized by this health read model.
