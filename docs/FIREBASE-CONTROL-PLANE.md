# FreePass Data — Firebase Control Plane Contract

Status: **LOCKED DIRECTION / IMPLEMENTATION IN PROGRESS**

FreePass Data is the technical owner and control plane for shared FreePass Firebase data.

The goal is not to expose Firestore more conveniently. The goal is to make Firestore replaceable and governable behind stable FreePass Data contracts.

## 1. Ownership

Long-term consumer applications do not own shared Firestore collection paths.

Examples:

- FreePass Admin
- FreePass Sales
- ERP.com
- Estimate
- future partner / white-label services

They consume FreePass Data read contracts and submit permitted write commands.

Firestore remains the first persistence adapter, not the public contract.

## 2. Read path

Preferred read path:

`Canonical -> Projection -> validated ACTIVE Release -> Consumer Contract`

Consumers receive:

- schema/contract version
- release ID
- canonical/release revision evidence
- generated/activated time
- freshness/health metadata when applicable

A consumer does not infer business meaning by joining internal Firestore collections itself.

## 3. Write path

Shared-data writes use commands.

`Authenticated identity -> Authority -> Expected Revision -> Validation -> Transaction -> Revision Snapshot -> Audit -> Outbox -> Receipt`

No screen or connected application is considered successful merely because a Firestore document write returned successfully.

The command receipt is the write completion evidence.

## 4. Revision history

Every canonical create/change must eventually have a queryable entity revision snapshot.

Each revision record contains:

- entity type / entity ID
- revision
- previous revision
- full canonical snapshot at that revision
- actor
- reason
- mutation origin
- command ID
- occurred time
- source binding/run evidence when applicable

This revision ledger is append-only.

Audit events explain the change.
Revision snapshots reconstruct the state.
Lineage explains where field values came from.
Receipts prove command completion.

These are related but separate evidence types.

## 5. Direct edit

The console never exposes unrestricted Firestore JSON editing as the normal path.

Editable fields are derived from Field Authority rules.

Before saving, the console should show:

- current value
- proposed value
- current revision
- authority/owner
- validation
- affected consumers
- reason

The command requires `expectedRevision`.

A stale revision returns an explicit conflict while preserving operator input.

## 6. Direct add

"Add directly in FreePass Data" does not mean create an arbitrary Firestore document.

Manual entry is treated as a first-class controlled source/command.

The target model is:

`Manual Input -> immutable evidence -> validation -> Canonical command -> revision/audit/lineage -> Release`

Manual data therefore receives the same IDs, validation, history, lineage and consumer distribution rules as imported data.

Manual creation must not bypass Product/Offer/Vehicle identity rules.

## 7. Override vs correction vs normal change

These must remain distinct commands:

- source correction / mapping correction
- normal canonical business change
- temporary override
- workflow/status transition
- rollback candidate
- manual creation

An override includes scope, reason, actor, effective period/expiry and source-refresh behavior.

RAW source evidence is never overwritten by a canonical edit.

## 8. Connected FreePass applications

Connected applications eventually use the same FreePass Data boundary for shared Firebase data.

Read:

- versioned Projection / Release contract

Write:

- explicit command endpoint / SDK operation
- verified service identity
- Field Authority
- idempotency key
- expected revision where applicable
- command receipt

A connected app must not receive a generic "write any document path" capability.

## 9. Console responsibility

The web/mobile console is a control surface over the same contracts.

It provides:

- data explorer
- source/raw/candidate/canonical inspection
- edit/create forms generated from supported commands
- revision comparison
- lineage
- audit
- release/consumer status
- review queue

The console is not a separate data owner.

## 10. Current implementation state

Implemented:

- Firestore behind Repository/Port contracts
- Command/Revision protection for Offer price changes
- Field Authority baseline
- Canonicalization command and source binding
- append-only Audit
- command receipts
- RAW -> Normalized -> Canonical lineage baseline
- durable Outbox and Projection Release
- queryable append-only Canonical Revision History

Next:

1. Manual catalog source/command
2. more field-specific edit commands driven by Authority Registry
3. Canonical -> Projection lineage and Release manifest
4. authenticated service/user identity and IAM
5. Control Plane API/Console surfaces
6. consumer SDK/contracts and gradual removal of direct Firebase access
