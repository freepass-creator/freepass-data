# Vehicle Master Recent-first Backfill

Status: **IMPLEMENTED BASELINE / CANONICAL AUTO-PROMOTION DISABLED**  
Date: 2026-09-25

## Goal

Build the vehicle master broadly, not source-by-source.

The collection order is:

```
current inventory
  -> newest model-year evidence
  -> recent prior model years on the same model page
  -> previous phase / generation
  -> deeper historical recovery
  -> unresolved gaps
```

The system should move from recent data backward while preserving every captured
source document and never replacing missing history with guesses.

## Source lanes

### Manufacturer official
Highest authority.
Used whenever a reviewed official URL is available.
There is no single cross-brand discovery URL, so manufacturer URLs can be injected
into the same campaign as explicit source URLs.

### Carnoon
Current inventory discovery:
`https://www.carnoon.co.kr/newcar/search`

A model detail page can contain several model years, so one capture may produce
multiple recent-year normalized records.

### Danawa Auto
Current inventory discovery:
`https://auto.danawa.com/newcar/`

Estimate pages are used as a cross-provider source for model year, powertrain,
trim, drivetrain and original new-car price.

### CarIsYou
Inventory discovery:
`https://www.carisyou.com/car/`

For each discovered vehicle, the backfill expands into:
- `/Price`
- `/Spec`

This lane is intended to continue farther into discontinued and historical models.

Used-market price text is not imported into Vehicle Master.

### WikiCar
Discovery-only / weak evidence lane.
It may help locate historical labels or documents but does not count as independent
canonical corroboration.

## Persistence

Every detail page is processed through the existing evidence pipeline:

```
HTTP fetch
 -> immutable source bytes in Firebase Storage
 -> SourceDocument in Firestore
 -> SHA-256 evidence record
 -> RAW_RECORD
 -> NORMALIZED_RECORD(s)
```

A parser missing for a captured page does not discard the evidence.
The source remains archived as `CAPTURED_HOLD` and can be reprocessed after a parser is added.

## No automatic Canonical promotion

The backfill command does not call Canonical promotion.

Normalized facts must still pass:
- source authority
- independent corroboration
- temporal compatibility
- parent/reference integrity
- conflict detection

before becoming Canonical Vehicle Master.

## Running

Command:

```
npm run backfill:vehicle-master
```

Required explicit switch:

```
VEHICLE_MASTER_BACKFILL_APPROVED=true
```

Default provider discovery:

```
CARNOON,DANAWA,CARISYOU
```

The queue is sorted by:
1. latest model-year hint descending
2. current/sale hint
3. provider priority
4. stable URL

The batch size is bounded. The command returns `nextCompletedUrls`; a runner can
feed that list into the next execution so each batch moves progressively backward.

## Important separation

This backfill collects vehicle identity/history facts.

It does not turn used listings, mileage, accident history, seller price or transaction
price into Vehicle Master. Those remain Asset/Listing/Market facts.


## Coverage-led continuation

Before each batch the runner builds a model-year coverage ledger from persisted
SourceDocuments and NORMALIZED_RECORD evidence.

Coverage status:
- OFFICIAL
- CORROBORATED
- SINGLE_SOURCE
- DISCOVERY_ONLY
- MISSING (for a newly discovered page with no matching coverage row)

Recent model year remains the primary sort key. Within the same year, weaker
coverage runs first.

Resume is evidence-aware rather than permanently URL-based.

A page is considered complete only when the persisted normalized evidence was
produced by the **current parser ID + parser version**.

- Parser version changed -> eligible for reprocessing.
- Current or unknown-status page -> eligible for re-capture after
  `VEHICLE_MASTER_BACKFILL_CURRENT_TTL_HOURS` (default 24h), so a new model year
  added to the same URL can be discovered.
- Historical/discontinued page -> same parser version may remain complete without TTL.
- Source-only `CAPTURED_HOLD` -> remains retryable.
- `VEHICLE_MASTER_BACKFILL_COMPLETED_URLS_JSON` is an explicit operator override
  and should not be used for normal resume.

Therefore a resumed campaign does not depend on the operator carrying a local
completed-URL ledger.

Each run writes an immutable AUDIT_REPORT with before/after coverage digests,
coverage-status counts, recapture TTL, and automatic/manual skip counts.

## Inventory shards

Some providers expose only a partial initial list.

CarIsYou currently uses a “more” style list for a catalog larger than the visible
first page. The runner therefore detects brand filter IDs from the inventory HTML
and follows brand-specific inventory URLs, bounded by
`VEHICLE_MASTER_BACKFILL_DISCOVERY_PAGE_LIMIT`.

The discovery layer also scans provider-specific detail URL patterns outside
ordinary anchor hrefs so JavaScript-embedded detail URLs can still be queued.
