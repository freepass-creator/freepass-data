# Vehicle Finder — first isolated UI slice

Date: 2026-09-25
State: CODED / FOCUSED TESTED. Not API-connected, deployed, persistence-verified, or cutover-verified.
Base: `main@09bc905a619b2d39faa649446c51a79c974b05c9`.
Owner scope: FreePass Data UI/UX; shared canonical data remains behind authorized read contracts.

## Decision carried forward

Find freely; preserve uncertainty; modify only with evidence; claim completion only where observed.
This slice implements search -> inspect -> explicit partial reference selection. It does NOT complete
the full search -> edit -> server validation -> persistence/history vertical slice.

## Implemented

- One search input; manufacturer/year/trim are never prerequisites.
- Entry label/approved aliases and evidence-backed configuration terms support free token order.
- Optional year/fuel/seats filters; unknown facts are not filled from the clock or UI defaults.
- All query tokens AND facet conditions must hold in a single configuration. Sibling facts cannot
  fabricate, for example, a hybrid seven-seat match when only hybrid-five/diesel-seven are supplied.
- Model references with no configuration evidence remain browseable and partially selectable.
- `PARTIAL_REFERENCE` carries the actual node ID/type and observation ID. Search context remains
  separate. It is never a completed vehicle configuration or a quote-ready Trim selection.
- Lookup disconnected / loading / failed / successful empty / partial coverage remain distinct.
- Out-of-order/aborted reads cannot replace a newer observation. No fixture fallback.
- Native table and buttons, visible focus, explicit selection, IME-aware input, Escape/back return.
- Responsive list + optional detail; mobile detail replaces the list without losing query/filter state.
- CSS inherits host brand tokens. Fallbacks reuse the existing preview's values; no new logo or
  assertion that these values have been independently approved by the CI center.

## Files and local use

- `preview/vehicle-finder/core.mjs`: pure search/selection and read lifecycle.
- `preview/vehicle-finder/view.mjs`: `mountVehicleFinder(root, {read, onSelect})`.
- `preview/vehicle-finder/finder.css`: scoped, dependency-free presentation.
- `preview/vehicle-finder/index.html`: disconnected integration entrypoint, NOT a production route.
- `scripts/tests/vehicle-finder.fixture.mjs`: clearly synthetic data, outside the preview directory.
- `scripts/tests/vehicle-finder.test.mjs`: Node built-in tests; no package or workflow changes.
- `scripts/tests/vehicle-finder.browser.py`: optional local HTTP and offline Chromium DOM tests.

The existing `/console` and `preview/index.html` are intentionally untouched. The new entrypoint is
not automatically served by the existing application. An HTTP static server can serve this directory
locally; until an authorized reader is injected, it correctly shows `조회 연결 대기`.

## Read-model boundary (not a new Canonical schema or public API)

`freepass.vehicle-finder.read/v1` is a component-level presentation shape:

- `observationId`, `observedAt`, `coverage: COMPLETE | PARTIAL`, `entries[]`.
- entry: `id`, `level`, `label`, `aliases[]`, `configurations[]`.
- configuration: `id`, `evidenceId`, `terms[]`, `facets`.
- allowed facets: `modelYear`, `fuel`, `seatCount`, `drivetrain`, `trim`.
- null/missing facets mean unknown, never a fabricated default.

The host adapter must authenticate/authorize, verify release/evidence, use actual canonical IDs,
provide an explicit observed scope, and materialize ONLY simultaneously valid configurations.
COMPLETE means complete within that authorized read scope, not all cars in the world.
A populated evidence ID is a reference, NOT client-side proof of canonical promotion.
No source collection is read directly and no REST path or Firebase collection is guessed.
The reader receives an AbortSignal; bounded scopes/pagination and the integration boundary remain
work for the host adapter. This first component does not promise full-catalog search performance.

`onSelect` is a local reference handoff, NOT an authorized persistence command. Downstream actions
must revalidate observation/revision, authority, and required configuration specificity. Partial
references must not be accepted as complete quote/contract inputs. Browser storage is not an SSOT.

## Tests observed in this execution

Commands:

```sh
node --check preview/vehicle-finder/core.mjs
node --check preview/vehicle-finder/view.mjs
node --test scripts/tests/vehicle-finder.test.mjs
python scripts/tests/vehicle-finder.browser.py --offline --output /tmp/finder-evidence
```

- Node syntax: PASS; focused unit tests: **27 PASS**.
- Offline Chromium DOM checks: **16 PASS** using synthetic fixtures only.
- Viewport checks: 360 / 390 / 412 / 1280 / 1440 / 1920 CSS px; list/detail overflow,
  native-button keyboard entry, focus return, and action height checked.
- Actual defects found and fixed: one-letter Latin tokens matching unrelated fuel substrings;
  focus loss after disabling the selection button; narrow header/action wrapping in visual review.
- HTTP navigation attempt was blocked by this execution environment (`ERR_BLOCKED_BY_ADMINISTRATOR`).
  No policy was disabled and no blocked URL was retried via an alternate route. Offline tests use
  source files rendered in memory; they are NOT HTTP/module-loader or production E2E evidence.
- Not run: repository-wide `npm run check` / full suite, real mobile IME/hardware,
  screen-reader combinations, production API/Firebase persistence, deployment/cutover.

Screenshots in the execution artifacts carry a visible synthetic-test / Firebase-disconnected label.
They are browser-rendered component evidence, not images of a production deployment.

## Next handoff / HOLD

1. Reconcile the latest vehicle-master PR #49/#50/#51 read boundaries. Do not modify their
   Canonical schemas or promote a HOLD source simply to make UI results appear.
2. Implement an authorized, bounded read adapter over the approved master serving contract.
3. Wire the component into the existing Console; preserve current runtime and last-known-good reads.
4. Verify real API failure/scope/auth, observation revisions and partial selection handoff.
5. Only then add permitted editing through existing command/revision/receipt/history contracts.

No production Firebase writes, IAM changes, deployment, writer cutover, GitHub Actions additions,
manual workflow dispatches, main merge, or changes to Admin/Sales/Estimate were performed.
Shared handoff files are not overwritten in this isolated slice; the PR and Issue #24 carry its entrypoint.
