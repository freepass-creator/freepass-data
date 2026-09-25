# FreePass Data Access Gateway

Status: implementation baseline — 2026-09-25

## Role

FreePass Data is the single access boundary for shared Firebase/Firestore data.

Consumers and jobs must not treat Firestore collections as an application API.

Target flow:

```text
Admin / Sales / Estimate / ERP.com / F01 / F86 / jobs
                    |
                    v
             FreePass Data
             Access Gateway
            /              \
         READ              WRITE
          |                  |
          v                  v
   approved reader      command/application
          |                  |
          v                  v
       Firestore         Firestore transaction
          |                  |
          +------ audit evidence ------+
```

Browser/mobile direct Firestore read/write remains denied by `firestore.rules`.

## Evidence layers

### 1. data_access_events

Immutable operation-level access evidence.

Records:

- actor
- clientId
- purpose
- READ / WRITE
- operation
- resource
- STARTED / SUCCEEDED / DENIED / FAILED
- request/correlation IDs where available
- safe request digest
- result count/digest/release/manifest/revision where applicable
- timestamps

Raw payloads, authorization tokens, customer data, and backend error text are not copied into this log.

A STARTED event must persist before the underlying Firebase access begins.
If audit persistence is unavailable, the access fails closed.

### 2. mutation evidence

Existing canonical write evidence remains authoritative for the actual data change:

- `audit_events`
- command receipts / idempotency receipts
- entity revision history
- source lineage
- outbox events
- projection manifests and delivery receipts

Access evidence answers **who accessed what and why**.
Mutation evidence answers **what facts actually changed**.

For canonical writes, the mutation audit/receipt remains in the same transaction as the data change.
The outer Data Access WRITE event adds caller/purpose/access traceability.

## Current routed paths

### Consumer reads

`src/api/consumer-gateway.ts`

Authenticated catalog and catalog-health reads pass through `DataAccessGateway`.

- unauthorized / forbidden attempts => DENIED
- approved access => STARTED then SUCCEEDED
- read failure => STARTED then FAILED
- audit sink unavailable => underlying read does not start

### Development command API

`src/api/server.ts`

Projection reads, product trace reads and local command writes use the same gateway.

### Background jobs

- legacy source snapshot read
- legacy source ingest write
- ERP5 source inspection read
- F01/F86 bridge source read
- central Firestore diagnostic counts

All live Firebase operations are wrapped in Data Access READ/WRITE operations.

Offline file-only analysis jobs are not Firebase access and do not create Firebase access events.

## Composition roots

Raw Firestore stores/readers may be assembled only in explicit composition roots:

- `src/bootstrap.ts`
- `src/api/data-access-runtime.ts`
- `src/jobs/data-access-runtime.ts`

Low-level infra/adapters may contain SDK/transport code, but API/job/application orchestration must not bypass the gateway.

`scripts/check-data-access-boundary.mjs` enforces this boundary and is part of `npm run check`.

## Write guarantees

WRITE access uses two evidence layers:

1. `data_access_events: STARTED` is persisted before mutation execution.
2. Canonical command logic commits its normal receipt/audit/revision evidence atomically with the data mutation.
3. `data_access_events: SUCCEEDED` is appended after completion.

If step 3 fails after a committed write, STARTED plus the atomic command/mutation evidence still proves the operation.
The system must not infer rollback solely from a missing SUCCEEDED access event.

## Migration requirement

A consumer is not considered migrated merely because it reads the same Firestore project.

Migration requires:

1. direct Firebase credentials removed from the consumer runtime
2. read/write calls go through a FreePass Data contract
3. consumer-specific capability and identity are registered
4. access events are visible for both successful and denied operations
5. writes carry command/idempotency/authority evidence
6. direct Firestore path is blocked or removed

The final target is that Admin, Sales, Estimate, ERP.com, F01/F86 and automation code know FreePass Data contracts, not Firestore collection topology.
