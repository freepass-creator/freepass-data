# FreePass Data Estimate Writer Runtime

Status: writer persistence ACTIVE and canary-verified; broader Estimate cutover remains HOLD.

## Boundary

Estimate Quote and Share Envelope persistence runs on a private Cloud Run service separate from
`freepass-data-read`. This separation is required because Firestore IAM permissions are project-wide:
adding entity update permission to the read service would silently widen every read consumer.

The writer service uses:

- a dedicated runtime service account with `datastore.databases.get` only for transaction begin/rollback,
  plus `datastore.entities.get`, `list`, `create`, and `update`;
- a dedicated Secret Manager secret containing only the `freepass-estimate` consumer binding;
- an exact numeric secret version, never `latest`;
- private Cloud Run IAM with one Estimate Vercel caller identity;
- `FREEPASS_DATA_ESTIMATE_ARTIFACT_WRITE=off` until the authenticated canary is ready.

Firestore IAM cannot scope these permissions to a collection. Application contracts therefore remain
the final immutable-write guard. Never grant delete, `roles/datastore.user`, or the read-runtime identity
to this service.

The first ON canary proved that entity permissions alone are insufficient: Firestore rejected
`beginTransaction`. Google Cloud's Firestore IAM contract assigns that operation specifically to
`datastore.databases.get`; it does not grant database metadata read or entity deletion.

The Cloud Run service IAM has exactly two invokers: the dedicated Estimate Vercel caller and the deploy
service account used for authenticated deployment verification. The deploy identity is not an Estimate
traffic identity. No other consumer binding may be present in the writer secret.

## Deployment

Use `.github/workflows/deploy-estimate-writer-runtime.yml` from `main`. Required repository variables:

- `FREEPASS_DATA_ESTIMATE_WRITER_REGION`
- `FREEPASS_DATA_ESTIMATE_WRITER_SERVICE_NAME`
- `FREEPASS_DATA_ESTIMATE_WRITER_RUNTIME_SERVICE_ACCOUNT`
- `FREEPASS_DATA_ESTIMATE_WRITER_CONSUMERS_SECRET_NAME`
- `FREEPASS_DATA_ESTIMATE_WRITER_CONSUMERS_SECRET_VERSION`
- `FREEPASS_DATA_ESTIMATE_WRITER_IAM_ROLE`
- `FREEPASS_DATA_ESTIMATE_CALLER_SERVICE_ACCOUNT`
- read/admin service, runtime-SA, and secret-name variables used by the collision guards
- existing immutable-image and deploy-WIF variables used by the read runtime

First deploy with `write_mode=off`. Confirm exact service account, pinned secret version, no public IAM,
HTTP 403 without Cloud Run identity, and an authenticated Estimate consumer read that returns a typed
`NOT_FOUND` receipt.

## Activation and canary

Before `write_mode=on`, FreePass Estimate production must have a non-empty role or UID write selector
and its Vercel OIDC subject must be bound only to the dedicated caller service account. The ON deployment
runs `src/jobs/probe-estimate-writer-canary.ts` inside the workflow. This writer-only probe does not depend
on an ACTIVE Estimate master release. The broader Estimate cutover probe remains a separate gate and must
not hide a missing master release.

The synthetic Quote and Share Envelope are intentionally permanent immutable evidence. Their IDs are
contract-derived digests; the sealed payload carries the canary purpose through
`pricingEngineVersion=synthetic-canary/v1`, `calculationProvenance.evidence`, and `sourceRevision`.
The Share Envelope carries the purpose transitively through its sealed reference to that canary Quote.
A second identical command must return `EXISTING` with the
same `persistedAt`; readback must match both snapshot hashes. There is no delete rollback. Roll back by
redeploying `write_mode=off` and reverting Estimate traffic, while preserving canary evidence.

If any ON activation step fails after deployment, the workflow creates and verifies a new Ready revision
with `FREEPASS_DATA_ESTIMATE_ARTIFACT_WRITE=off`. A failed job must never be treated as an active writer.

`CREATE_NEW_JUSTIFIED`: the existing Estimate cutover probe requires an ACTIVE master projection and
cannot isolate persistence readiness. This probe reuses the canonical artifact contracts and digest
implementation while adding only the missing writer-runtime evidence boundary.

## 2026-09-30 activation evidence

Main `fb75539356144dabe377d1170faedd22f8fd0346`, workflow run `36592266901`, and Cloud Run
revision `freepass-data-estimate-writer-00006-76q` passed the permanent Quote and Share Envelope
canary. The live service is write `on` with 100% traffic on the exact immutable image digest recorded
in `docs/NEXT-START-HERE.md`. This proves the artifact persistence boundary only; it does not clear
the ACTIVE master or real agent/admin authentication HOLDs.
