# F-01 reconciliation unblock — 2026-09-26

Initial inspected baseline: `f150272d2a1832b7a6c80ed6cb2e60dc95e044e3` (PR #176 merged).
Converged implementation: `46e211eb5a96a8072dad4ab967de8283b71d9597` (PR #178 merged).
Regression test commit: `0c7b44b0a4c5d48ffb0ff2ea822c03da0942aacc`.
Scope: FreePass Data only. No deployment, Firebase binding, writer transfer, RTDB, or live-data write.

## Defect

At the initial baseline, `matchesAxis` used exact normalized labels for trim, fuel type and drivetrain, while `facetMatchesSelection` used substring containment. After a model change, reconciliation could retain a stale `GT` against a `GT-Line`-only facet, `HYBRID` against `PLUG-IN HYBRID`, or `AWD` against `E-AWD`. The selector then returned zero candidates while reconciliation found no stale axis to clear.

## Convergence, not a competing implementation

During this unblock pass, the parallel F session merged PR #178. Its implementation already shares `EXACT_STRUCTURED_LABEL_AXES` with facet reconciliation and additionally gives stable IDs precedence over stale display labels. This pass preserves that newer implementation. The independently prepared source change was not pushed over it.

Only the regression suite and this evidence note are added on the existing F-01 branch. There is no new branch or duplicate selector.

## Regression coverage

`tests/vehicle-selector-reconciliation-exact.test.ts` adds 24 cases across NEW_CAR and USED_CAR: three stale-category repairs, three protected-choice cases, three normalized-exact cases, descriptive partial matching, stable trim identity, and convergence with multiple stale categories, for each mode. Input immutability is checked in the stale-category cases.

The user's explicitly changed axis remains protected. An unavailable explicit choice is not silently broadened. Stable ID and numeric checks remain intact. Descriptive powertrain and free-text search retain their existing behavior.

CI evidence must be read from the exact PR head before merge. This note alone records CODED coverage, not a test-run result or production verification.

## Remaining integration gates

- #137: authoritative Vehicle Finder provider/transport and real-provider E2E.
- #65 and #70: consumer persistence/readback contracts; selector tests do not prove these boundaries.
- Production Canonical release activation and consumer cutover remain separate evidence-gated operations.

Re-read the issues and their latest evidence before claiming their current completion state. Do not rewrite the F selector in U or I to work around missing transport or weaken operational HOLD gates.
