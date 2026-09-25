# FreePass Data — Development Lineage Authority

Status: ACTIVE  
Date: 2026-09-26

This file exists to prevent parallel AI sessions from creating competing implementations of the same responsibility.

## 1. Authority rule

1. `main` is the only merged implementation authority.
2. An unmerged responsibility may have **one canonical WIP PR**.
3. Older stacked/superseded PRs are historical evidence only, even if their branches still exist.
4. Branch names such as `gpt/`, `claude/`, `codex/`, `auto/`, `feat/`, or `work/` do not imply authority.
5. Before coding, compare the target responsibility against this file and current open PRs.
6. Do not create a second adapter, engine, repository, projection, or UI implementation for an already-listed responsibility. Extend or rebase the canonical WIP line instead.
7. Prototype/preview code is never production authority unless this file explicitly promotes it.

## 2. Current canonical WIP lines

| Responsibility | Canonical WIP | Authority / notes |
| --- | --- | --- |
| Vehicle Master: new/used source capture, persistence, reconciliation, selector, Estimate master-data projection | PR #58 — `work/gpt/vehicle-master-unified-20260926` | Single Vehicle Master line. Supersedes #49/#50/#51/#56. Quote calculation/issuance contracts are excluded from FreePass Data. |
| Consumer release + Sheet handoff + audited Firebase/Data Access boundary | PR #54 — `auto/data-access-gateway-20260925` | Based directly on `main`. Supersedes #48/#57 and the earlier stacked handoff branches for active development. |
| Admin Catalog current projection | PR #53 — `work/admin-catalog-projection-v2-current-20260925` | Current Admin data-contract line. Supersedes old PR #12. |
| Iancar source evidence | PR #45 — `codex/iancar-availability-20260922` | Isolated source-evidence work; must not become a second Vehicle Master or consumer runtime. |

## 3. Explicitly retired / reference-only lines

- PR #49 / `work/gpt/estimate-master-contract-20260925`: superseded by #58 for Data-owned master facts. Quote issuance/calculation belongs to the Estimate product boundary.
- PR #50 / `work/gpt/vehicle-master-persistence-20260925`: superseded by #58.
- PR #51 / `work/gpt/vehicle-master-ingestion-20260925`: superseded by #58.
- PR #52 / `work/gpt/data-ui-vehicle-finder-slice-20260925`: prototype/reference only; not production UI authority.
- PR #48 / `auto/consumer-release-binding-20260925`: superseded by #54.
- PR #12 / `work/admin-catalog-projection-v1-current-20260921`: superseded by #53.
- PR #1 / `design/architecture-v2-review-20260920`: historical review only. Current architecture authority is `docs/ARCHITECTURE-V2-APPROVED.md`.
- `codex/erp5-consumer-runtime-20260921`: historical runtime line; do not use as a new base.

Branches are retained as provenance until they can be deleted safely; retention does not make them active.

## 4. Source persistence boundary

The repository intentionally has two **application ports** touching source evidence, but they must not evolve as two independent physical repositories:

- `SourceIngestionStore`: source-run ingestion lifecycle only (capture RAW/candidates/lineage, complete/fail run, advance source head).
- `CatalogStore`: Canonical transaction boundary that may atomically consume/create source evidence when required by reviewed/manual Canonical commands.

Both Firestore implementations must use the shared physical layout from
`src/infra/source-firestore-layout.ts`. Collection names and source document-ID encoding must not be copied into another adapter.

Memory stores are local/test adapters, not separate SSOTs.

## 5. UI / engine ownership

FreePass Data owns shared data facts and projections. It does not become a second implementation of:

- FreePass Estimate pricing/calculation engine;
- Admin/Sales workflow engines;
- product UI design systems.

A preview under `preview/` is reference material unless its owning product explicitly adopts it.

## 6. Change procedure

When a responsibility already has a canonical WIP line:

1. continue that line;
2. if another branch contains unique work, port only the required delta into the canonical line;
3. verify the ported files/deltas;
4. close the superseded PR;
5. update this file if authority changes.

Do not keep two open PRs that both claim the same responsibility.
