# FreePass Admin Catalog consumer contract — current-main port

Status: **CODED ON DRAFT PR #53 / CUTOVER HOLD**

## Ownership

- Catalog authority: **FreePass Data**
- Consumer: **FreePass Admin**
- Consumer identity: `freepass-admin-catalog`
- Projection: `admin-catalog`
- Admin switch key: `FREEPASS_DATA_ADMIN_CATALOG_READ_MODE`
- Current switch stage: **OBSERVE**
- Admin application/contract/settlement workflow ownership is not moved into FreePass Data.

The old PR #12 is design provenance only. It is far behind current main and must not be merged wholesale.
PR #53 ports the Admin-specific contract onto the current release manifest, digest and field-lineage integrity model.

## Contract guarantees prepared by PR #53

The Admin Catalog projection preserves:

- Product ID / revision / updatedAt / commercial type
- VehicleModel identity plus maker/model/generation/subModel/trim/fuel/drive/seats when Canonical has them
- VehicleAsset ID/status/plate/VIN/odometer when Canonical has them
- **supplier identity per Offer**
- Offer ID / revision
- all PriceTerms, including explicit `KNOWN / ZERO / UNKNOWN / NOT_APPLICABLE` deposit semantics
- mileage limit when known
- typed Policy values
- explicit Policy state `COMPLETE / MISSING / INVALID`
- invalid policy fact references instead of coercing known numeric/bool facts
- release ID, manifest ID, canonical input digest and payload digest
- `CANONICAL_ACTIVE` authority marker
- Admin response-level `policyParity`

The gateway binds `freepass-admin-catalog` only to `admin-catalog`. ERP.com or white-label credentials cannot be used for the Admin projection, and the Admin identity cannot select `erp-public`.

## Current Admin UI parity matrix

| Admin fact | Admin contract now | Current parity |
|---|---|---|
| product identity/revision | yes | contract-ready |
| vehicle maker/model/generation/subModel/trim | yes when Canonical exists | contract-ready |
| plate/VIN/odometer | yes when Canonical exists | contract-ready |
| supplier identity | **per Offer** | contract-ready; Admin local model must preserve Offer supplier |
| term/monthly rent/deposit/mileage | yes | contract-ready |
| unknown deposit vs zero | yes, explicit | contract-ready |
| typed policy facts | yes | contract-ready; policy parity may still be incomplete |
| supplier display name | no Canonical fact today | **HOLD** |
| operational Korean vehicle status such as 즉시출고/출고협의 | Canonical asset/product state is not the same display contract | **HOLD** |
| photos / source photo links | no Canonical fact today | **HOLD** |
| consumer vehicle price | no Canonical fact today | **HOLD** |
| vehicle class | no Canonical fact today | **HOLD** |
| credit/perk presentation badges | not a Canonical presentation fact | **HOLD / consumer mapping decision** |
| legacy status reason / source URL / first-seen metadata | no Admin contract fact today | **HOLD** |
| first registration date / model year / displacement / battery size | not in current Catalog V1 Canonical model | **HOLD** |

A schema-valid Admin response therefore does **not** prove full current-screen parity.

## Why supplier is Offer-level

FreePass Data can legally contain multiple supplier Offers under one Product.
Collapsing supplier to a Product field would merge distinct commercial offers and could create a false contract condition.

The FreePass Admin consumer must therefore select and snapshot the supplier from the chosen Offer.
Product-level supplier fields may exist only as migration/display compatibility when every Offer has the same supplier.

## Activation discipline

### OBSERVE
- existing Admin legacy result remains authoritative for user-visible output
- confirm connection/configuration only

### SHADOW_READ
- independently read legacy and Admin Catalog release
- compare same scope and revision evidence
- **return legacy result**
- Data timeout/failure/mismatch becomes explicit HOLD evidence, not silent success

### PARITY_VERIFIED
Requires a revision-scoped parity receipt proving at least:
- same intended inventory scope
- Product/Offer identity mapping
- supplier-per-Offer preservation
- term/rent/deposit/mileage parity
- required policy parity
- required Admin presentation facts are either supplied or explicitly accepted as consumer-derived/optional

### FREEPASS_DATA_READ
Blocked until central cutover evidence is complete:
- contractReady
- authenticationVerified
- legacyReadVerified
- freepassReadVerified
- parityVerified
- fallbackVerified
- productionReadbackVerified
- no holdReasons

## Current non-authorization

PR #53 does not:
- build or activate a production Admin release
- write Canonical data
- deploy the consumer gateway
- mutate IAM
- create a consumer token
- switch FreePass Admin beyond OBSERVE
- authorize `FREEPASS_DATA_READ`

Execution status remains separate from code status. This draft is not production cutover evidence.
