# U-01 Vehicle Finder UI contract

Status: U-01 presentation boundary

## Purpose

Vehicle Finder must let a user begin with incomplete knowledge and still browse candidates.
U-01 does not decide which candidates match. It renders a view state produced by the F/I boundary.

## Ownership split

- U-01 owns search input, filters, result presentation, detail presentation, responsive layout, accessibility, loading/error/LKG presentation and explicit UNKNOWN display.
- F-01 owns partial-information search, candidate narrowing, impossible-combination rules and selection behavior.
- E-01 owns Vehicle Master facts, IDs, normalization, evidence and Canonical truth.
- I-01 owns the authorized read adapter, persistence and delivery boundary.

U-01 must not import a local search engine or copy the Vehicle Master into UI code.

## UI read adapter

The UI calls:

```js
read({ query, filters })
```

and expects `freepass.vehicle-finder.ui/v1`.

The adapter returns already-decided candidates plus display-safe metadata:
observation, coverage, result count, filter options, item path, state, facts, evidence IDs and selectability.

Missing facts remain explicit `unknown: true`; U-01 renders them as `미확인`.
It never converts unknown to zero, the current year or a guessed label.

## Interaction

- no mandatory manufacturer -> model -> year -> trim wizard
- typing any known fragment submits the whole query to the injected read adapter
- filters are optional narrowing controls
- refresh keeps last-known-good results visible during refresh
- failed refresh keeps the previous observation and says the new read failed
- mobile detail uses the FreePass fixed 3:7 bottom action boundary
- mobile results use separated cards
- desktop expands list + detail into two panels

The standalone preview is deliberately disconnected by default.
Synthetic fixtures belong only in tests.


## Operational state presentation

U-01 may render display metadata supplied by the read adapter, but does not calculate governance meaning.

Per result item the adapter may additionally provide:

- `freshness: { code, label }`
- `confidenceLabel`
- `sources: [{ id, label? }]`

These fields are optional presentation inputs. U-01 does not derive them from timestamps,
evidence counts or source names.

Rules:

- state label and exact state code are both visible
- `observedAt` is shown as an absolute observation timestamp
- freshness is shown only when supplied; otherwise `판정 없음`
- confidence is shown only when supplied; otherwise `평가 없음`
- missing source labels do not hide evidence IDs
- UNKNOWN facts remain `미확인`
- U-01 never converts age into FRESH/STALE or evidence count into a confidence score

## Web / mobile composition

Desktop keeps search + filters + results + selected detail visible together.
The detail panel is sticky within the viewport so evidence can be inspected without losing result context.

Mobile keeps search/results primary, opens filters as a bottom sheet and uses the fixed
3:7 bottom action boundary only while inspecting a result.


## New-car / used-car presentation

U-01 exposes a simple user mode choice:

- `NEW_CAR` → 신차
- `USED_CAR` → 중고차

U-01 sends the selected mode to the injected read adapter:

```js
read({ mode, query, filters })
```

The returned view state must echo the same `mode` and also provide:

- `presentation: GUIDED | SEARCH_FILTER`
- `guidance.resolutionStatus`
- optional `guidance.suggestedNextAxis`

The presentation meaning belongs to F-01. U-01 does not infer that NEW_CAR must be
GUIDED or USED_CAR must be SEARCH_FILTER; it renders the value returned by the adapter.

The visual intent is:

- new-car: current-sale exploration, concise guidance, common axes visible
- used-car: historical exploration, search-first context, year/generation/phase can remain visible

Both modes retain the same principle: missing knowledge widens the candidate set rather
than blocking search.

Changing mode clears the previous query/filter/detail UI state so a selection from one
consumption mode is never visually carried into the other.


## Adapter-ordered facets

U-01 no longer owns a fixed list such as year/fuel/seats/drivetrain/trim.

The read adapter supplies ordered facet sections:

```js
facets: [
  {
    axis: 'modelYear',
    label: '연식',
    options: [{ key: 'opaque-key', label: '2024', count: 12 }]
  }
]
```

Rules:

- facet order is rendered exactly as supplied
- `axis` and option `key` are opaque UI tokens; U-01 does not reinterpret them
- option counts are display-only
- `guidance.suggestedNextAxis` points to one of the supplied facet axes when guidance is available
- in `GUIDED` presentation, the suggested facet may be rendered as horizontal quick choices
- in `SEARCH_FILTER` presentation, all supplied facets remain available as ordinary filters
- U-01 does not own manufacturer/model/year/generation/phase priority or hidden-axis policy

This allows F-01 to expose generation/phase/model-year for historical used-car search
without adding those rules to U-01, while new-car guidance can remain concise.


## Candidate list scan contract

The result list is intentionally limited to a compact scan surface.

Each result always has:

1. primary title: `item.label`
2. optional adapter-prepared `item.listLines[]` with at most two lines
3. state label/code in the state column

`listLines` are display strings prepared by the F/I read adapter. U-01 does not
construct them from vehicle fields or decide that year/generation/powertrain must
always be shown. If `listLines` are absent, the existing `pathText` is used as
a conservative fallback context.

On mobile, the list returns to the prior scroll position after closing detail.
The previously inspected candidate is marked as `방금 본 후보` so the user can
resume scanning without losing place. Query and filters remain unchanged during
detail inspection and return.

Mode changes are different: they intentionally clear query/filter/detail/recent-item
context so NEW_CAR state cannot leak into USED_CAR and vice versa.


## Read-state semantics

U-01 must keep absence of data separate from absence of candidates.

Visible states:

- `DISCONNECTED`: no authorized read adapter is connected; never show fixture/demo vehicles as real
- `LOADING`: first read is in progress; do not show a 0-result message
- `ZERO`: a COMPLETE observation returned zero candidates for the current criteria
- `PARTIAL_ZERO`: a PARTIAL observation returned zero candidates; explicitly state this is not proof that no candidate exists globally
- `ERROR`: no usable snapshot exists and the read failed; explicitly state that this does not mean there are no vehicles
- `REFRESHING_WITH_LKG`: keep the previous observation visible while a newer read runs
- `REFRESH_ERROR_WITH_LKG`: keep the previous observation visible, show a retry action, and never replace it with an empty result

Search text and filter selections remain intact across loading and read failures.
Only an explicit mode change intentionally clears the mode-specific UI state.

U-01 does not translate transport errors into data facts and does not promote PARTIAL
coverage to COMPLETE.
