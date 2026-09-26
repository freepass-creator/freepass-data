# Vehicle Master: New-car / Used-car Boundary

Status: **ARCHITECTURE LOCKED / SELECTOR FUNCTION IMPLEMENTED**  
Date: 2026-09-26

## Decision

FreePass Data has **one canonical Vehicle Master identity graph**.

```
MAKE
 -> MODEL
 -> GENERATION
 -> PHASE
 -> MODEL_YEAR
 -> POWERTRAIN
 -> VARIANT (seats / drivetrain)
 -> TRIM
 -> BASE_ITEM / OPTION / PACKAGE / COLOR
```

New-car Master and Used-car Master are not independent duplicate databases.
They are projections over the same canonical IDs.

## New-car Master

Projection: `estimate-newcar-master`

Purpose:
- current new-car quotation
- current MSRP
- selectable options/packages/colors
- requires/excludes/exclusive-group rules
- current configuration axes
- immutable Quote provenance

Authority:
- manufacturer official data first
- reviewed structured providers may corroborate
- ACTIVE requires complete stable identity and current evidence

New-car Master answers:
**"What can be configured and quoted as a new car now?"**

It does not own historical used-market prices or physical used vehicles.

## Used-car Master

Projection: `usedcar-master`

Purpose:
- identify historical vehicles
- resolve generation / facelift / model year / powertrain / trim
- retain original MSRP history and historical option/spec evidence
- support partial-information lookup

Used-car search is **non-linear**.
The caller does not have to know model year, trim, or a prescribed sequence.
Any known information can narrow candidates.

Examples:
- `쏘렌토`
- `쏘렌토 하이브리드`
- `2021 쏘렌토`
- `쏘렌토 노블레스`
- maker + model only
- model + drivetrain only

More information improves resolution; missing information does not make the vehicle unsearchable.

Used-car Master answers:
**"What vehicle configuration did this historical car most likely belong to?"**

## What is NOT Used-car Master

The following are physical-asset or listing facts and must not mutate Vehicle Master:

- VIN
- plate number
- first registration date
- odometer
- accident/repair history
- ownership history
- actual exterior/interior condition
- installed aftermarket equipment
- current listing price
- transaction price
- seller/dealer
- stock status

Those belong to `VehicleAsset`, listing, product, offer, or market-observation domains.

A used listing can reference Vehicle Master, but cannot become authority for canonical
generation/model-year/trim solely because a seller wrote a label.

## Price boundary

Three prices are different facts:

1. **Original MSRP / option price**
   - Vehicle Master evidence
   - effective-dated
   - historical facts retained

2. **Current new-car commercial price**
   - Product / Offer / Estimate domain

3. **Used market/listing/transaction price**
   - Market observation / Listing / Asset domain

They must never share one field called simply `price`.

## Source policy

### New-car
Priority:
1. manufacturer official
2. public certified source
3. reviewed structured provider

### Used-car historical recovery
Priority:
1. archived manufacturer price/spec documents
2. manufacturer historical pages
3. two or more independent structured historical sources
4. reviewed providers such as Carnoon / Carisyou / WikiCar
5. market listings only as weak discovery evidence

Market listings may suggest a candidate but do not independently promote a canonical trim.

## Lifecycle

Canonical node status is independent of projection use:

- `ACTIVE`: current canonical configuration
- `HISTORICAL`: historical configuration still valid for identification
- `DISCONTINUED`: no longer produced, retained for history
- `HOLD`: evidence or identity unresolved

Used-car Master includes CURRENT, HISTORICAL, DISCONTINUED and HOLD records.
HOLD records are searchable but cannot be treated as resolved identity.

## Identity vs Asset

```
Vehicle Master identity
       |
       | resolved by stable IDs
       v
VehicleAsset (one physical car)
       |
       +-- VIN
       +-- registration
       +-- mileage
       +-- accidents
       +-- current condition
       |
       v
Product / Listing / Offer
```

This preserves one vehicle taxonomy while allowing new-car and used-car workflows to evolve independently.


## Shared selector projection boundary

New-car and used-car masters share one selector semantics, but their grouping
identity differs because the projections expose different stable identity depth.

### New-car selector grouping

`estimate-newcar-master` exposes stable `vehicleModelId`,
`modelYearId`, `powertrainId` and `trimId`, but does not currently expose
generation/phase IDs.

Therefore NEW_CAR grouping is by stable `vehicleModelId` only.

It is invalid to invent a generation ID merely to satisfy a grouping UI.

### Used-car selector grouping

`usedcar-master` exposes the historical identity chain including
`generationId` and `phaseId`.

Therefore USED_CAR grouping is by:

`vehicleModelId + generationId`

A missing generation remains unresolved and must not be merged into a synthetic
model-generation group.

### Consumer rule

Both projections must enter the same selector engine through the approved master
adapters/entrypoints. A consumer must not create a second search hierarchy or
reinterpret missing IDs locally.
