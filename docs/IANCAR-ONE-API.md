# RP031 Iancar ONE API contract

Status (2026-09-30): **PROVIDER ACCESS APPROVED / TRANSPORT CODED / ENDPOINT CONTRACT NOT YET OBSERVED / NOT DEPLOYED / NOT CUT OVER**

## Provider sharing scope

The provider notice establishes a **read-only** commercial data feed for FreePass:

- vehicle inventory and detail: availability, maker/model/grade, year/fuel/color/mileage, options;
- rate table and contract conditions: rental term and mileage-based monthly rent/deposit, insurance/deductible, driver/payment/maintenance/roadside/documents/early termination/late-payment conditions;
- inventory vehicle photos: representative and detail images from the ONE rate card.

Explicitly excluded:

- reservation or contract confirmation;
- information mutation;
- customer personal information, actual contracts/customer documents;
- internal cost, commissions, internal notes;
- GPS location and vehicle control.

The provider requires a separate API key. Live keys must remain in runtime secret storage only.

## Authority decision

Once the endpoint/auth/schema are observed and validated, **Iancar ONE API becomes the RP031 upstream authority for all fields it explicitly supplies**.
Legacy Google Sheets, the old login inventory endpoint and ERP4 DOM/rate scraping are comparison/history only. They must not silently overwrite ONE API facts.

ONE API does not become FreePass Data itself. The topology remains:

```text
Iancar ONE API (provider source)
  -> FreePass Data SourceIntake RAW + source head
  -> reviewed field mapping / Canonical Product+Offer+Policy+Photos
  -> Release
  -> ERP.com / Admin / F01 / F86 / internal AI
```

FreePass Data is the only platform allowed to normalize, retain lineage and publish the shared facts.

## Transport boundary

`src/adapters/iancar-one-api.ts` intentionally requires all of these runtime settings:

- `EANCAR_ONE_API_BASE_URL`
- `EANCAR_ONE_API_KEY`
- `EANCAR_ONE_API_AUTH_HEADER`
- optional `EANCAR_ONE_API_AUTH_PREFIX`
- `EANCAR_ONE_API_SNAPSHOT_PATH`

Nothing is guessed. HTTPS is mandatory, redirects are rejected, JSON is required, and the key is never placed in a URL, response, source revision, digest input, log, Git file or test fixture.

The current transport returns immutable RAW capture evidence only and sets:

- `mappingAuthorized=false`
- `canonicalWriteAuthorized=false`
- `publicationAuthorized=false`

This is deliberate. The provider notice describes business scope but does not define the machine JSON schema, Base URL, endpoint path or auth-header syntax. Those must be observed from the provider integration material or a controlled live response before mapping.

## First controlled live read

Before enabling any writer:

1. Provision a **new/rotated** read-only provider key in Data runtime secret storage. A key pasted into chat or issue text is not reused as the permanent production credential.
2. Configure the provider-documented Base URL, exact snapshot endpoint and auth header/prefix.
3. Perform one read-only capture. Record only HTTP status, capture time, response byte count, response digest, top-level field names/types and provider revision/observation timestamp when supplied.
4. Do not print raw vehicle identifiers, photos, contract conditions or the key to CI logs.
5. Build a field dictionary from the observed schema and classify every field as Inventory/identity, Offer/rate, Policy/contract condition, Photo, or Unsupported/private/excluded.
6. Verify excluded categories are absent. If the provider returns customer PII, GPS/control or internal-cost material, stop and quarantine rather than ingesting it.
7. Create a versioned mapper and tests from sanitized fixtures.
8. Compare ONE API -> Data -> F01/F86 -> ERP.com/Admin by vehicle, availability and each term/mileage price condition before cutover.

## Cutover rule

Do not mix authorities after activation.

For RP031 fields supplied by ONE API:

```text
ONE API wins
```

For a field not supplied by ONE API, another reviewed source may remain authoritative only when its field ownership is explicit. Missing ONE API fields must never be filled from a legacy source merely because a stale value exists.

A ONE API read failure or stale snapshot must HOLD publication of affected mutable facts; it must not silently fall back to ERP4/old Sheet values.

## Relationship to the previous direct-login pilot

`iancar-direct-source.ts` proved that FreePass Data could read original inventory without ERP4.
ONE API supersedes that pilot once the provider endpoint contract is verified because ONE API additionally includes rates, contract conditions and photos.

The old login transport remains only as temporary comparison evidence until ONE API live parity is proven, then should be retired rather than run in parallel.
