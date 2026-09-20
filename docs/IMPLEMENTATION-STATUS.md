# FreePass Data — Catalog V1 Implementation Status

Status: **ACTIVE / EXECUTABLE BASELINE**  
Approved scope: **CATALOG V1 ONLY**  
Recovery handoff: [NEXT-START-HERE.md](./NEXT-START-HERE.md)

## Confirmed on main

Implemented:

- TypeScript / Node.js modular-monolith baseline
- JSON Schema contract bundle for VehicleModel / VehicleAsset / Product / Offer / PriceTerm / Policy
- VehicleModel / VehicleAsset separation
- Catalog repository ports
- Memory adapter for credential-free local smoke execution
- Firestore adapter behind the same ports
- Command-based Offer price change
- expectedRevision conflict protection
- idempotency receipt
- append-only audit
- durable outbox
- worker lease / retry / dead-letter state
- ERP Public Projection preserving Offer boundaries
- atomic Release activation pointer
- Fastify read/write API
- demo catalog seed
- pinned AI Core revision manifest
- legacy `freepasserp3` read-only adapter
- conservative legacy product normalizer
- source run / RAW / normalized-candidate persistence
- guarded legacy product ingestion job
- explicit target Firebase binding requirement
- shadow migration/comparison contract
- Firestore rules/index baseline
- fail-closed projection behavior for incomplete deposit terms
- tests for catalog mutation, stale revision, projection semantics, ingestion, legacy normalization and shadow behavior

## Current gap

The implementation has moved beyond the old Next list. The highest-value missing Catalog V1 platform contracts are now:

1. **Field Authority Registry + command enforcement**
2. **Field-level lineage / provenance**
3. **Acceptance-test expansion for failure, duplicate, cutover and last-known-good cases**
4. **Server/service authorization + IAM review**
5. **ERP.com shadow/read pilot**
6. **Console Data Explorer / Entity Detail / Command Edit**
7. **Backup/restore and operational recovery verification**

## Local execution

```bash
npm install
npm run check
npm run dev
```

Default driver: `memory`.

Routes:

```
GET  /health
GET  /v1/views/erp-public/products
POST /v1/commands/offers/:offerId/price
```

## Firestore mode

```bash
FREEPASS_DATA_DRIVER=firestore
FIREBASE_PROJECT_ID=...
GOOGLE_APPLICATION_CREDENTIALS=...
```

Firestore is an adapter, not a Domain dependency.

## Locked operational boundaries

- RTDB 신규 사용 금지. 기존 흔적은 migration debt로만 취급한다.
- Consumer가 internal Firestore collection path를 public contract로 사용하지 않는다.
- Production Firebase binding/IAM/writer cutover/real-data write는 별도 승인 전 수행하지 않는다.
- GitHub Actions 또는 deployment automation은 별도 승인 없이 추가/활성화하지 않는다.
- Sales customer/call, Application/Contract, Settlement/Finance migration은 현재 Catalog V1 범위 밖이다.

## Design review

The branch `design/architecture-v2-review-20260920` contains a broader v2 review proposal. It is review material, not an automatic production-architecture replacement.

See the open draft PR for review history.
