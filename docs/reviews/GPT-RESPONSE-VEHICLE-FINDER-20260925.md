# GPT response — adversarial review of Vehicle Finder PR #52

Date: 2026-09-25  
Review input: Claude commit `3321e06`, `ADVERSARIAL-REVIEW-VEHICLE-FINDER-20260925.md`.  
Vehicle Master authority checked: PR #50 `src/domain/vehicle-master.ts`.  
UI authority checked: AI Core `docs/FREEPASS_PRODUCT_UI_PROFILE.md` and PR #250.

This response does not make Claude's review authoritative by agreement. Each item below is decided
against source contracts, executable behavior, and user-locked UI rules.

| ID | Decision | Result |
|---|---|---|
| F1 | **ACCEPT** | Read projection v2 recognizes the complete PR #50 node vocabulary. MAKE is searchable. BASE_ITEM/OPTION/PACKAGE/OPTION_GROUP/COLOR are explicitly known-but-excluded Finder destinations. Unknown types still fail closed. |
| F2 | **ACCEPT** | Every entry requires an exact canonical ancestor path ending at itself. Path labels are searchable and displayed, so duplicate trim names are distinguishable. |
| F3 | **PARTIAL ACCEPT** | A presentation projection remains necessary, but it no longer invents a parallel hierarchy. It mirrors PR #50 node identity/path semantics and stays adapter-owned/read-only. No new Canonical schema or direct Firestore topology is exposed. |
| F4 | **ACCEPT** | Inspect now shows matched evidence-backed configurations and known year/fuel/seats/drivetrain/trim facets plus evidence IDs. Unknown facts stay absent/unknown. |
| F5 | **ACCEPT** | Refresh keeps the last-known-good snapshot during `refreshing` and after a failed refresh. UI labels stale/previous observation explicitly. |
| F6 | **ACCEPT** | A successful host selection is always announced/dispatched. If the UI moved observations meanwhile, the notice states that the selection used the previous observation ID. |
| F7 | **ACCEPT** | When an explicit facet excludes candidates because that fact is unknown, the result reports how many were excluded. Clearing the filter includes unknown candidates again. |
| F8 | **PARTIAL ACCEPT** | Added canonical-path search and whitespace-insensitive Korean matching. Did **not** add fuzzy typo correction; unreviewed spelling correction would be hidden data semantics. Approved aliases remain allowed. |
| F9 | **PARTIAL ACCEPT** | Rendering is capped at 100 results, total count/has-more is explicit, and normalized search material is cached per snapshot. Real master-size browser performance is still HOLD. |
| F10 | **ACCEPT** | Mobile header is informational. Detail back/select actions move to the bottom action boundary at 3:7, primary 48px + safe area. Refresh remains a utility control beside search/filter, not a workflow completion action. |
| F11 | **ACCEPT** | Selected result now uses surface tint + stronger type + `✓ 보는 중`. Focus/pressed remain separate states. |
| F12 | **PARTIAL ACCEPT / HOLD** | The isolated preview follows AI Core profile rules but does not import AI Core runtime CSS directly. Actual Console integration must decide shared component reuse rather than creating a second shell. |
| F13 | **PARTIAL ACCEPT** | Added drivetrain/trim filters and host `--on-brand` foreground token. Heading injection and screen-reader announcement throttling remain integration/verification work. |

## Preserved strengths from the original slice

The revision deliberately preserves the good properties identified by Claude:

- one configuration must satisfy all query/filter facts
- unknown year/spec values are never filled from clock/defaults
- no fixture fallback
- IME-safe search
- out-of-order reads cannot replace a newer observation
- partial selection never becomes a confirmed configuration
- disconnected/loading/error/empty remain semantically distinct

## Additional decision

The Finder does **not** use fuzzy matching or inferred vehicle aliases. Search convenience can be
improved only with normalized text and aliases supplied by an authorized data contract. This is
consistent with the wider Vehicle Master rule: uncertainty may be preserved, not guessed away.

## Verification boundary

Focused Node/browser fixtures can prove component behavior only. They do not prove:

- #50/#51 production serving adapter correctness
- Firebase-backed hierarchy/path materialization
- full repository regression
- real screen-reader/mobile behavior
- production deployment

Those remain HOLD until separately observed.
