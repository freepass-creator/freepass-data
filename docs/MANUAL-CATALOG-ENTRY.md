# Manual Catalog Entry — Catalog V1

Status: **IMPLEMENTED BASELINE**

Direct entry in FreePass Data is implemented as a controlled MANUAL source command.

It is not a generic Firestore document editor.

## Flow

```text
Console / authorized consumer
  -> CREATE_MANUAL_CATALOG_ENTRY
  -> immutable MANUAL source
  -> RAW evidence
  -> normalized candidate
  -> RAW_TO_NORMALIZED lineage
  -> SOURCE_ACCEPTED receipt
  -> reviewed Canonicalization CREATE/LINK decision
  -> Canonical entities
  -> Revision / Audit / NORMALIZED_TO_CANONICAL lineage
  -> Outbox
  -> Projection / ACTIVE Release
```

## Why two stages

Source acceptance and Canonical commit are intentionally separate.

If source acceptance succeeds but Canonical review fails:

- the submitted evidence remains intact
- no Canonical entity is partially created
- the candidate can remain in a review queue
- the operator can resolve identity/validation without retyping the source data

## Manual source identity

Each idempotent submission gets its own immutable source record.

Content fingerprint and source identity are separate concepts.

- source identity: derived from the idempotency submission
- source fingerprint: SHA-256 of the submitted catalog entry

FreePass Data does not infer that two equal-looking submissions are the same Product/Vehicle.

Entity identity is resolved later through explicit Canonicalization CREATE/LINK decisions.

## Input scope

The V1 manual form accepts only fields already represented in the Catalog V1 Canonical model:

- car number when a real asset exists
- maker / model / subModel / trim
- commercial type
- supplier
- fuel / drive / seats
- actual mileage for a real asset
- repeatable PriceTerms
  - term months
  - monthly rent
  - deposit state / amount
  - annual mileage limit

Unsupported future fields are not silently accepted and discarded.

## Validation

The command rejects:

- blank maker/model/supplier
- no PriceTerm
- duplicate term-month + mileage conditions
- invalid KRW amounts
- contradictory deposit state and amount
- invalid mileage / seats / term months
- unregistered SERVICE writers
- idempotency-key reuse with different payload

## Evidence

The first stage stores atomically:

- SourceDefinition(kind=MANUAL)
- SourceRun(FULL + COMPLETE + CURRENT)
- SourceHead
- immutable RawRecord
- NormalizedCandidateRecord
- field-level RAW_TO_NORMALIZED lineage
- ManualCatalogEntryReceipt with actor/reason

The same idempotency key replays the existing receipt and creates nothing twice.

## Security boundary

The current USER actor remains semantic identity until authenticated user/service identity work is added.

Therefore no public manual-write HTTP route is exposed in this packet.

The later API/Console route must derive actor identity from authenticated credentials before calling this command.
