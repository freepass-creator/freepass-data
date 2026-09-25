# FreePass Data — Firebase Access Migration Map

Date: 2026-09-25  
Status: migration control document

## Principle

FreePass Data is the **data access/control plane**, not the semantic owner of every business domain.

- Sales owns CRM/call workflow semantics.
- Admin owns application/contract/settlement workflow semantics.
- Estimate owns quote/calculation semantics.
- ERP.com/F01/F86 own presentation/transport behavior within approved contracts.
- FreePass Data owns shared access contracts, storage authority boundaries, access audit, release evidence,
  and the rule that application code does not treat Firebase collection paths as a public API.

Target:

```text
domain UI / service / automation
          |
          v
FreePass Data contract
  identity + capability + purpose
          |
          v
Data Access Gateway
 READ / WRITE / DENIED / FAILED
          |
          +--> DataAccessEvent
          |
          v
domain command/read adapter
          |
          v
Firebase / Firestore / Storage
```

A migration is not complete while a consumer still carries a Firebase database credential or directly
imports a Firebase database/storage SDK for business data.

Firebase Auth used only to establish user identity is a separate concern; application data reads/writes
after authentication must still use FreePass Data contracts.

## Current observed direct paths

### FreePass Admin — HIGH priority

Observed on `main`:

- `src/adapters/erp5/firestore.ts`
  - holds a direct `freepasserp5` Firebase Admin service-account credential
  - returns raw Firestore
- `src/adapters/erp5/product-repository.ts`
  - directly reads `products` and `policy`
- `src/adapters/erp5/settlement-repository.ts`
  - directly reads/writes `settlement_rows`, `settlement_events`,
    invoices/cash/clawback data in transactions

Target:
- ProductRepository consumes a bounded FreePass Data catalog projection/read contract.
- Settlement keeps Admin-owned domain commands, but persistence is exposed as Admin settlement
  read/command contracts through Data Access Gateway.
- remove `ERP5_FIREBASE_SERVICE_ACCOUNT_JSON` / direct Firestore from Admin runtime after parity.

Migration status: **DIRECT_FIREBASE_PRESENT / HOLD**

### FreePass Sales — HIGH priority

Observed on `main`:

- `웹/app.js`
  - browser imports Firebase Auth, Firestore and Storage SDKs directly
  - Firestore is described as the SSOT for `leads/{phone}`, calls/status history
- `웹/분석.js`
  - browser directly reads `leads`, collection-group `calls`, `statusEvents`
- browser Firebase project config points at `welrixtable`

Target:
- Firebase Auth may continue to establish user identity during migration.
- CRM query/command endpoints move behind FreePass Data access contracts.
- Sales domain keeps status/progression/call semantics.
- browser loses direct Firestore/Storage business-data access and database rules become deny-by-default.

Migration status: **DIRECT_BROWSER_FIRESTORE_PRESENT / HOLD**

### FreePass Estimate — CRITICAL legacy cleanup

Observed on `main`:

- `apps/new/src/firebase/config.js`
  - initializes `freepasserp3` RTDB + Storage in browser
  - anonymous authentication can obtain data access
- `apps/new/src/firebase/contracts.js`
  - direct RTDB reads/writes for `welrix_contracts`
  - direct Storage upload/download/delete for contract documents
- `apps/new/src/firebase/quotes.js`
  - direct RTDB reads/writes for `welrix_quotes`

This conflicts with the current FreePass architecture direction that RTDB is retired for new data paths.

Target:
- Quote calculation remains Estimate-owned.
- Quote persistence, contract review metadata and file operations move to versioned Data access commands.
- binary Storage upload uses an authorized upload-ticket/receipt contract rather than exposing storage paths.
- RTDB business-data dependency is removed, not replicated inside Data.

Migration status: **DIRECT_RTDB_AND_STORAGE_PRESENT / P0 HOLD**

### FreePassERP.com / legacy ERP4 — HIGH priority, already in transition

Observed on `main`:

- `lib/firebase/firestore-products-client.ts`
  - browser directly subscribes to Firestore `products` with `onSnapshot`
- `lib/server/erp5-firestore-app.ts`
  - server owns direct ERP5 Firebase Admin service-account credentials
- many legacy/operational Firebase writers remain for source ingest/publication/settlement
- some newer settlement client operations are already API-mediated rather than direct database writes

Existing migration evidence:
- FreePass Data release/consumer gateway work
- F01/F86 handoff/receipt work
- ERP4 PR #495 transport adapter

Target:
- customer/public catalog surfaces read approved FreePass Data projections, not `products` directly
- remove browser Firestore subscription and server ERP5 service-account credential after parity
- scheduled legacy publisher remains temporary until release-bound shadow/output parity is complete

Migration status: **MIGRATION_IN_PROGRESS / HOLD**

## Migration order

1. **Shared catalog reads**
   - ERP.com / White Label
   - Admin product lookup
   - Sales/Estimate product lookup where used
   - bind all to approved release identity

2. **Estimate RTDB/Storage removal**
   - quote persistence
   - contract metadata
   - controlled file upload/download receipts

3. **Sales CRM persistence**
   - lead/call/status read models
   - write commands with idempotency and revision evidence
   - analysis reads through bounded reporting contract

4. **Admin workflow persistence**
   - application/contract commands
   - settlement commands/read models
   - preserve domain invariants while removing direct service account

5. **Legacy publication/source writers**
   - F01/F86/ERP4 source responsibilities retire only after shadow parity and delivery receipts

## Required completion evidence per consumer

A consumer can be marked migrated only when all are true:

1. no direct Firebase database/storage credential remains for business data
2. no direct Firestore/RTDB/Storage collection/path call remains in runtime business code
3. every read/write has consumer identity, capability and purpose
4. every attempt emits DataAccessEvent evidence
5. writes have domain command ID, idempotency/revision/authority evidence
6. read response identifies revision/release/snapshot evidence where applicable
7. direct old path is blocked by rules/IAM or removed
8. parity/readback passes against the prior production path
9. fallback cannot silently reactivate the old database path

## Current FreePass Data baseline

PR #54 establishes the first control-plane baseline:

- `DataAccessGateway`
- immutable logical `DataAccessEvent`
- Firestore event sink for service/writer runtimes
- append-only private GCS event sink for read-only jobs
- consumer read auditing
- development command auditing
- live source/job auditing
- raw Firebase composition roots
- repository boundary checker

This baseline is **not** a claim that Admin/Sales/Estimate/ERP4 are migrated yet.
