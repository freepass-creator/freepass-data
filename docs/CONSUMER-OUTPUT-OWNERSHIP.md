# Consumer output ownership

FreePass Data owns the data meaning and validation contract for every consumer
projection. A consumer writer may transport an approved projection, but it must
not independently reclassify records, add fee periods, or reinterpret missing
source evidence.

## F86 Hahuho

- Owner: `freepass-data`
- Presentation: retro
- Grouping axis: supplier
- Fee scope: long-term only (`24` months and later, plus deposit/rule columns)
- Source supplier: both groups retain `RP012` provenance
- Consumer output groups and product types are separate axes:
  - `SON_NO_KONG` with `하/허/호` plate -> `SONOGONG_PRODUCTS` / `USED_RENT`
  - `SON_NO_KONG` with a non-rental plate -> `SONOGONG_PRODUCTS` / `OGONG_SUBSCRIPTION`
  - `TCAR_EXTERNAL` -> `PICKUP_SUBSCRIPTION` / `PICKUP_SUBSCRIPTION` (티카 상품 구성 구독)
  - missing plate or unknown bucket -> `HOLD`

The operating F86 writer remains outside this repository today. Until it reads
an approved FreePass Data release and returns a consumer receipt, F86 is not an
enforced downstream connection and must not be reported as migrated.

The executable contract is `src/domain/consumer-output-contract.ts` and its
regression coverage is `tests/consumer-output-contract.test.ts`.


## F01/F86 delivery boundary

F01/F86 are downstream transports, not SSOT owners.

A sheet writer may publish only from an approved FreePass Data release. Completion
requires a `freepass-sheet-delivery-v1` receipt that binds the target workbook
to the exact `projectionId/releaseId/manifestId/inputDigest/dataDigest`, records the
render transform contract and its expected output digest/count, and then requires
a successful readback of that rendered output. The executable validator is
`src/domain/consumer-delivery.ts`; the JSON contract is
`contracts/sheet-delivery-receipt.v1.schema.json`.

Until that receipt exists and validates, F01/F86 remain HOLD even if a legacy
publisher produced matching rows from another snapshot.


The projection `dataDigest` and the rendered sheet `dataDigest` are deliberately
different digest domains. A sheet renderer changes shape, grouping, columns, and
presentation, so comparing the native sheet readback digest directly with the
projection digest is invalid. The receipt proves release identity through
`approvedRelease`, then proves transport integrity by comparing
`renderedOutput.dataDigest/vehicleKeyCount` with the readback values.


## Migration bridge ownership

The target end state is still `CANONICAL_ACTIVE`, but F01/F86 migration must not
wait for the entire Catalog canonicalization program to finish before authority
moves out of ERP4.

FreePass Data therefore owns a temporary, explicit migration authority:

`LEGACY_VERIFIED_BRIDGE`

This bridge is not Canonical Catalog authority. It is a Data-owned transport
release built from one read-only Firestore transaction over the operational
`products`, `policy`, and `partner` collections.

Executable path:

- `src/application/sheet-publication-bridge.ts`
- `captureErp5SheetSource()` — captures all three collections at one Firestore read time
- `buildSheetBridgeRelease()` — decodes without inventing missing values, verifies inventory invariants, and creates one bridge release + manifest
- `buildSheetBridgeHandoff()` — emits F01/F86-specific `freepass-sheet-handoff-v1` payloads
- `validateSheetPublicationHandoff()` — rechecks manifest identity, counts, release digest, snapshot digest and handoff hash

The bridge release is identified by `releaseAuthority=LEGACY_VERIFIED_BRIDGE`
and `projectionId=sheet-publication-bridge`. It must never be reported as a
Canonical ACTIVE Catalog release.

The bridge can be retired only after a `CANONICAL_ACTIVE` sheet projection
contains all fields needed by the sheet writers and the same delivery receipt
contract passes end-to-end.

A valid `LEGACY_VERIFIED_BRIDGE` delivery receipt may prove that the FreePass Data
transport path and readback are working for shadow/migration purposes, but it must
not set canonical production readback evidence. The executable conversion is
`deriveSheetCutoverEvidence()`: bridge authority keeps
`productionReadbackVerified=false`, while only a valid `CANONICAL_ACTIVE`
delivery may set it to true. The cutover evaluator independently rejects
`sheet-publication-bridge` as authority for the final `FREEPASS_DATA_READ` stage.

### Durable delivery evidence

