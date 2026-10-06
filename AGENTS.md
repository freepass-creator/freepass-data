# freepass-data — AI / Codex Work Entry Rules

> **★★차종·제원(제조사·모델·세부모델·세부트림·연료·배기량·구동)을 채우거나 고치거나 판단하는 모든 AI·로직은 ai-ops `docs/차종-기준-한장.md`(https://github.com/freepass-creator/ai-ops/blob/master/docs/차종-기준-한장.md) 한 장만 따른다 — 대표 2026-10-04 「어떤 AI가 오든 어떤 로직이 오든 흔들리지 않게」. 이 저장소의 SSOT 「차종 4단 구조」 절과 코드는 그 장의 구현이다. 그 장은 대표만 바꾼다. 더 나은 규칙이 보이면 코드·문서를 먼저 바꾸지 말고 AI 상황실에 `결정필요:`.**

## 0. Mandatory entrypoint

Every Codex/Work/development AI working in this repository must start in this order:

1. `AGENTS.md`
2. `docs/NEXT-START-HERE.md`
3. `docs/IMPLEMENTATION-STATUS.md`
4. `docs/ARCHITECTURE-V2-APPROVED.md`
5. GitHub Issue #24 and the active PR/branch for the work

`docs/NEXT-START-HERE.md` is the current Chat → Work handoff board. Do not assume chat context is available locally.

Start its stable [Data work entry guide](docs/NEXT-START-HERE.md#data-start) before the dated history. Use its question-to-document map to locate the existing authority; do not create another policy dictionary or treat a dated audit as current source truth. Product/policy meaning lives in [Commercial Data Catalog](docs/COMMERCIAL-DATA-CONSUMER-ROLLOUT.md#policy-dictionary). Record unresolved semantics and missing private evidence as HOLD.

Keep this stable guide above the dated log. Add new work records under `날짜별 작업 이력`; update the guide's routes and unresolved items when their evidence changes.

## 1. Historical 2026-09-22 P0 packet

The baseline handoff is the section:

`2026-09-22 AI Core audit — Codex/Work immediate packet`

in `docs/NEXT-START-HERE.md`.

Retain it as history. Check the stable entry guide, latest scoped handoff and current main/PR evidence before assigning present priority. This reclassification does not declare its remaining items complete.

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

## 공급사 공통 입력 시트 규격 잠금 (대표 2026-10-06)

- 공통 입력 시트를 고치기 전에 `contracts/supplier-input-sheet-spec.v1.json`의 `changeControl`과 현행 `dropdownPolicy.lightweight`, `docs/SUPPLIER-INPUT-SHEET-RUNBOOK.md` 맨 위 현행 규격을 읽는다. 과거 날짜의 드롭다운·서식을 다시 적용하지 않는다.
- 앞으로 대표가 수정 지시하면 같은 작업에서 정본 현행값·baselineVersion·이유, 실행 코드/필요 검증, 라이브 되읽기와 전후 이력, NEXT-START-HERE의 exact commit/남은 HOLD를 함께 남긴다. 채팅 기억만으로 수정하거나 문서만 변경하고 적용 완료라고 하지 않는다.
- 현재 없는 공급사 입력 탭은 새 지시 없이 복원하지 않는다. 차종 정본과 입력 UI 후보를 혼동하지 않는다. 운영 자동 감시·pin이 없으면 항상 강제된다고 표현하지 않는다.
- UI 변경은 `uiOwnership`의 입력/머리글/종합/helper 소유권과 `scripts/shared-sheet-ux.mjs` 표시 필드 허용 검사를 따른다. 머리글 보호는 관리 계정·Google 소유자가 우회할 수 있으며 AI 전체 불변 보장으로 표현하지 않는다. 인도완료·취소·진행중을 출고불가·계약중에서 추정하지 않는다.
