# Vehicle Finder read-model boundary

Status: U-01 presentation adapter; storage/provider remains I-01.

## Purpose

`src/application/vehicle-finder-read-model.ts` is the single adapter from the real
F-01 Vehicle Selector result to `freepass.vehicle-finder.ui/v1`.

It does not implement search, ranking, candidate action, reconciliation, lifecycle,
or master normalization. Those remain owned by F/E.

## Injected I boundary

The adapter requires only:

```ts
loadRecords(mode)
loadObservation(mode)
```

I-01 supplies those functions from the authorized master/projection source.
U-01 has no Firestore path, VehicleMasterStore construction, source fetch, or persistence
logic.

## Flow

```
I master/projection
  -> VehicleSelectorRecord[]
  -> F selectVehicles()
  -> U buildVehicleFinderReadModel()
  -> freepass.vehicle-finder.ui/v1
  -> Vehicle Finder view
```

Facet keys are opaque `vf1.*` tokens. U sends them back unchanged. The read adapter
validates and converts them to the corresponding selector selection; malformed or
cross-axis tokens fail closed.

Facet ordering and hidden/reveal behavior consume `VEHICLE_SELECTOR_UX_PRESETS`
directly. U does not copy the F ordering table.

Observation time, coverage, evidence, source labels, freshness and confidence are
I-supplied metadata. Missing metadata stays missing; the adapter never invents it.

## Remaining integration dependency

The local Console runtime currently creates Catalog stores only. It does not expose an
authorized VehicleMasterStore/master projection provider through `createRuntimeStores()`.
Therefore the production/local actual route remains disconnected by default until I-01
provides `loadRecords/loadObservation`. This is intentional fail-closed behavior.
