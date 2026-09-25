# Consumer output ownership

FreePass Data owns the data meaning and validation contract for every consumer
projection. A consumer writer may transport an approved projection, but it must
not independently reclassify records, add fee periods, or reinterpret missing
source evidence.

## F86 Hahuho

- Owner: `freepass-data`
- Presentation: retro
- Grouping axis: supplier
- Fee scope: long-term only (`24` months and later, plus deposit/rule columns)
- Source supplier: both groups retain `RP012` provenance
- Consumer output groups and product types are separate axes:
  - `SON_NO_KONG` with `하/허/호` plate -> `SONOGONG_PRODUCTS` / `USED_RENT`
  - `SON_NO_KONG` with a non-rental plate -> `SONOGONG_PRODUCTS` / `OGONG_SUBSCRIPTION`
  - `TCAR_EXTERNAL` -> `PICKUP_SUBSCRIPTION` / `PICKUP_SUBSCRIPTION` (티카 상품 구성 구독)
  - missing plate or unknown bucket -> `HOLD`

The operating F86 writer remains outside this repository today. Until it reads
an approved FreePass Data release and returns a consumer receipt, F86 is not an
enforced downstream connection and must not be reported as migrated.

The executable contract is `src/domain/consumer-output-contract.ts` and its
regression coverage is `tests/consumer-output-contract.test.ts`.


## F01/F86 delivery boundary

F01/F86 are downstream transports, not SSOT owners.

A sheet writer may publish only from an approved FreePass Data release. Completion
requires a `freepass-sheet-delivery-v1` receipt that binds the target workbook
to the exact `projectionId/releaseId/manifestId/inputDigest/dataDigest`, records the
render transform contract and its expected output digest/count, and then requires
a successful readback of that rendered output. The executable validator is
`src/domain/consumer-delivery.ts`; the JSON contract is
`contracts/sheet-delivery-receipt.v1.schema.json`.

Until that receipt exists and validates, F01/F86 remain HOLD even if a legacy
publisher produced matching rows from another snapshot.


The projection `dataDigest` and the rendered sheet `dataDigest` are deliberately
different digest domains. A sheet renderer changes shape, grouping, columns, and
presentation, so comparing the native sheet readback digest directly with the
projection digest is invalid. The receipt proves release identity through
`approvedRelease`, then proves transport integrity by comparing
`renderedOutput.dataDigest/vehicleKeyCount` with the readback values.


## Migration bridge ownership

The target end state is still `CANONICAL_ACTIVE`, but F01/F86 migration must not
wait for the entire Catalog canonicalization program to finish before authority
moves out of ERP4.

FreePass Data therefore owns a temporary, explicit migration authority:

`LEGACY_VERIFIED_BRIDGE`

This bridge is not Canonical Catalog authority. It is a Data-owned transport
release built from one read-only Firestore transaction over the operational
`products`, `policy`, and `partner` collections.

Executable path:

- `src/application/sheet-publication-bridge.ts`
- `captureErp5SheetSource()` — captures all three collections at one Firestore read time
- `buildSheetBridgeRelease()` — decodes without inventing missing values, verifies inventory invariants, and creates one bridge release + manifest
- `buildSheetBridgeHandoff()` — emits F01/F86-specific `freepass-sheet-handoff-v1` payloads
- `validateSheetPublicationHandoff()` — rechecks manifest identity, counts, release digest, snapshot digest and handoff hash

The bridge release is identified by `releaseAuthority=LEGACY_VERIFIED_BRIDGE`
and `projectionId=sheet-publication-bridge`. It must never be reported as a
Canonical ACTIVE Catalog release.

The bridge can be retired only after a `CANONICAL_ACTIVE` sheet projection
contains all fields needed by the sheet writers and the same delivery receipt
contract passes end-to-end.
