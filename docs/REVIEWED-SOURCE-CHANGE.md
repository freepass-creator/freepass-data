# Reviewed Source Change — Catalog V1

Status: **IMPLEMENTED BASELINE**

A changed source fingerprint never overwrites Canonical automatically.

FreePass Data first compares the accepted current source Candidate with the Canonical entities already bound to that source record.

## 1. Flow

```text
new Source Head / Candidate
  -> compare with Canonical binding
  -> SourceChangeReview
      -> REVIEWABLE changes
      -> BLOCKED structural/identity changes
  -> operator/service review
  -> exact approval set + expected revisions
  -> atomic Canonical update
  -> binding advance
  -> Revision / Audit / Lineage
  -> Outbox
  -> evidence-gated Release
```

## 2. Reviewable V1 changes

The first safe update packet supports:

- existing Offer PriceTerm monthly rent
- deposit state
- deposit amount/presence
- annual mileage limit
- existing VehicleAsset odometer

These fields have explicit Field Authority rules and `PRESERVE_CANONICAL_AND_REVIEW` source-refresh policy.

## 3. Blocked V1 changes

The update fails closed when the new source attempts to change:

- maker / model identity
- shared VehicleModel fields such as subModel/trim/fuel/drive/seats
- vehicle plate identity
- commercial type
- source supplier-code mapping
- PriceTerm set/keys
- term months
- currency

These changes require separate purpose-specific commands because they can change identity, shared master meaning, or commercial structure.

No safe fields are partially applied while a blocked change remains.

## 4. Exact approval

The command must approve the **entire current reviewable diff set**.

Partial approval is rejected.

This is intentional: the source binding may advance to the new fingerprint only after every current source difference has been resolved.

Candidate warning/issues must also be approved exactly.

## 5. Concurrency

The review exposes:

- binding revision
- VehicleModel revision
- Product revision
- Offer revision
- VehicleAsset revision when present
- current accepted source-head run ID

The apply command pins all of them.

If any entity changes after the preview, the command fails with a conflict and the operator's review can be regenerated.

## 6. Source supplier mapping

Source supplier codes and Canonical supplier IDs are separate meanings.

Example:

`SUP-LEGACY -> supplier:reviewed-legacy`

The source code is stored on the CanonicalSourceBinding as `sourceSupplierCode`.

A later source refresh compares the new source supplier code with this bound source code, not with the Canonical supplier ID.

## 7. Binding advance

After a complete approved review, the binding advances to:

- new source fingerprint
- new source run
- new observed time
- new checkpoint revision/checksum
- new source supplier code evidence
- binding revision + 1

If the raw fingerprint changed but normalized Canonical values did not, the binding may advance with a `NO_CHANGE` receipt and without creating a new Canonical entity revision.

## 8. Canonical evidence

Changed Offer/VehicleAsset entities receive:

- revision + 1
- `SOURCE_REFRESH` Revision Snapshot
- append-only Audit event
- new `NORMALIZED_TO_CANONICAL` lineage for fields that came from the changed Candidate

The subsequent Projection Release can therefore resolve those changed fields back to the new source lineage.

Unchanged fields in the new entity revision remain truthfully supported by the immutable Revision Snapshot.

## 9. Console UX

Review screen:

- source before/after fingerprint
- source run/freshness
- Canonical revision baseline
- each changed field
- before / after
- REVIEWABLE / BLOCKED
- Authority rule
- candidate warnings
- affected entity
- approval checkbox only for REVIEWABLE fields
- required reason

The Save action is disabled while any BLOCKED change exists.

The Console does not offer a generic "accept all source JSON" operation.

## 10. Security boundary

This packet adds semantic writer/authority enforcement but does not expose a public HTTP write route.

Authenticated runtime identity/IAM remains required before external Console/consumer mutation endpoints are opened.
