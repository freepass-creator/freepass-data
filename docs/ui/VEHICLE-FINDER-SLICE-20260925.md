# Vehicle Finder — hierarchy-aware read/inspect slice

Date: 2026-09-25  
State: CODED / REVIEW-REVISED. Not API-connected, deployed, persistence-verified, or cutover-verified.  
Base: `main@09bc905a619b2d39faa649446c51a79c974b05c9`.  
Vehicle Master alignment source: PR #50 `src/domain/vehicle-master.ts`.  
Adversarial review source: Claude branch `3321e06`, `docs/reviews/ADVERSARIAL-REVIEW-VEHICLE-FINDER-20260925.md`.

## Decision carried forward

Find freely; preserve uncertainty; modify only with evidence; claim completion only where observed.

This slice is still read-only:
`search -> inspect evidence-backed facts -> explicitly select a partial master reference`.

It does **not** turn search text into confirmed vehicle specifications and it does not implement
edit/save/persistence.

## What changed after adversarial review

### Vehicle Master hierarchy

The read projection is now `freepass.vehicle-finder.read/v2`.

It aligns its node vocabulary with PR #50:

- MAKE
- MODEL
- GENERATION
- PHASE
- MODEL_YEAR
- POWERTRAIN
- VARIANT
- TRIM
- BASE_ITEM
- OPTION
- PACKAGE
- OPTION_GROUP
- COLOR

Finder destinations are MAKE through TRIM. BASE_ITEM / OPTION / PACKAGE / OPTION_GROUP / COLOR
are known Vehicle Master node types but explicitly excluded from Finder results. A truly unknown
node type still fails closed.

Every Finder entry carries a canonical ancestor path:

`[{ id, nodeType, label }, ...leaf]`

The leaf must exactly match the entry id/type/label. The path is both displayed and searchable.
Therefore two trims both named “프레스티지” are distinguishable by paths such as:

- `기아 › 쏘렌토 › 2027 › 프레스티지`
- `기아 › 스포티지 › 2027 › 프레스티지`

No parent label is fabricated by the UI.

### Inspect before selection

Search returns the configuration IDs that actually satisfied the current query/filter intersection.
The detail panel displays those matching configurations and their evidence IDs plus known facets
(year/fuel/seats/drivetrain/trim). Missing facts stay missing.

Selection remains:

- `kind=PARTIAL_REFERENCE`
- actual node id/type/path
- observation ID
- `configurationConfirmed=false`
- candidate configuration IDs only as evidence context

Candidate configuration IDs are not promoted to a chosen/confirmed configuration.

### Read state continuity

Refresh no longer destroys the last-known-good snapshot.

- first read: `loading`
- refresh with previous valid data: `refreshing` + previous snapshot remains visible
- failed refresh: `error` + previous snapshot remains visible and is labeled as the previous observation
- only a newer validated read replaces the snapshot

A completed `onSelect` handoff is always surfaced. If the UI moved to a newer observation while
the host was processing selection, the notice says that the selection was delivered using the
previous observation ID instead of silently hiding the success.

### Search behavior

- query + filters still must agree in one configuration; sibling facts are never unioned
- canonical ancestor labels participate in search
- Korean whitespace-insensitive comparison is supported (for example `더뉴쏘렌토` can match
  `더 뉴 쏘렌토`)
- no fuzzy typo correction was added; unreviewed spelling guesses would create hidden semantics
- only approved aliases supplied by the read adapter are searched
- filtered candidates excluded because the requested facet is unknown are counted and disclosed
- rendered results are capped at 100 while reporting total match count
- normalized search terms are cached per accepted snapshot to avoid renormalizing the entire read on every key event

This is a UI guard, not a full-catalog search-engine SLO. Real master-size performance remains unverified.

### FreePass UI profile alignment

The component now follows the AI Core FreePass profile more directly.

Mobile:
- top = title/context only
- search/filter/refresh = utility area, not workflow completion actions
- list = spaced card layout rather than a shrunken desktop table
- detail local actions = fixed bottom action boundary
- two actions use 3:7 proportions: `목록으로 : 이 수준으로 선택`
- primary height = 48px
- safe-area padding is included

Selection is no longer color-only:
- selected surface tint
- stronger text weight
- `✓ 보는 중` marker

The primary foreground uses a host `--on-brand` token with a white fallback rather than assuming
white is always correct for every host brand.

## Read projection boundary

`freepass.vehicle-finder.read/v2` is a presentation projection, not a new Canonical Vehicle Master.

Required top-level fields:

- `observationId`
- `observedAt`
- `coverage: COMPLETE | PARTIAL`
- `entries[]`

Entry:

- `id`
- `nodeType` — exact PR #50 node vocabulary
- `label`
- `aliases[]`
- `path[]` — exact ancestor identity/labels ending at the entry
- `configurations[]`

Configuration:

- `id`
- `evidenceId`
- `terms[]`
- `facets`: modelYear / fuel / seatCount / drivetrain / trim

The future authorized adapter must derive this projection from the approved Vehicle Master serving
boundary. The component must not query Firestore collections directly.

## Explicit non-goals / HOLD

Still not proved:

- #49/#50/#51 serving endpoint/auth integration
- Firebase-backed Vehicle Master data
- actual master-size performance and DOM cost
- screen-reader combinations and physical mobile devices
- Console integration
- persistence/edit commands
- full repository `npm run check`
- production deployment/cutover

The Finder must not be called production-ready from synthetic fixture tests.

## Next implementation order

1. define/confirm the authorized Vehicle Master Finder serving projection from the #50/#51 hierarchy
2. connect PR #52 to that bounded reader without exposing internal Firestore topology
3. run real read integration and validate MAKE/path/configuration evidence
4. verify real browser/mobile/screen-reader behavior
5. only then add permitted edit commands through revision/authority/receipt/history contracts

No production Firebase writes, IAM changes, deployment, writer cutover, workflow additions,
manual workflow dispatches, main merge, or changes to Admin/Sales/Estimate are authorized by this slice.
