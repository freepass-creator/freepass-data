# FreePass Data — NEXT START HERE

Status: **ACTIVE / CATALOG V1 EXECUTABLE BASELINE**  
Official project name: **프리패스 데이터 / FreePass Data**  
Repository: `freepass-creator/freepass-data`  
Verified main revision when this handoff was created: `6ee24326bd30b3420d04c4fe344ac9ad5dbfe769`  
Date: 2026-09-20

## 1. Do not restart or recreate the project

This repository already exists and contains the Catalog V1 executable baseline.

Do **not** create a replacement repository and do **not** redirect this work to `JPK ERP5/jpkerp5`.

Legacy Firebase identifiers may still appear as source/target identifiers. They are identifiers, not the official project name.

## 2. Locked boundaries

- Approved implementation scope: **CATALOG V1 ONLY**
- FreePass Data owns the server-side data-platform boundary, not Sales/Admin/Estimate business workflow meaning.
- Consumer apps must not treat internal Firestore collection paths as their public contract.
- Canonical writes fail closed when revision/authority/persistence validation cannot be performed.
- RTDB: **no new usage**. Existing traces are migration debt only.
- GitHub Actions / deployment automation: **do not add or enable without separate authorization**.
- Production Firebase binding, IAM change, writer cutover, schedule activation, and real-data writes remain separately authorized operations.

## 3. What is already on main

The current baseline includes:

- TypeScript / Node 22 modular monolith
- Catalog JSON Schemas
- VehicleModel / VehicleAsset / Product / Offer / PriceTerm / Policy domain
- memory + Firestore repository adapters
- revision conflict protection
- idempotency receipt
- append-only audit + transactional outbox
- worker lease/retry/dead-letter behavior
- ERP public projection + release activation
- Fastify API baseline
- legacy `freepasserp3` read-only adapter
- conservative legacy normalizer
- source run / RAW / normalized candidate persistence
- guarded legacy product ingestion job
- explicit target Firebase binding requirement
- shadow migration/comparison contract
- default-deny Firestore rules baseline + indexes
- fail-closed public projection for incomplete deposit terms
- tests covering catalog mutation, ingestion, normalizer and shadow behavior

## 4. Highest-value next work

### Consumer read preparation — 2026-09-21

See [Consumer read pilot](CONSUMER-READ-PILOT.md) for the observed ERP/F01/F86
read paths, remaining live-evidence gates, and `npm run pilot:check` offline
three-way comparison. This is local preparation only; no production cutover.
Preserve existing dirty Console/output-contract changes and the separate Admin PR #12.

### P0 — Field Authority Registry ✅

Implemented baseline: `src/domain/authority.ts`, command enforcement, authority evidence in receipt/audit, and regression tests.

Minimum dimensions:

- domain / aggregate / field path
- semantic owner
- allowed command(s)
- allowed writer/service identity class
- approval requirement
- conflict policy
- override policy
- effective-time policy
- source refresh behavior

Do not reduce this to a single `SOURCE_WINS`-style enum.

### P1 — Field-level lineage ✅

Catalog V1 now has RAW → normalized → canonical → projection lineage, exact Release manifests, source-run safety, reviewed canonicalization, queryable Canonical Revision History, and controlled Manual Catalog Source/Command.

Reviewed source-change update for existing canonical bindings is implemented.

Duplicate/out-of-order delivery behavior is implemented.

Writer ownership-transfer enforcement is implemented as a non-production semantic boundary.

Next implementation focus: authenticated service/user identity and IAM enforcement, then the ERP.com shadow/read pilot.

Minimum evidence:

- source_id
- source_record_id
- source revision/digest
- normalizer/mapper version
- canonical entity + revision
- field path
- source value / normalized value / canonical value
- override/correction reference when applicable

### P2 — Acceptance tests

Promote the architecture-v2 review test matrix into executable tests, starting with:

- [x] idempotency key reused with a different payload must conflict — implemented in PR #3
- [ ] stale revision must fail without losing the operator input
- [x] incomplete deposit/price pair must not be published
- [x] partial projection/evidence build must not replace last-known-good ACTIVE release
- [x] current reviewed candidate canonicalization must pin accepted source head
- [x] changed source fingerprint must require explicit re-review
- [x] reviewed source refresh must apply only the exact current diff set
- [x] structural/identity source changes must block partial refresh
- [x] stale review must fail when any pinned Canonical revision changed
- [x] source supplier code must be compared through binding mapping, not Canonical supplierId
- [x] missing critical lineage must block Canonical promotion
- [x] canonical create/change must append a queryable revision snapshot
- [x] direct manual entry must create immutable source evidence before Canonical commit
- [x] manual entry idempotency replay must not duplicate source evidence
- [x] ACTIVE Release must carry exact Canonical input revisions and digests
- [x] projection fields must resolve to source lineage or Canonical Revision History
- [x] source collection failure/incomplete coverage must not be interpreted as mass deletion
- [x] late older source run must not replace the accepted current head
- [x] duplicate / out-of-order event behavior
- [x] old writer blocked after ownership transfer (design + non-production enforcement test)

### P3 — Security/IAM review

Writer ownership transfer semantics are implemented, but runtime writer identity is not yet cryptographically authenticated.

Next:
- authenticate service/user identity
- bind execution writer to verified runtime identity rather than request metadata
- keep Firestore default deny
- define consumer read boundary before any production cutover

### P4 — ERP.com pilot consumer

Only after P0-P3 contracts are stable:

`LEGACY → SHADOW → FREEPASS_DATA_READ`

Do not perform writer cutover in the same step.

## 5. Coordination rule

### Local working copy — 2026-09-21

Local runtime fixes based on main `fea18ce15f523d41a9382e7ae79e702a58d3afae`
are on `codex/local-runtime-baseline` in `C:\dev\freepass-data`.
See [Local development](LOCAL-DEVELOPMENT.md) for Windows setup, validation,
and the separate API/worker memory-store limitation. These local changes are
not a production rollout. Open PR #12 covers Admin projection work separately.

Before each new change:

1. read `docs/IMPLEMENTATION-STATUS.md`
2. read this file
3. verify current `main` revision
4. check open PRs/branches for overlapping work
5. make the smallest isolated change
6. leave an updated next-start-here note when the work packet ends

### 운영 사고 메모

- [2026-09-21 손오공 픽업구독 축소와 거짓 합격 방지](INCIDENT-2026-09-21-STALE-UPSTREAM-FALSE-PASS.md): 하류 `원자 → F01 → F86` 일치만으로 원천 정합성을 합격 처리하지 않는다. 현재 원천 관찰부터 차량번호·상태를 양방향 대조한다.

This file exists so another session can continue without re-discovering or re-creating the project.
