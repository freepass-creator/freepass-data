# freepass-data — AI / Codex Work Entry Rules

## 0. Mandatory entrypoint

Every Codex/Work/development AI working in this repository must start in this order:

1. `AGENTS.md`
2. `docs/NEXT-START-HERE.md`
3. `docs/IMPLEMENTATION-STATUS.md`
4. `docs/ARCHITECTURE-V2-APPROVED.md`
5. GitHub Issue #24 and the active PR/branch for the work

`docs/NEXT-START-HERE.md` is the current Chat → Work handoff board. Do not assume chat context is available locally.

## 1. Current 2026-09-22 P0 packet

The current highest-priority handoff is the section:

`2026-09-22 AI Core audit — Codex/Work immediate packet`

in `docs/NEXT-START-HERE.md`.

It covers:
- production runtime fail-closed; no silent memory/demo production boot
- serving plane separated from projection building
- writer ownership fail-closed hardening
- exact Firebase target binding/readiness
- F01/F03 authority alignment
- machine key vs visible sheet label separation for the live `손오공상품` mismatch
- exact-head DevCenter Data Hub evidence refresh

Latest handoff commit when this file was created:
`2b9d0e44f3f57f62c5ae59cd3209bedb2dbccdcc`

## 2. Project boundaries

- FreePass Data owns shared data facts/contracts, not Admin/Sales/Estimate workflow meaning.
- Catalog V1 remains the current executable platform domain.
- GitHub is code/contract truth, not the operational data store.
- RTDB gets no new usage.
- Consumers must not treat internal Firestore collection paths as public contracts.
- Production Firebase binding, IAM mutation, writer cutover, deployment, schedules and live sheet writes remain separately authorized operations.
- Do not create a replacement repository or redirect this project to jpkerp5.

## 3. Evidence discipline

Keep these states separate:
- DESIGNED
- CODED
- STATIC CHECKED
- TESTED
- PERSISTENCE VERIFIED
- DEPLOYMENT VERIFIED
- CUTOVER VERIFIED

Do not call a consumer cutover complete from code/test parity alone.

## 4. Before changing code

- fetch/verify current main revision
- inspect overlapping branches/PRs
- use the smallest isolated change
- preserve last-known-good ACTIVE release behavior
- prefer fail-closed over silent fallback
- update `docs/NEXT-START-HERE.md` when the work packet ends with exact commit/tests/remaining HOLDs
