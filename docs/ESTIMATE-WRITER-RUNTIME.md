# FreePass Data Estimate Writer Runtime

Status: deployment-ready; activation requires the authenticated canary gate below.

## Boundary

Estimate Quote and Share Envelope persistence runs on a private Cloud Run service separate from
`freepass-data-read`. This separation is required because Firestore IAM permissions are project-wide:
adding entity update permission to the read service would silently widen every read consumer.

The writer service uses:

- a dedicated runtime service account with only `datastore.entities.get`, `list`, `create`, and `update`;
- a dedicated Secret Manager secret containing only the `freepass-estimate` consumer binding;
- an exact numeric secret version, never `latest`;
- private Cloud Run IAM with one Estimate Vercel caller identity;
- `FREEPASS_DATA_ESTIMATE_ARTIFACT_WRITE=off` until the authenticated canary is ready.

Firestore IAM cannot scope these permissions to a collection. Application contracts therefore remain
the final immutable-write guard. Never grant delete, `roles/datastore.user`, or the read-runtime identity
to this service.

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
and its Vercel OIDC subject must be bound only to the dedicated caller service account. After activation,
run `apps/new/scripts/probe-freepass-data-cutover.mjs` from the matching Estimate main revision.

The synthetic Quote and Share Envelope are intentionally permanent immutable evidence. Their IDs and
sealed payload must carry the canary purpose. A second identical command must return `EXISTING` with the
same `persistedAt`; readback must match both snapshot hashes. There is no delete rollback. Roll back by
redeploying `write_mode=off` and reverting Estimate traffic, while preserving canary evidence.
