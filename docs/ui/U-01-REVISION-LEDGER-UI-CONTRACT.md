# U-01 Revision Ledger UI contract

Status: presentation boundary over `EntityRevisionRecord[]`

## Purpose

Revision Ledger shows the canonical revision history that already exists in CatalogStore.

It answers:
- which entity changed
- revision N-1 -> N
- who caused it
- which command caused it
- why it changed
- revision origin
- source binding/run when present
- exact revision snapshot

## Read boundary

```js
read() -> {
  observedAt,
  revisions: EntityRevisionRecord[]
}
```

The UI preserves the reader-provided order. It does not synthesize a timeline order.

## Boundary

U may:
- filter/search visible revision records
- format timestamps
- render snapshots
- count supplied records by entity type

U must not:
- call `appendRevision()`
- calculate the next revision
- infer revision origin
- merge DataAccessEvent into revision history
- invent past releases or missing revisions

A real revision-list transport is still an I boundary. Until it exists, the actual route remains fail-closed.
