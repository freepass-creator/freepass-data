# Vehicle Selector Contract

Status: **IMPLEMENTED / FUNCTION BASELINE LOCKED**  
Date: 2026-09-26

## One selector engine

New-car and used-car selection use the same logical selector engine.

The selector axes are:

```
maker
model
generation
phase
modelYear
powertrain
fuelType
drivetrain
seats
trim
```

This list is a relationship graph, not a mandatory click order.

Any axis may be supplied first.
Every supplied fact narrows the same candidate set.
The engine also returns facets for the remaining axes.

Examples that are valid:

- maker -> model -> powertrain -> trim
- model -> modelYear -> trim
- powertrain -> model
- trim -> modelYear
- free-text + drivetrain
- model only

A missing year or trim does not prevent a candidate from being returned.
Unknown canonical identity remains unresolved rather than being guessed.

## Same engine, different UX

The engine contract is independent from presentation.

### NEW_CAR preset

Recommended presentation: `GUIDED`

Default visible order:

```
maker -> model -> powertrain -> drivetrain -> seats -> trim
```

Generation / phase / modelYear may stay hidden when the selected current product
already determines them.

This is a UI simplification only. The engine still accepts any axis first.

### USED_CAR preset

Recommended presentation: `SEARCH_FILTER`

Search is shown first, with filters for:

```
modelYear / generation / phase / powertrain / drivetrain / seats / trim
```

Users can start with whatever they know.

Examples:

- "쏘렌토"
- "2021 쏘렌토"
- "쏘렌토 하이브리드"
- "노블레스 4WD"

## Facet behavior

For each axis, facet options are calculated while applying every other selected axis.

This means changing one filter does not destroy the alternative values for that
same filter.

Example:

If the user has selected:

```
model = 쏘렌토
powertrain = 하이브리드
```

the `trim` facet contains only trims compatible with that candidate set, while
the `powertrain` facet may still show other powertrains available for 쏘렌토.

## Mode boundary

`NEW_CAR`
- CURRENT only
- RESOLVED identity only
- HOLD is excluded from normal selection

`USED_CAR`
- CURRENT + HISTORICAL + DISCONTINUED
- PARTIAL/HOLD may remain discoverable for identification
- unresolved candidate is not final-selectable until identity is resolved

## UI rule

UI/UX may differ freely as long as it sends the same selector contract.

Therefore:
- mobile new-car can use step navigation,
- desktop new-car can use multi-panel selection,
- mobile used-car can lead with search,
- desktop used-car can expose simultaneous filters,

without changing canonical IDs or selection semantics.


## UX guidance from the engine

The selector returns guidance in addition to candidates and facets:

- `singletonAxes`: only one remaining value; UI may collapse or auto-resolve it.
- `ambiguousAxes`: more than one value remains.
- `suggestedNextAxis`: the first useful ambiguous axis under that mode's UX preset.
- `resolvedRecordId`: exactly one final-selectable candidate remains.

This does not create a mandatory order.

For example, a new-car screen may hide generation/year when each has only one
possible value and ask for powertrain next. If model year becomes ambiguous,
the same engine exposes that ambiguity and the UI can reveal the year step.

A used-car screen normally keeps the filters visible instead of turning
`suggestedNextAxis` into a wizard step.


## Structured selection matching

Free-text search remains intentionally broad, but a structured trim selection is
an explicit identity choice.

Therefore:

- `selection.trim` label matching is normalized exact matching.
- `selection.fuelType` is also exact because it is a categorical fact.
- selecting `GT` must not also select `GT-Line`.
- selecting `GT-Line` must not select `GT`.
- selecting `HYBRID` must not also select `PLUG-IN HYBRID`.
- stable IDs remain the preferred exact identity when available.
- descriptive axes such as powertrain keep their compatible partial-label
  behavior so `하이브리드` can match `1.6 터보 하이브리드`.

This separation prevents search convenience from weakening an explicit trim
choice.

## Candidate action semantics

Selector candidates carry explicit functional action semantics:

- `ACTIVE -> SELECT`
- `UNKNOWN -> INSPECT_ONLY`
- `HOLD -> BLOCKED`

Candidate ordering keeps actionable evidence first:

1. SELECT
2. INSPECT_ONLY
3. BLOCKED

UNKNOWN/HOLD records may remain discoverable where the mode allows them, but they
must not manufacture selectable facet or drill-down options.

