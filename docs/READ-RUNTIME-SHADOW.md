# FreePass Data — Consumer Shadow Verification

Status: **PREPARED / NOT CUT OVER**

This workflow compares the existing consumer path with the new authenticated read runtime
before any consumer switches traffic.

## Principle

A successful Health response is necessary but not sufficient for cutover.

Shadow verification checks the actual consumer catalog contract while keeping the old path
live and authoritative.

## Comparator

Run:

```bash
SHADOW_OLD_URL="https://old.example/catalog" \
SHADOW_NEW_URL="https://new.example/v1/consumers/erp-com/catalog" \
SHADOW_OLD_AUTHORIZATION="Bearer ..." \
SHADOW_NEW_AUTHORIZATION="Bearer ..." \
npm run check:catalog-shadow
```

For a private Cloud Run target you may also supply:

```text
SHADOW_NEW_SERVERLESS_AUTHORIZATION=Bearer <Google ID token>
```

The comparator accepts either:

- a JSON array
- an object with a `data` array

Both sides must expose the ERP public product contract with unique `productId`.

## What is compared

Content parity is order-independent for:

- product rows by `productId`
- offers by `offerId`
- price terms by `termKey`

The tool separately checks product-list sequence order.

Output contains only:

- counts
- product IDs for missing/mismatched rows
- stable digests
- parity verdict

It does **not** print price values, terms, customer data or complete product rows.

## Verdicts

- `PASS` — content and order match
- `PASS_CONTENT_ORDER_DIFF_ALLOWED` — content matches; order differs and order check was explicitly disabled
- `FAIL_CONTENT` — missing or changed products
- `FAIL_ORDER` — same content but sequence differs while order is required

Default: order differences fail.

To allow order drift for a consumer where ordering is explicitly non-contractual:

```bash
SHADOW_REQUIRE_ORDER=0 npm run check:catalog-shadow
```

## Evidence handling

Save the JSON summary as deployment evidence if required. Do not store request tokens or raw
product payloads in Git.

Recommended evidence fields:

- comparedAt
- old/new semantic digest
- old/new sequence digest
- product counts
- missing/mismatched counts
- reviewed mismatch IDs
- reviewer
- final disposition

## Cutover gate

For one consumer at a time:

1. New runtime Health is HEALTHY, or an explicitly approved DEGRADED dimension is documented.
2. Shadow comparator passes.
3. Required UI/API contract fields are spot-checked on representative products.
4. Existing path remains available.
5. Caller identity and consumer token rotation/rollback are tested.
6. Switch only that consumer.
7. Re-run Health + catalog smoke after switch.
8. Keep rollback path until post-cutover monitoring is accepted.

## Rollback trigger

Rollback immediately if any of the following appears after cutover:

- Health becomes BLOCKED
- catalog route returns 401/403/503 unexpectedly
- product count drops unexpectedly
- shadow parity fails
- required product/offer/price fields disappear
- latency/error rate exceeds the agreed operating threshold

Rollback action:

1. Route the consumer back to the previous read path.
2. Do not mutate Canonical/Projection data to hide the symptom.
3. Preserve the failing Health/shadow summaries.
4. Diagnose source, Canonical, release, IAM or transport separately.
5. Re-enter shadow validation before attempting another cutover.
