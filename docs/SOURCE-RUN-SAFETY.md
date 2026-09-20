# Source Run Safety — Catalog V1

Status: **IMPLEMENTED BASELINE**

This document locks source-run safety rules that were already established in prior FreePass SSOT design work.

## 1. Execution success is not source completeness

A source run can finish technically while its coverage is still incomplete.

FreePass Data records both:

- coverage mode: `FULL | DELTA | PARTIAL | UNKNOWN`
- completeness: `COMPLETE | INCOMPLETE | UNKNOWN`

A run with incomplete coverage is kept as evidence but is not allowed to become an authoritative source head.

## 2. Accepted source head

Each source has at most one accepted current head.

A completed run may become the current head only when:

- its completeness is `COMPLETE`
- its source observation time is strictly newer than the current accepted head

Completion time is not used to decide freshness.

This prevents a slow, older run that finishes late from overwriting a newer observation.

Equal observation time is treated conservatively: the existing head remains current.

## 3. Absence authority

Only the current run that is both:

- `FULL`
- `COMPLETE`

may assert that a missing source record is meaningful absence.

`DELTA`, `PARTIAL`, `UNKNOWN`, incomplete, stale, or failed runs may never be used to mass-delete, retire, or suspend missing catalog records.

The domain helper is:

`canAssertSourceAbsence(run)`

## 4. Immutable completion evidence

Once a run is completed, completion replay returns the already-recorded result and does not reclassify the run or source head.

RAW, normalized candidates and lineage evidence remain append-only.

## 5. Current legacy product source

The read-only `freepasserp3/firestore/products` adapter performs a full collection read. A successful collection read is therefore declared:

- mode: `FULL`
- completeness: `COMPLETE`

If this adapter later becomes paginated, segmented, filtered, or otherwise partial, this declaration must be changed rather than silently preserving FULL/COMPLETE.

## 6. Next safety layer

Canonicalization must consume only eligible reviewed candidates and must never interpret missing records from a non-authoritative run as deletion.

Canonical updates must also pin the accepted source run/checkpoint used as evidence.
