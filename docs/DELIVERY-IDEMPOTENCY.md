# Projection Delivery Idempotency — Catalog V1

Status: **IMPLEMENTED BASELINE**

Catalog outbox delivery is at-least-once. FreePass Data therefore treats projection publication as idempotent.

## Rules

1. Every processed catalog outbox event gets a `ProjectionDeliveryReceipt`.
2. A retry first checks the receipt by `eventId`.
3. If the receipt already exists, the worker marks the event done without rebuilding a release.
4. ERP Public projection compares the current `inputDigest` and `dataDigest` with the ACTIVE release.
5. If both digests are unchanged, the existing ACTIVE release is reused.
6. Out-of-order older events rebuild from current Canonical state, never from the stale event payload.
7. Therefore an older event delivered after a newer one converges on the same current ACTIVE release rather than replacing it with stale data.

This also covers the failure window:

`Release ACTIVE -> delivery receipt stored -> outbox markDone fails`

The retry sees the stored delivery receipt and finishes acknowledgement without creating another release.
