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
- append-only queryable Canonical Revision History for create/change commands
- Firebase Control Plane contract for consumer reads/writes and future Console mutation paths
- controlled Manual Catalog Source/Command with immutable RAW, candidate, lineage and receipt
- direct-input vertical slice through reviewed Canonicalization and ACTIVE ERP Public Release
- local product evidence trace from Source/RAW/Candidate through Canonical/Projection/Release
- live Console record-list flow view: imported object → normalized object → outgoing object, with explicit local-only consumer boundary
- exact Projection Release Manifest with Canonical input revisions and SHA-256 input/data digests
- field-level Canonical → Projection evidence with SOURCE_LINEAGE vs REVISION_HISTORY provenance
- BUILDING → VALIDATING → READY → ACTIVE evidence-gated Release promotion
- reviewed source-fingerprint change diff/apply workflow with exact approval and all-entity revision pinning
- source supplier-code mapping preserved separately from Canonical supplierId
- consumer output ownership contract for F86: retro supplier view, long-term-only fees, and independent Sonogong supplier/product axes
- SOURCE_REFRESH Revision/Audit/Lineage path for Offer pricing terms and VehicleAsset odometer
- idempotent projection delivery receipts keyed by outbox event
- equivalent ACTIVE Release reuse by input/data digest
- out-of-order catalog events converge on current Canonical state
- Catalog writer ownership state with SHARED_MIGRATION → EXCLUSIVE transfer
- actor vs execution-writer separation for Catalog mutations
- old-writer fail-closed enforcement across canonicalization/manual/source-refresh/price writes
- writer ownership transfer revision/audit/idempotency evidence
- tests for catalog mutation, authority enforcement, idempotency payload conflict, stale revision, projection semantics, ingestion, legacy normalization and shadow behavior

## Current gap

### Live state checked 2026-09-21

The explicitly targeted `freepasserp5` Firestore currently has 1,659 legacy product
documents and 81 legacy policy documents. The new `catalog_products`,
`catalog_offers`, `catalog_policies` and `projection_active` collections are empty.
Therefore the authenticated read runtime is implemented but has no publishable ACTIVE
Catalog release. The current operational verdict is HOLD.

Read-only source capture and policy-link analysis completed without writes. All 1,659
products remain review HOLD; 1,342 policy references are exact link candidates and
317 are unset. Canonical writes require explicit mapping decisions and a reviewed
dry-run candidate set.

The implementation has moved beyond the old Next list. The highest-value missing Catalog V1 platform contracts are now:

1. **Server/service authentication + IAM enforcement**
2. **ERP.com shadow/read pilot**
3. **Console Data Explorer / Entity Detail / Command Edit**
4. **Backup/restore and operational recovery verification**
5. **Replace the separately pinned F01/F86 publisher rules with approved FreePass Data releases and consumer receipts**

## Local execution

Windows setup and current local verification: [Local development](LOCAL-DEVELOPMENT.md).
The local launcher forces memory mode and loopback binding. Dependency versions
are pinned in `package-lock.json`. The memory-only Console serves at `/console`
and provides a live Catalog read plus guarded Offer monthly-rent command flow.

```bash
npm ci
npm run check
npm run dev
```

Default driver: `memory`.

Routes:

```
GET  /health
GET  /v1/views/erp-public/products
GET  /v1/console/products/:productId/trace  # memory-only RAW-to-consumer evidence
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
