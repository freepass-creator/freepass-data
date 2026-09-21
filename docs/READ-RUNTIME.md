# FreePass Data — Authenticated Read Runtime

Status: IMPLEMENTED / VALIDATION REQUIRED BEFORE DEPLOYMENT

## Purpose

Expose the proven ERP public projection and Catalog Data Health through a dedicated
read-only backend without exposing raw Firestore topology or Catalog write commands.

## Runtime

Start:

```bash
FREEPASS_DATA_DRIVER=firestore \
FIREBASE_PROJECT_ID=freepasserp5 \
FREEPASS_DATA_CONSUMERS_JSON='[...]' \
npm run serve:consumers
```

The runtime rejects:
- memory mode
- non-`freepasserp5` projects
- Firestore emulator mode
- unregistered consumers
- invalid/shared service tokens

It does not seed data, publish releases, run workers, or expose Catalog mutation routes.

## Consumer capabilities

Registration fields:

- `id`: `erp-com` or `whitelabel-<slug>`
- `projectionId`: currently only `erp-public`
- `token`: unique backend token, minimum 32 characters
- `capabilities`: optional

Capability rules:

- omitted `capabilities` => `["catalog"]`
- `catalog` => ERP public projection read
- `catalog-health` => Catalog Data Health read
- health-only registration is allowed and does not grant catalog payload access

## Routes

### Catalog

`GET /v1/consumers/{consumerId}/catalog`

- 401 unauthenticated
- 403 authenticated but missing `catalog`
- 503 no trustworthy ACTIVE release
- 200 validated ERP public projection

### Catalog Data Health

`GET /v1/consumers/{consumerId}/catalog-health`

- 401 unauthenticated
- 403 authenticated but missing `catalog-health`
- 503 reader failure / schema failure
- 200 HEALTHY
- 200 DEGRADED
- 503 BLOCKED with the versioned Health report body

Both responses use `Cache-Control: no-store`.

## Storage boundary

The consumer projection reader exposes only projection reads.
The Data Health reader exposes only:

- VehicleModel / VehicleAsset / Product / Offer / Policy lists
- Revision History
- ACTIVE release / manifest / projection lineage
- atomic ACTIVE projection evidence snapshot

The Health reader exposes no `stage`, `activate`, `transact`, `put*`, or other write surface.

## Still required before live use

1. Merge/finalize Catalog Data Health baseline.
2. Run full integrated test suite on the clean runtime branch.
3. Run Firestore emulator integration tests.
4. Provision a read-only service identity/IAM policy for the deployed service.
5. Deploy the read runtime behind TLS/private service access.
6. Shadow-read against current consumer output and compare release identity/data.
7. Keep existing consumer path as rollback until shadow parity is accepted.

This runtime is not a consumer cutover authorization and does not prove Source freshness,
Source-to-Canonical parity, or a whole-Catalog atomic snapshot.
