# Vehicle Selector Contract

Status: **LOCKED BASELINE**  
Date: 2026-09-25

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
