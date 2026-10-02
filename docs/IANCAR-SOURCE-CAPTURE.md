# Iancar source capture

## Direct ERP intake — 2026-09-30

User decision: Iancar supplier ERP is the vehicle source; the Google Sheet is not an inventory-source fallback.
`iancarErpReadTransport()` now implements the existing authenticated supplier login/inventory protocol in
FreePass Data. Credentials are supplied only by `IANKA_ACCOUNT_JSON`; response bodies, cookies and credentials
are never printed on authentication/HTTP failure. Redirects are rejected. No new writer or Firebase path exists.

The existing job supports:

```sh
node --import tsx src/jobs/ingest-erp5-source.ts --iancar-erp --dry-run
```

It requires the existing read-audit token/bucket plus the supplier credential. Without `--dry-run`, the existing
`ERP5_SOURCE_INGEST_APPROVED=true` gate is still required and the existing SourceIngestionStore owns RAW writes.
This mode does not read either Sheet, and does not filter out previously unregistered vehicles. It preserves
the full response as one RAW record and separate supplier-vehicle-ID records, including reserved stock.
The job emits only counts, observation time, checksums and coverage. Canonical review and consumer publication
are not bypassed by RAW intake.

**Coverage is PARTIAL even when every advertised row is captured.** The observed API exposes available/reserved
inventory, while `fleetTotal` can be much larger. Per-model counts, inventory/reservation totals and duplicate IDs
are checked. Stale, future or over-one-hour supplier observations remain INCOMPLETE. An absent vehicle cannot be
retired from this endpoint. Rental rates are not present: pricing remains UNKNOWN/HOLD, never 0 or a silent Sheet fallback.

Operational cutover is **NOT VERIFIED**: the production legacy bridge still uses its old Sheet source and pin.
The supplier credential exists in the ERP bridge's GitHub secret but is not present in the local central job or
central runtime Secret Manager. Do not copy it into code, public workflow logs or artifacts. Actual secure runtime
binding, reviewed candidate mapping, exact writer/publisher cutover and every consumer readback remain required.

## Contract

`src/adapters/iancar-source-capture.ts` extends the existing immutable ERP5 capture pattern for two
independent upstreams. One bundle contains the Iancar ERP raw response, its vehicle/rate evidence, and
the complete raw CSV of both fixed Google Sheet tabs (`이안카`, `이안카 재렌트`). A SHA-256 digest covers
the entire bundle. Failure of either Sheet tab fails the run instead of producing a partial success.
ERP failure also rejects the whole Promise. ERP raw, parsed vehicle list, and parsed rate list have separate
digests plus a required parser version so derivation drift is visible.

This is `REUSE_WITH_ADAPTER`: the ERP5 capture's immutable evidence/digest pattern is reused, while a
new adapter is necessary because Iancar has no cross-system transaction and has two independent sources.

## Non-volatile boundary

`persistIancarCapture()` saves each bundle with exclusive-create semantics under
`~/.codex/private/freepass-data-iancar-captures/<runId>/capture.json` and verifies the digest after readback.
There is no caller-selected output path and no overwrite. The existing append-only RAW store is the later
operational destination after authorization. Neither inspection nor mapping overwrites an earlier capture.
The collector must provide source revision, observation time, full-collection evidence, and separate ERP
rate coverage. Collection success alone does not prove freshness.

ERP and Google Sheets cannot be read in one cross-system transaction. Every bundle therefore declares
`crossSourceConsistency=NON_ATOMIC`; its digest proves bundle integrity, not simultaneous source state.
Downstream freshness/parity review must account for the independent observation times.
The digest covers the exact captured representation and is intentionally order-sensitive; it is not a
semantic equality hash across independently serialized provider responses.

The local private file is plaintext and is only a preparation/evidence boundary. UUID naming and file modes
are not encryption or a complete Windows ACL/retention policy. Long-term operational storage must use the
authorized encrypted append-only RAW store with explicit access and retention controls.

The existing authenticated `/api/inventory` path contains inventory facts but does not establish complete
rental-rate coverage. Until the ERP rate source is captured and `rateCoverageComplete=true` is supported by
evidence, pricing remains `HOLD`. Google Sheet prices do not silently replace missing ERP rate evidence.

This module imports no Firebase client or canonical writer. No Firebase writes, Sheet writes, Canonical writes,
publication, or consumer cutover are authorized by this unit.
