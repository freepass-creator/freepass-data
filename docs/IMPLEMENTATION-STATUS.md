# FreePass Data — Catalog V1 Implementation Status

Status: **ACTIVE / EXECUTABLE BASELINE**  
Approved scope: **CATALOG V1 ONLY**  
Architecture baseline: [ARCHITECTURE-V2-APPROVED.md](./ARCHITECTURE-V2-APPROVED.md)  
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
- Catalog Field Authority Registry with command/writer enforcement and authority evidence
- append-only field-lineage contract and legacy RAW → normalized lineage persistence
- approved v2 repository boundaries + local architecture boundary check
- source coverage/completeness contract, accepted source head and stale-run overwrite protection
- reviewed Candidate → Canonical transaction with source binding, identity CREATE/LINK decisions and re-review-on-change
- NORMALIZED_TO_CANONICAL field lineage and critical-lineage fail-closed gate
- VehicleModel generation/subModel semantic separation
- tests for catalog mutation, authority enforcement, idempotency payload conflict, stale revision, projection semantics, ingestion, legacy normalization and shadow behavior

## Admin consumer contract — 2026-09-21

Added:
- `contracts/admin-catalog-view-v1.schema.json`
- `docs/CONSUMER-ADMIN-V1.md`

Status:
- contract: LOCKED
- Admin adapter consumer boundary: prepared in freepass-admin
- Data endpoint/release implementation: NOT ACTIVE
- Admin read cutover: BLOCKED until policy parity + service auth + shadow parity evidence

The Admin contract intentionally differs from `erp-public`: it preserves Offer supplier identity, PriceTerm provenance, VIN/registration facts, optional vehicle-price pricing input facts and typed searchable policy values.

## Current gap

The implementation has moved beyond the old Next list. The highest-value missing Catalog V1 platform contracts are now:

1. **Complete field lineage: Canonical → Projection + Release evidence**
2. **Reviewed source-change update path for an existing canonical binding**
3. **Implement and validate the Admin Catalog ACTIVE Projection Release**
4. **Acceptance-test expansion for failure, duplicate, cutover and last-known-good cases**
5. **Server/service authentication + IAM enforcement**
6. **Admin catalog shadow/read pilot with policy parity**
7. **ERP.com shadow/read pilot**
8. **Console Data Explorer / Entity Detail / Command Edit**
9. **Backup/restore and operational recovery verification**

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
