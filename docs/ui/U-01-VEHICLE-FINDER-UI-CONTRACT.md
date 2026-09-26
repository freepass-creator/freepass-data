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