Validated F01/F86 receipts are persisted separately from generic projection/outbox
delivery receipts. The central Firestore layout owns
`projection.sheetDeliveryEvidence = sheet_delivery_evidence`.

The durable flow is:

`validated handoff + delivery receipt -> recordSheetDeliveryEvidence() -> Firestore -> assessLatestSheetConsumerCutover() -> evaluateConsumerCutover()`

The latest durable receipt for a Sheet consumer is authoritative for its current
Sheet readback evidence. If a newer bridge receipt follows an older canonical
receipt, final cutover becomes HOLD again rather than continuing to trust the stale
canonical receipt.

Operational commands:

```bash
# validation only; no Firestore write
npm run record:sheet-delivery-evidence -- --handoff=/path/handoff.json --receipt=/path/receipt.json

# durable write; both switches are required
FREEPASS_SHEET_EVIDENCE_WRITE_AUTHORIZED=1 npm run record:sheet-delivery-evidence -- --handoff=/path/handoff.json --receipt=/path/receipt.json --apply

# read durable evidence and assess a registered Sheet consumer
npm run assess:sheet-cutover -- --consumer=google-sheets-f01 --target=SHADOW_READ
```

The recorder is fail-closed: an invalid handoff or receipt is never persisted.

### F01/F86 operational health projection

The read-only operational status contract is
`contracts/sheet-consumer-health-v1.schema.json`.
`readSheetConsumerHealth()` summarizes both registered Sheet consumers from the
same durable delivery evidence and cutover registry used by the enforcement path.

Each consumer entry reports the current stage, next stage, latest receipt identity,
evidence digest, release authority, approved release identity, freshness result,
readback flags, next-transition decision and blockers.

Operational check:

```bash
npm run check:sheet-consumer-health -- \
  --max-age-minutes=30 \
  --max-future-skew-seconds=30
```

The health command is read-only and passes through the Data Access Gateway audit
boundary. Overall `BLOCKED` exits non-zero. Missing evidence is shown explicitly
with null receipt/release fields rather than being inferred as healthy.

The scheduled ERP5 read-only audit also evaluates this health projection. Scheduled
health uses the existing read-only WIF service account for Firestore reads and the
private evidence bucket for Data Access audit events; it does not use the
Firestore audit-write runtime.

Repository Variables:

- `SHEET_EVIDENCE_MAX_AGE_MINUTES` — required before scheduled health can be evaluated.
- `SHEET_EVIDENCE_MAX_FUTURE_SKEW_SECONDS` — optional; defaults to zero when absent.

If the maximum-age variable is not configured, the source audit continues but the
Sheet health summary is explicitly recorded as `BLOCKED` with
`SHEET_EVIDENCE_MAX_AGE_MINUTES_NOT_CONFIGURED`. A normal consumer `BLOCKED`
health result is retained as operating evidence rather than causing the source
audit itself to fail. Authentication/runtime failures still fail the workflow.


Each durable record also carries an `evidenceDigest` that seals `recordedAt`,
the validated expectation and the receipt itself. After a write, the recorder
immediately re-reads the Firestore document and verifies the digest before
reporting success.

Cutover assessment also requires an explicit freshness window. There is no hidden
hard-coded business age. The operator must supply `--max-age-minutes`; optional
`--max-future-skew-seconds` allows an explicitly approved clock-skew tolerance.
Both the delivery readback time and approved release observation time must fit the
window, and future-dated evidence fails closed.

Example:

```bash
npm run assess:sheet-cutover -- \
  --consumer=google-sheets-f01 \
  --target=SHADOW_READ \
  --max-age-minutes=30 \
  --max-future-skew-seconds=30
```



### Read-only bridge preparation

The migration bridge can be prepared without any Sheet or Firestore write:

```bash
npm run prepare:sheet-bridge -- --live-read-only --workbook=ALL
# 단일 소비처만 점검할 때만 F01 또는 F86 사용
npm run prepare:sheet-bridge -- --live-read-only --workbook=F01
npm run prepare:sheet-bridge -- --live-read-only --workbook=F86
```

The job reads `products`, `policy`, and `partner` in one Firestore read-only
transaction, builds the bridge release/manifest, self-validates the handoff, and
writes only private local evidence under the user home directory. `ALL` is the
normal joint-publication preparation path: F01 and F86 share one source capture,
release, manifest and generated-at time.

Source observation time and publication time are distinct facts. Firestore
`readTime` remains in the manifest/approved release as source evidence, while
the writer-facing snapshot `capturedAt` is the handoff generation/publication
time used by the existing sheet presentation logic.


