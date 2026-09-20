# FreePass Data — Approved Repository Structure

Status: **APPROVED STRUCTURE / CATALOG V1**  
Approval source: Google Doc `FreePass Data 아키텍처 v2 — CATALOG V1 구현 승인본`  
Scope: the code structure that implements the approved architecture; this is not a new architecture proposal.

## 1. Two logical planes

### Control Plane

Owns source registration, schema/authority rules, Data Explorer, command edits, lineage, migration switches, release management, audit and error inspection.

The Control Plane is operational tooling. It is not the product itself and must not become a runtime dependency for public catalog reads.

### Data Serving Plane

Owns stable delivery of validated Canonical data and ACTIVE Projection Releases to consumers.

Consumers include:

- FreePass Admin
- FreePass Sales
- ERP.com
- Estimate
- future partner/white-label consumers

A Control Plane UI failure must not invalidate the last-known-good ACTIVE release.

## 2. Data pipeline

```text
Source
  -> RAW
  -> Normalized Candidate
  -> Canonical
  -> Projection
  -> Release
  -> Consumer
```

Each boundary has a separate responsibility and evidence trail.

## 3. Code dependency direction

```text
Domain
  <- Ports
  <- Application
  <- Adapters / Infra
  <- API / Worker / Jobs
```

Interpretation:

- `src/domain`: pure business/data contracts and invariants. No Firebase dependency.
- `src/ports`: persistence/source/service interfaces. Depends on Domain only.
- `src/application`: use cases and command orchestration. Depends on Domain/Ports, never Firebase directly.
- `src/adapters`: external source translation such as legacy Firebase, Sheet, partner API.
- `src/infra`: concrete persistence such as Firestore and memory stores.
- `src/migration`: shadow comparison and migration-control logic.
- `src/api`: HTTP transport boundary.
- `src/jobs` / `src/worker.ts`: ingestion and durable-outbox execution boundaries.

The local `npm run check:arch` command rejects important reverse dependencies.

## 4. Physical repository evolution

The current executable baseline remains in `src/` while Catalog V1 contracts stabilize.

We will not perform a cosmetic mass-move merely to match a folder diagram. New code must respect the approved boundaries now, and physical split into `apps/api`, `apps/worker`, and `apps/console` can happen when those runtime units have enough independent code to justify the move.

This avoids breaking working code while still preventing architectural drift.

## 5. Canonical implementation order

The implementation order is:

```text
Source connectors / RAW
-> Normalizer + Candidate
-> Field Authority
-> Lineage
-> Canonicalization
-> Projection
-> Release
-> Consumer contracts / SDK
-> Control Plane console
```

The console is deliberately after the data path. UI polish is not a completion criterion for FreePass Data.

## 6. Non-negotiable boundaries

- GitHub repository is code/contract truth, not the operational data store.
- RTDB gets no new usage.
- Consumer apps do not depend on internal Firestore collection paths.
- Firestore is the first persistence adapter, not the domain contract.
- Canonical write, audit evidence, and durable outbox are transactionally coupled where possible.
- Projection is not another SSOT.
- Partial or failed release builds never replace the last-known-good ACTIVE release.
- Estimate owns calculation logic; FreePass Data owns calculation input facts and versions.
- Migration uses legacy-authoritative Change Mirror during Shadow, not application-level dual write.
- Production writer cutover, IAM, deployment and schedules remain explicit operational actions.
