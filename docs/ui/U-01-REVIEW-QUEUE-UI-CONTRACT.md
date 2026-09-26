# U-01 Review Queue UI contract

Status: presentation boundary over `SourceChangeReview`

## Purpose

Review Queue shows source-driven changes that require human attention without deciding whether a change is allowed.

It answers:
- which source/candidate pairs changed
- which diffs are REVIEWABLE
- which diffs are BLOCKED
- before/after values
- reasonCode
- authorityRuleId when supplied
- candidate issues
- revision/fingerprint context

## Read boundary

The UI consumes:

```js
read() -> {
  observedAt,
  reviews: SourceChangeReview[]
}
```

Queue discovery and `reviewSourceChange()` execution remain I/F responsibilities.

## Rules

U may:
- count supplied reviewable/blocked IDs
- search/filter visible reviews
- format before/after values
- render raw reason codes and authority rule IDs

U must not:
- call `reviewSourceChange()`
- rebuild diff classification
- infer REVIEWABLE/BLOCKED from field paths
- approve or apply changes
- create `approvedChangeIds`
- expose a mutation button before a safe command boundary exists

Default actual-route state is disconnected/fail-closed until an authorized queue reader is injected.