The live command requires `FREEPASS_ERP5_READ_ACCESS_TOKEN`. The existing continuous
read-only audit already obtains that token through the configured WIF read service account,
but it does **not** currently invoke `prepare:sheet-bridge`. Running the bridge command
outside an authenticated context must fail closed with `MISSING_READ_ACCESS_TOKEN` before
any network request. Do not add a Sheet writer credential to this job.

A successful preparation reports `READY_FOR_SHADOW`, never production cutover.
Required next evidence is ERP4 shadow consumption, rendered-output parity, and a
valid `freepass-sheet-delivery-v1` readback receipt.

## Runtime-derived consumer evidence

The static consumer switch registry records product/cutover intent and manually
reviewed facts. It is not itself proof that a downstream consumer actually read
FreePass Data.

`consumer-runtime-evidence-v1` overlays the append-only Data Access audit stream
without mutating the registry. A fresh successful authenticated Consumer Gateway
read may automatically prove only:

- `authenticationVerified`
- `freepassReadVerified`
- the exact approved release identity observed by that read

The audit event must contain projection ID, release ID, manifest ID, input digest
and data digest. Missing or malformed release evidence fails closed.

The overlay never infers `parityVerified`, `fallbackVerified` or
`productionReadbackVerified`. Those require their own reviewed evidence.

A newer DENIED/FAILED/incomplete runtime operation, or evidence outside the
explicit freshness window, blocks runtime promotion. White Label remains an
aggregate registry entry: one `whitelabel-*` identity can never promote the
whole White Label fleet. F01/F86 continue to use their dedicated durable Sheet
delivery evidence path.

Operational inspection:

```bash
npm run check:consumer-runtime-evidence -- \
  --max-age-minutes=30 \
  --max-future-skew-seconds=30 \
  --event-limit=1000
```

This report is read-only. It shows static evidence, observed runtime evidence,
effective evidence and the resulting next-stage decision side by side. The
event-limit bounds the audit scan; if a consumer's proof falls outside that
window it remains unobserved/fail-closed rather than being guessed from older
registry text.

## Unified Consumer Health

`consumer-health-v1` is the operator-facing rollup across every registered
FreePass Data consumer. It combines the static cutover registry with the runtime
Data Access evidence overlay and the dedicated F01/F86 durable Sheet delivery
health path.

The report covers ERP.com, the White Label aggregate, FreePass Admin, FreePass
Sales, FreePass Estimate, Kakao Ops, F01 and F86 in one JSON contract.

Status semantics:

- `HEALTHY` — the consumer is already at `FREEPASS_DATA_READ` with production
  readback evidence.
- `DEGRADED` — fresh evidence exists and the next cutover stage is currently
  allowed, but the consumer is not yet at final FreePass Data read ownership.
- `BLOCKED` — evidence is missing/stale/denied/failed, an aggregate identity is
  incomplete, the adapter is not implemented, or the next transition has blockers.

Static HOLD reasons are reported separately from runtime blockers. They are never
silently converted into runtime proof. F01/F86 continue to use their Sheet
delivery evidence; the generic Data Access log is not substituted for it.

Operational check:

```bash
npm run check:consumer-health -- \
  --max-age-minutes=30 \
  --max-future-skew-seconds=30 \
  --event-limit=1000
```

The check is read-only with respect to Canonical/consumer data and is itself
audited through the Data Access Gateway.

The 2-hour ERP5 continuous audit now runs this unified report before the dedicated
F01/F86 health detail. Scheduled mode uses the existing read-only WIF identity for
Firestore reads and the private GCS evidence bucket for the health check's own
Data Access audit event, so it does not require Firestore audit-write permission.

The scheduled top-level summary stores counts of `HEALTHY / DEGRADED / BLOCKED`
and one line per registered consumer. It reuses the explicit Sheet evidence
freshness Repository Variables as the common runtime/Sheet freshness window:

- `SHEET_EVIDENCE_MAX_AGE_MINUTES`
- `SHEET_EVIDENCE_MAX_FUTURE_SKEW_SECONDS`

If the max-age variable is absent, the source audit continues but
`consumer-health-summary.json` is recorded as `BLOCKED / NOT_CONFIGURED`.
A normal consumer-health `BLOCKED` result is evidence, not a source-audit crash;
authentication, malformed-contract, or runtime failures still fail the workflow.


