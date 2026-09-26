# U-01 Data Control Tower UI contract

Status: presentation boundary over `freepass-data-control-tower-v1 / 1.0.0`

## Purpose

Control Tower is the operational overview for FreePass Data.

It deliberately does **not** invent one aggregate score. The report keeps operational axes separate:

- sourceObservation
- auditFreshness
- publication
- consumerHealth
- consumerReadiness
- sheetHealth

The UI renders those six axes side by side and surfaces the contract-owned `attention[]` codes.

## Read boundary

The UI consumes an injected:

```js
read() -> DataControlTowerReport
```

No Control Tower API exists in the Console runtime yet. The actual route therefore defaults to fail-closed "연결 대기" until I exposes the scheduled report through an authorized read path.

## Visible information

Top summary:
- readyTransitionCount
- consumerBlockedCount
- readinessHoldCount
- auditGapMinutes
- publicationHoldReasonCount

Axes:
- source observation identity/read time/digest/coverage/counts
- audit schedule configuration/status/reason/gap
- publication decision and authorization booleans
- consumer health policy/status/counts
- readiness policy/status/counts/ready transitions
- sheet health policy/status

Operator details:
- publication HOLD reasons
- ready transitions
- raw attention codes

## Boundary

U may:
- translate status labels
- format timestamps
- render counts and booleans already supplied
- link to Data Health for deeper consumer inspection

U must not:
- call `buildDataControlTower()`
- reproduce `attentionCodes()`
- derive a top-level overall status
- compare audit gap to max gap
- infer publication authorization
- fabricate missing policy counts

The report builder and scheduled evidence remain the operational truth.
