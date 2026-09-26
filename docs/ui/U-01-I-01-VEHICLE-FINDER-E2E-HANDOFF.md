# Vehicle Finder U-01 -> I-01 E2E handoff

Status: **INTEGRATION HOLD**
Tracking: **#137**

## Current observed state

As of the current mainline audit:

- `work/data/i-01-integration` is identical to `main`
- `/console/vehicle-finder` serves the Finder UI shell
- Finder UI assets are reachable
- the browser UI is intentionally disconnected by default
- `src/api/server.ts` has no Vehicle Finder read/finalize/revalidate data endpoint
- repository search finds no production host adapter that injects Finder `read`, `onGroupDrilldown`, `onFinalize`, `onSelect`, or `onRevalidate`

Therefore the UI is **not real-data E2E complete** yet.

This is an I-01 dependency, not a U-01 presentation defect.

## Required integration boundary

The host/runtime must inject the existing U callbacks.

### read

Input:

```js
{
  mode,
  query,
  filters,
  readContext
}
```

Output:

```js
freepass.vehicle-finder.ui/v1
```

I/F responsibilities before returning the snapshot:

1. load authoritative NEW_CAR / USED_CAR source records
2. adapt those records using existing selector adapters
3. run F-owned selection/search/group logic
4. provide ordered facets
5. attach evidence-backed display metadata
6. call `presentVehicleSelectorResult()`
7. return the resulting UI snapshot

No browser Firestore read is permitted.

### onGroupDrilldown

Input is the U-emitted F option payload plus current opaque context.

I/F executes the existing F transition and returns:

```js
{
  transition: {
    status: 'APPLIED' | 'REJECTED',
    reason,
    activeGroupId,
    beforeCandidateCount,
    afterCandidateCount,
    clearedAxes
  },
  snapshot?,
  readContext?,
  message?
}
```

### onFinalize

I/F executes finalization against current authoritative records and returns a U-presented review:

```js
{
  review: {
    status: 'APPROVED' | 'HOLD',
    recordId,
    canConfirm,
    reasons
  },
  finalizationContext?
}
```

### onSelect

Only after APPROVED:

1. issue the existing F selection receipt
2. persist/deliver using authorized I/F infrastructure
3. return receipt metadata for display

U does not issue or validate the receipt.

### onRevalidate

I/F revalidates the receipt using current authoritative data and current policy.

Return a U-presented review:

```js
{
  review: {
    status: 'CURRENT' | 'RESELECT_REQUIRED',
    receiptId,
    recordId,
    ageMs,
    currentRecordChanged,
    snapshotRecordDigest,
    currentRecordDigest,
    reasons
  }
}
```

## Fail-closed requirements

Integration must not:

- fall back to fixtures
- silently fall back to legacy/RTDB
- expose internal Firestore paths to browser code
- create a second Vehicle Master
- copy selector ranking/search semantics into transport
- convert provider failure into zero candidates
- confirm UNKNOWN/HOLD candidates
- issue receipt without F APPROVED
- treat a stale/reselect-required receipt as current

Provider/auth/source failure must surface as transport/read failure while U retains last-known-good UI state where available.

## Real-data E2E acceptance

Issue #137 is complete only when all are proven on the actual route:

### Read
- NEW_CAR authoritative data renders
- USED_CAR authoritative/historical data renders
- partial-information search widens rather than blocks
- observedAt / source / evidence are real, not fixture labels
- COMPLETE/PARTIAL is sourced from the provider

### Candidate flow
- groups come from F
- drilldown applies through F transition
- REJECTED transition keeps current snapshot
- UNKNOWN/HOLD stay non-selectable

### Confirmation
- F APPROVED enables final confirm
- F HOLD blocks confirm with raw reason codes
- confirmed selection returns a real F receipt
- stale final review is invalidated by newer read state

### Revalidation
- CURRENT is shown only from F revalidation
- changed/stale/missing/non-finalizable records return RESELECT_REQUIRED
- digest evidence is provider/F supplied

### Security / architecture
- browser receives a stable contract, not Firestore topology
- no RTDB
- no fixture fallback
- no direct UI persistence
- data access boundary / auth remain enforced

### Verification
- Core CI PASS
- Canon Guard PASS
- synthetic U Actual Route QA remains PASS
- **new real-provider actual-route E2E PASS**

## U-01 return condition

U-01 should be reopened only if real-provider E2E exposes a presentation defect such as:

- contract-valid data cannot be rendered
- state is misleading
- mobile/web composition breaks
- accessibility/focus breaks
- real metadata overflows or becomes unreadable

Provider loading, auth, source choice, F execution, receipt issuance and revalidation remain I/F ownership.
