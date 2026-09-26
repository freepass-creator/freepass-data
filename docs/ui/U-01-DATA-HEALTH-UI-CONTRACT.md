# U-01 Data Health UI contract

Status: presentation boundary over `consumer-health-v1`

## Purpose

Data Health is the FreePass Data control-surface view for consumer/runtime evidence.
It answers:

> 어떤 소비처가 현재 어떤 증거로 정상/주의/차단 상태이며, 무엇이 다음 전환을 막고 있는가?

U-01 renders the existing health contract. It does not calculate health.

## Read boundary

The UI consumes an injected:

```js
read()
```

that returns `consumer-health-v1 / 1.0.0`.

Default actual-route behavior is disconnected/fail-closed until I exposes an authorized read adapter.

## Visible information

Top-level:
- report status exactly as supplied: HEALTHY / DEGRADED / BLOCKED
- generatedAt
- presentation-only counts by supplied status

Per consumer:
- consumer/project/repository/domain
- supplied status
- currentStage / nextStage
- activeReadOwner / targetReadOwner
- switchKey
- evidence source/state
- observedAt / ageMs
- event/receipt/projection/release/manifest IDs
- supplied verification booleans
- supplied nextTransition and allowed flag
- blockers
- staticHoldReasons

## Boundary

U may:
- translate exact codes into Korean labels
- count entries by their already-supplied status
- filter/search the visible list without reordering contract truth
- format supplied timestamps/age values

U must not:
- derive HEALTHY/DEGRADED/BLOCKED
- decide transition allowed/blocked
- derive freshness from observedAt
- treat missing evidence as success
- invent source/readback/parity/fallback evidence
- query Firestore/RTDB directly

## Composition

Desktop:
- overall summary
- consumer list
- sticky evidence/detail panel

Mobile:
- card list
- detail replaces list
- fixed bottom "목록으로"
- Escape returns to list

The UI remains read-only. Migration/cutover actions belong to workflow/governance boundaries, not this U surface.
