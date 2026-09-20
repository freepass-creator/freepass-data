# Runtime Boundaries — Catalog V1

## Firebase ownership

FreePass Data owns the server-side Firebase/Firestore binding.

Consumer applications must not use canonical collection paths as a public contract.

V1 Firestore Rules are **default deny** because canonical writes and reads are performed through the FreePass Data server boundary. Public assets and narrowly scoped direct-access exceptions, if ever required, must be added explicitly later.

## Persistence boundary

Domain/Application code depends on repository ports.

Firestore is the first adapter, not the business contract.

## Read availability

ERP Public data is served from an ACTIVE Projection Release.

Control-plane failure must not invalidate the last known good release.

## Write availability

Authoritative writes fail closed when revision, authority or persistence validation cannot be performed.

## Outbox

Canonical mutation, audit evidence and outbox enqueue belong to one transaction.

The worker is idempotent and uses lease/retry/dead-letter semantics.

## Shadow migration

Shadow comparison is checkpoint-aware.

Preferred comparison order:

1. same source revision/sequence/checkpoint
2. otherwise source-specific settled window/watermark

A global hard-coded 3–5 second tolerance is intentionally not a platform rule.

Statuses:

- PENDING_LAG
- MATCH
- TRUE_MISMATCH
- SOURCE_INCOMPLETE
- COMPARISON_ERROR
