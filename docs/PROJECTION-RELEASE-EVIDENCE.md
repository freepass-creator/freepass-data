# Projection Release Evidence — Catalog V1

Status: **IMPLEMENTED BASELINE**

This contract completes the Catalog V1 evidence chain from Canonical data into a consumer-visible Projection Release.

## 1. Evidence chain

```text
Source
  -> RAW
  -> Normalized Candidate
  -> Canonical entity revision
  -> Projection field
  -> Release Manifest
  -> ACTIVE consumer release
```

A consumer-visible value must be attributable to the exact Canonical entity revision used to produce it.

## 2. Release Manifest

Every ERP Public release now has a manifest containing:

- release ID / projection ID / schema version
- generated time
- exact Canonical input set
  - entity type
  - entity ID
  - revision
  - validation status
- product count
- offer count
- projection field evidence count
- input digest
- data digest

The old single `canonicalRevision` maximum is retained as convenience metadata, but it is not treated as sufficient provenance.

The manifest's exact input set is authoritative evidence for what the release consumed.

## 3. Field-level Canonical -> Projection evidence

Every field emitted by the ERP Public projection gets a `CANONICAL_TO_PROJECTION` evidence record.

Stable field paths are keyed by entity IDs rather than array indexes.

Example:

```text
Canonical
offer/off_123 r2
priceTerms.36@20000.monthlyRent.amount = 730000

        ↓

ERP Public Release rel_xxx
products.prod_123.offers.off_123.priceTerms.36@20000.monthlyRent.amount = 730000
```

## 4. Evidence origin

Projection field evidence distinguishes two cases.

### SOURCE_LINEAGE

When the exact Canonical field/revision still has matching `NORMALIZED_TO_CANONICAL` lineage, the projection evidence points to that lineage record.

This preserves the source chain:

`RAW -> Normalized -> Canonical -> Projection`

### REVISION_HISTORY

When a Canonical field was changed by a reviewed manual command, its current revision may no longer have source-lineage evidence for that value.

In that case the projection evidence points to the immutable Canonical Revision Snapshot for that revision.

It does **not** falsely claim that the new value came from the old RAW source.

This preserves truthful provenance:

`reviewed command -> Canonical Revision Snapshot -> Projection`

## 5. Fail-closed release build

The release builder refuses to publish a Canonical entity revision that has no Revision Snapshot.

Release status now follows the approved sequence:

`BUILDING -> VALIDATING -> READY -> ACTIVE`

Process:

1. stage BUILDING release
2. write field evidence
3. write manifest last
4. move release to VALIDATING
5. verify manifest/evidence count
6. move to READY
7. atomically switch ACTIVE pointer

If evidence staging fails, the prior ACTIVE release remains active.

A partially staged release never replaces the last-known-good release.

## 6. Firestore scaling

Projection field evidence is written in bounded batches.

The manifest is written only after all evidence batches succeed.

This keeps large releases from depending on one oversized Firestore batch while retaining a fail-closed activation boundary.

## 7. Consumer metadata

ERP Public read responses include:

- releaseId
- manifestId
- canonical revision convenience value
- inputDigest
- dataDigest
- generatedAt
- activatedAt

Consumers can therefore record the exact released dataset they used without reading internal Firestore collections.

## 8. Console use

The future Data Console can use these records to answer both directions:

**Where did this visible value come from?**

`Consumer value -> Release -> Projection field evidence -> Canonical revision -> Source lineage / Revision History`

**Where did this Canonical value go?**

`Canonical entity/field -> Projection evidence -> Release -> Consumer`
