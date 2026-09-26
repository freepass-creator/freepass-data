# F-01 reconciliation unblock — 2026-09-26

Initial inspected baseline: `f150272d2a1832b7a6c80ed6cb2e60dc95e044e3` (PR #176 merged).
Converged implementation: `46e211eb5a96a8072dad4ab967de8283b71d9597` (PR #178 merged).
Consolidated regression test commit: `f6af037765cc1ffba74c6fd87c4abb7d15dd1551`.
Integration PR: #180.
Scope: FreePass Data only. No deployment, Firebase binding, writer transfer, RTDB, or live-data write.

## Defect

At the initial baseline, `matchesAxis` used exact normalized labels for trim, fuel type and drivetrain, while `facetMatchesSelection` used substring containment. After a model change, reconciliation could retain a stale `GT` against a `GT-Line`-only facet, `HYBRID` against `PLUG-IN HYBRID`, or `AWD` against `E-AWD`. The selector then returned zero candidates while reconciliation found no stale axis to clear.

## Convergence, not a competing implementation

During this unblock pass, the parallel F session merged PR #178. Its implementation already shares `EXACT_STRUCTURED_LABEL_AXES` with facet reconciliation and additionally gives stable IDs precedence over stale display labels. This pass preserves that newer implementation. The independently prepared source change was not pushed over it.

Only the regression suite and this evidence note are added on the existing F-01 branch. There is no new branch or duplicate selector.

## Regression coverage and #177 absorption

`tests/vehicle-selector-reconciliation-exact.test.ts` contains 26 cases, 13 per NEW_CAR/USED_CAR mode. It absorbs all 16 scenarios from the overlapping recovery PR #177 at `aa693bc081035904dd5bd860e6bb396b9f0d1617`:

- six categorical model-switch cases, using both the previous-model and target-model records;
- six normalized-exact retention cases with both models present;
- two descriptive powertrain partial-match cases;
- two protected available-fuel cases that clear an incompatible old model instead of the user's newly changed fuel.

It additionally covers six explicitly changed unavailable-category cases, two stable trim-ID mismatch cases, and two multiple-stale-category convergence cases. Inputs remain unchanged.

#177's overlapping source predicate correction is already provided by #178. Its incidental `selectionSubset` iteration refactor is not needed to fix this defect and is not copied. Do not replace #178's stable-ID precedence with the older #177 source. Close #177 as superseded only after the consolidated #180 exact-head CI passes and its coverage is merged. Preserve the I branch and any unrelated work.

The user's explicitly changed axis remains protected. An unavailable explicit choice is not silently broadened. Stable ID and numeric checks remain intact. Descriptive powertrain and free-text search retain their existing behavior.

CI evidence must be read from the exact PR head before merge. This note alone records CODED coverage, not a test-run result or production verification.

## Remaining integration gates

- #137: authoritative Vehicle Finder provider/transport and real-provider E2E.
- #65 and #70: consumer persistence/readback contracts; selector tests do not prove these boundaries.
- Production Canonical release activation and consumer cutover remain separate evidence-gated operations.

Re-read the issues and their latest evidence before claiming their current completion state. Do not rewrite the F selector in U or I to work around missing transport or weaken operational HOLD gates.
