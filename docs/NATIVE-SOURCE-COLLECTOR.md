# FreePass Data native supplier intake — original ERP, not ERP4

Status (2026-09-30): **CODED / UNVERIFIED AGAINST LIVE ORIGINAL; RAW-ONLY PILOT. NOT DEPLOYED. NOT CUT OVER.**
Owner: FreePass Data. Existing `SourceIntakeBatch`, `ingestRawSourceBatch` and Firestore Source Store are reused.
This does not add a second CatalogStore, publication writer or scheduler.

## Non-negotiable topology

```text
Original supplier ERP/API/Sheet -> Data-owned source adapter
  -> existing SourceIntakeBatch/append-only RAW/source head
  -> reviewed normalization + Canonical + release (NOT YET CONNECTED HERE)
  -> F01/F86/ERP.com/Admin readback (NOT YET VERIFIED HERE)
```

ERP4 is a **consumer**, not a source collector, engine repository, upstream SSOT or fallback.
The 2026-09-30 legacy Data `data-delivery-owner.mjs` still checks out a frozen ERP4
engine as a transitional executor. It remains a known *unresolved operational*
dependency: do not call the native pipeline complete while that execution path exists.
Do not start a second writer while the legacy production refresh identity still has
authority. IAM fencing, backups and rollback of the active writer must be verified at
cutover, not inferred from a PR merge.

## RP031 / 이안카 direct pilot

`src/adapters/iancar-direct-source.ts` logs into the supplier's **original ERP** at the
single allowlisted host, holds the session only in process memory, and requests the
documented original `/api/inventory`. It has no ERP4 import or Firebase writer.
Supplier login uses a dedicated Data runtime secret (`IANKA_ACCOUNT_JSON`) rather
than copying ERP4 repository secrets.

The adapter validates the original full inventory model/unit response, normalized
unique vehicle numbers, reservations, declared inventory count, source `stale=false`,
upstream `syncedAt` age (<=2 hours), and known availability states. Unknown or
contradictory observations are HOLD; retrieval HTTP 200 alone does not establish a
current authoritative source. Absent vehicles are **not automatically retired**.
The existing Data source-head store chooses the newest FULL+COMPLETE observation.

The original `/api/inventory` does **not** supply an authorized complete rental
rate/deposit feed under the documented B2B credential. Native intake does not guess
prices or copy the ERP4 DOM bootstrap rate scrape. Any new authorized rate source
must have separately versioned per-period evidence, model/plate attribution and
freshness checks. Price publication is HOLD until that exists and is reviewed.
Supplier Google Sheets may provide separately attributed policy/price evidence but
must not silently overrule original ERP inventory availability.

`--compare-erp5` independently captures ERP5 products/policy/partner using the
existing Data read-only transaction and compares RP031 inventory by normalized
plate **both directions and state**. Output contains counts/digests only, not plate
IDs, supplier content or credentials. Even zero inventory differences is NOT proof
of price or F01/F86/customer consumer parity.

## Manual commands — default read-only

```sh
# With dedicated authorized Data runtime credentials injected securely:
# IANKA_ACCOUNT_JSON='...' (never command-line/password in Git)
npm run source:iancar:direct

# Optional independent DB inventory comparison, with a scoped read token and
# a private evidence bucket supplied through Data's existing authorized path:
npm run source:iancar:direct -- --compare-erp5

# RAW ONLY, requires a separate explicit operation approval and correct Data
# Firestore runtime IAM. This does NOT modify Canonical products or selling sheets.
IANCAR_DIRECT_RAW_INGEST_APPROVED=true npm run source:iancar:direct -- --apply-raw
```

The default command reads original ERP and returns only safe counts + issue codes;
no RAW/Canonical/Sheet mutation. `--apply-raw` refuses partial, stale or ambiguous
sources. Production identity and authentication must be provisioned by the sole
designated operations owner. No credentials are moved between repositories.

## Sales complaints: close only on one observed run

For each supplier and each reported plate/period record and compare:

1. Original live provider observed time and FULL+COMPLETE coverage.
2. Accepted Data source-run ID, RAW digest, newly added/missing plate sets and
   supplier availability (unknown values = HOLD; not "출고가능").
3. Reviewed Canonical/active product and source-backed **per-term** rent, deposit,
   age/mileage extras, policy code and applicability. No default price invention.
4. F01 and F86 same source revision and price/plate readback, then ERP.com/Admin
   authenticated rendered value from that revision. If any stage differs, mark
   `HOLD_SOURCE_PARITY`/`HOLD_PRICE_PARITY`/`HOLD_CONSUMER_READBACK` and do
   not issue a false green status. A downstream-to-downstream zero-diff is not
   source freshness evidence.

The existing 2026-09-21 Sonogong incident demonstrated this exact danger: source
224, published 177, F01 and F86 both 177 despite a misleading downstream "PASS".
Those are *historical* incident counts, never today's expected source totals.

## Before operational ownership switch

- Data original-source adapters exist for **every active supplier**, including
  new inventory and policy body changes; each has a proven fresh full capture.
- Data-native collection scheduler and recovery replace the frozen ERP4 executor.
  Only one active original-source writer remains after verified IAM fencing.
- Current original source <-> Data source-head <-> Canonical <-> F01/F86 <=>
  each consumer are compared per-plate, status and per-period conditions.
- Private backups/readbacks and a rollback drill pass; first native shadow runs
  have no unexplained source-only/target-only/status/price differences.
- Runtime Data IAM and consumer readback evidence are recorded. ERP4 legacy
  runner is then retired, **not** adopted as the new design.

This RP031 patch is a first vertical slice, not a claim that the above production
gates or all suppliers are complete.