## Empty-result semantics

Zero candidates do not automatically mean that a vehicle or combination is
impossible.

The selector distinguishes:

- `UNRECOGNIZED_SEARCH`
- `INSUFFICIENT_DATA`
- `HOLD_ONLY`
- `OUT_OF_SCOPE`
- `IMPOSSIBLE_COMBINATION`

`IMPOSSIBLE_COMBINATION` is reserved for the case where the individual facts are
known but no single record proves that combination. Missing evidence remains
fail-closed as `NO_RESULT`, not a fabricated impossibility.

## Candidate ranking

Within the same candidate set, ranking is deterministic.

Priority is:

1. candidate action state
2. explicit selected-axis matches
3. direct axis search matches
4. exact search matches
5. more specific matched axes
6. lower alias-only dependence
7. fewer unresolved facts
8. stable recordId tie-break

Input record order must not change output order.

## Grouping and drill-down

Grouping is a projection for navigation; it never creates a second vehicle master.

- NEW_CAR groups use stable `vehicleModelId` and scope `MODEL`.
- USED_CAR groups use stable `vehicleModelId + generationId` and scope
  `MODEL_GENERATION`.
- Used-car rows without a stable generation remain separate
  `UNRESOLVED_IDENTITY` groups.
- maker is label-backed in current selector adapters and no maker ID is invented.
- new-car generation is not invented when the Estimate Master does not carry it.

The group representative is the highest-ranked member. Group members remain the
original concrete candidates.

Within a group, the engine exposes evidence-backed drill-down axes and
`suggestedDrilldownAxis`. The suggestion is adaptive and not a wizard lock.
Structural axes are preferred over trim when they provide useful narrowing.

Group/drill-down transitions are fail-closed:

- stale group -> `GROUP_NOT_FOUND`
- unresolved identity -> `UNRESOLVED_GROUP_IDENTITY`
- unavailable axis -> `DRILLDOWN_AXIS_NOT_AVAILABLE`
- unavailable option -> `DRILLDOWN_OPTION_NOT_AVAILABLE`

Every applied transition re-runs the same selector and returns the updated
candidate/group counts and guidance.

## Selection preservation

Changing one condition does not reset the entire selection.

The changed axis is protected. Existing selections are retained while they remain
compatible. Only stale conflicting selections are cleared, using canonical axis
depth rather than UI step order.

Removing a condition widens the candidate set without deleting still-valid
choices.

## Final approval

A single candidate is not sufficient for final approval.

`finalizeVehicleSelection()` returns:

- `APPROVED`
- `HOLD`

Approval requires an ACTIVE/SELECT candidate, no unresolved request evidence and
the mode-appropriate stable identity.

NEW_CAR requires stable model/modelYear/powertrain/trim identity and CURRENT
lifecycle.

USED_CAR additionally requires stable generation and phase identity.

When multiple candidates remain, a caller may explicitly provide a concrete
recordId. A stale recordId never falls back to the top-ranked candidate.

`guidance.resolvedRecordId` is populated only when the remaining candidate also
passes these finalization requirements.

## Selection receipt

After approval, `issueVehicleSelectionReceipt()` can seal a consumer-neutral
handoff artifact.

Receipt contract:

`vehicle-selection-receipt/v1`

It contains:

- selector contract version
- caller-supplied `issuedAt`
- normalized request snapshot
- selected VehicleSelectorRecord snapshot
- snapshot digest
- deterministic receipt ID
- receipt digest

The receipt is not a second master and does not define persistence.

`assertVehicleSelectionReceipt()` rejects tampering.

`revalidateVehicleSelectionReceipt()` compares the sealed selection against the
current master and returns:

- `CURRENT`
- `RESELECT_REQUIRED`

Material selected-configuration changes, record disappearance, non-finalizable
current state, request mismatch, future-dated evidence, or an explicitly supplied
age policy can require reselection. Alias-only changes do not.

There is no hidden default max-age threshold.

## Official master entrypoints

Consumers should not reimplement filtering around the master projections.

Official full-selector entrypoints are:

- `selectVehiclesFromNewcarMaster()`
- `selectVehiclesFromUsedcarMaster()`
- Estimate application alias: `selectEstimateNewcarMaster()`

These wrappers must remain semantically identical to converting records and
calling `selectVehicles()` directly.
