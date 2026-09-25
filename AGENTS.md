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

## 2.1 FreePass Data implementation invariants

These are project-specific data-platform boundaries, not company-wide development-governance rules.

- All central FreePass Data Firebase/Firestore access must resolve the target through `src/infra/firebase-target.ts`; do not initialize a second target app path.
- Source evidence physical collection names and source document-ID encoding come only from `src/infra/firestore-layout.ts`.
- Source-run head promotion semantics come from the Domain source policy (`decideSourceHead`); adapters must not reimplement CURRENT/STALE/INELIGIBLE decisions.
- `SourceIngestionStore` owns source-run ingestion lifecycle. `CatalogStore` owns Canonical transactional mutation. Do not collapse them into competing repositories or add a third source persistence path.
- FreePass Data may publish Estimate master-data facts/projections, but pricing/calculation/issued-quote engine contracts remain in the Estimate product boundary.
- Preview UI is reference material; FreePass Data is a data platform, not a second product UI implementation.

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

# FreePass Data 작업 지침

## F01/F86 시트 작업

- 작업 시작 전 `docs/F01-F86-SHEET-SPEC.md`를 읽는다. 기계 정본은 `contracts/f01-f86-sheet-spec.v1.json` 하나다. 사용자 최신 지시는 이전 규격보다 우선하며 변경 시 정본도 같이 고친다.
- 이름·색·열 너비·숨김을 기억이나 임의 숫자로 다시 만들지 않는다. `scripts/sheet-presentation.mjs`로 전체 변경안을 생성한다.
- F01/F86 전체를 읽고 `scripts/sheet-presentation.mjs`에 넣는 표준 절차는 `docs/F01-F86-SHEET-RUNBOOK.md`를 따른다. 일부 탭만 고치고 전체 완료라고 말하지 않는다.
- 실행기는 presentation-only다. 원천 최신화, 차량 통합/삭제, 금액 수정 권한이나 검증을 대체하지 않는다. HOLD를 우회하지 않는다.
- 수정 후 새 조회로 `--verify`를 실행하고 실제 시트 화면도 확인한다. Actions/운영 pin 미연결을 자동화 완료로 표현하지 않는다.
- 온라인 연결·후속 실행은 `docs/F01-F86-ONLINE-HANDOFF.md`에서 엔진/PR/실측 증거를 찾고 GitHub의 현재 pin을 다시 확인한다. 검증 전용 workflow 가지를 운영 main에 병합하지 않는다.
- 중앙 정본을 F01·F86·ERP.com과 각 화이트라벨·Admin이 가져다 쓰는 구조는 `docs/F01-F86-ERP-PUBLICATION-CONTRACT.md`를 따른다. 소비처를 세 곳으로 고정하거나 Admin/화이트라벨을 누락하지 않는다. 시트 표시 PASS를 전체 소비처 연결 완료로 확대하지 않는다.
- 원본과 다른 작업의 변경을 보존한다. RTDB는 영구 폐기 상태이며 복원/fallback/배포하지 않는다.
