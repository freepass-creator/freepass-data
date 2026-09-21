# Catalog Writer Ownership Transfer

Status: **IMPLEMENTED BASELINE / NOT PRODUCTION-CUTOVER**

This contract separates the **business actor** from the **execution writer**.

- `actor`: the user/service whose intent caused the command.
- `writer`: the service that actually executes the Catalog persistence mutation.

A user may operate through FreePass Admin while the execution writer remains `service:freepass-data`.

## Baseline states

### Pre-transfer compatibility

When no persisted ownership document exists, Catalog uses the compatibility baseline:

```text
mode = SHARED_MIGRATION
allowed writers =
  service:freepass-data
  service:freepass-admin
revision = 0
```

This preserves existing non-production behavior while migration is prepared.

### After transfer

The controlled transfer command writes:

```text
scope = catalog
mode = EXCLUSIVE
primaryWriterId = service:freepass-data
allowedWriterIds = [service:freepass-data]
revision = previous + 1
```

`service:freepass-admin` is retained only as historical `previousWriterIds` evidence and cannot mutate Canonical Catalog data.

## Enforced write paths

Ownership is checked transactionally before idempotency receipt lookup on:

1. Candidate → Canonical commit
2. Manual Catalog Source/Entry
3. Reviewed Source Change apply
4. Offer price update

Therefore an old writer cannot replay a previously known idempotency key after ownership transfer to bypass the ownership boundary.

## Transfer safety

The baseline transfer command:

- requires `expectedRevision`
- is idempotent
- records an Audit event and transfer receipt
- currently only supports target `service:freepass-data`
- must execute through `service:freepass-data`
- accepts a USER actor or `service:freepass-data` semantic actor
- is **not exposed as a public HTTP route**

This is deliberate. Production writer cutover remains separately authorized.

## Runtime identity limitation

Current `writer` enforcement is a semantic application contract, not cryptographic IAM proof.

The public price API injects `service:freepass-data` internally and does not accept client-supplied writer metadata.

Server/service authentication and IAM remain the next security layer. Until that is implemented, this feature must not be described as production-authenticated writer identity.

## Storage

Firestore:

- `writer_ownership/catalog`
- `writer_ownership_transfer_receipts/{idempotencyKey}`

Firestore remains an adapter. Ownership meaning is owned by the FreePass Data domain contract.

## Production boundary

This implementation does **not**:

- execute the transfer against production Firebase
- modify Firebase IAM
- revoke any real service account
- expose a cutover endpoint
- alter deployment automation

Those actions require separate approval.
