# FreePass Data Admin Runtime — Activation

Status: **DEPLOY WORKFLOW READY / INFRA BOOTSTRAP REQUIRED**

## Purpose

FreePass Admin must not own Firebase/Firestore business-data credentials.
The production path is:

```text
FreePass Admin (Vercel)
  -> private FreePass Data Admin runtime (Cloud Run)
  -> Data Access Gateway
  -> Admin workflow persistence adapter
  -> freepasserp5 Firestore
```

Admin business semantics remain in `freepass-admin`. FreePass Data owns the Firebase credential,
physical collection layout, access audit, transaction execution and idempotency receipt.

## Runtime separation

Do not give the shared ERP/White Label read runtime write IAM.

Use a dedicated Admin runtime:

- service: `FREEPASS_DATA_ADMIN_SERVICE_NAME`
- runtime identity: `FREEPASS_DATA_ADMIN_RUNTIME_SERVICE_ACCOUNT`
- consumer secret: `FREEPASS_DATA_ADMIN_CONSUMERS_SECRET_NAME`
- initial write state: `FREEPASS_DATA_ADMIN_WORKFLOW_WRITE=off`

The consumer secret must register `freepass-admin-catalog` with:

- `catalog`
- `admin-workflow`

capabilities and a distinct 32+ character token.

## One-time GCP bootstrap

A project administrator must first enable:

- `run.googleapis.com`
- `artifactregistry.googleapis.com`
- `iamcredentials.googleapis.com`
- `sts.googleapis.com`
- `secretmanager.googleapis.com`

Create:

1. Artifact Registry repository.
2. Admin runtime service account.
3. Deploy service account + GitHub WIF binding.
4. Admin consumer Secret Manager secret.
5. Vercel caller service account.
6. Vercel OIDC -> GCP Workload Identity provider.

The Admin runtime service account requires only the Firestore/secret permissions necessary for
the Admin workflow gateway. Do not copy a service-account JSON into Vercel.

## Repository variables

- `FREEPASS_DATA_DEPLOY_WIF_PROVIDER`
- `FREEPASS_DATA_DEPLOY_SERVICE_ACCOUNT`
- `FREEPASS_DATA_ARTIFACT_REPOSITORY`
- `FREEPASS_DATA_ADMIN_REGION`
- `FREEPASS_DATA_ADMIN_SERVICE_NAME`
- `FREEPASS_DATA_ADMIN_RUNTIME_SERVICE_ACCOUNT`
- `FREEPASS_DATA_ADMIN_CONSUMERS_SECRET_NAME`

## Deployment

Run the manual GitHub workflow:

`Deploy FreePass Data Admin runtime`

The workflow deliberately deploys with writes OFF.

After deployment record:

- Cloud Run URL
- Ready state
- immutable image SHA
- caller WIF audience
- caller service-account email

No token value is written to a document, PR or log.

## Admin handoff

FreePass Admin production receives:

- `FREEPASS_DATA_BASE_URL=<Admin Cloud Run URL>`
- `FREEPASS_DATA_ADMIN_CATALOG_TOKEN=<consumer token>`
- `FREEPASS_DATA_GCP_WIF_AUDIENCE=<provider audience>`
- `FREEPASS_DATA_GCP_CALLER_SERVICE_ACCOUNT_EMAIL=<caller SA>`
- `ERP5_WRITE=off`
- `FREEPASS_DATA_ADMIN_WORKFLOW_WRITE=off`

The Admin caller exchanges Vercel's short `VERCEL_OIDC_TOKEN` through Google STS and IAM Credentials,
then sends the resulting ID token as `X-Serverless-Authorization`. The application-level
FreePass consumer token remains in `Authorization`.

## Read acceptance

Before any write activation verify:

1. Cloud Run `/health` is reachable with private IAM.
2. Admin catalog compatibility read succeeds.
3. Admin workflow read succeeds for a designated non-customer record/query.
4. `/system/data-status` reports `authority=FREEPASS_DATA` and the Data transport as healthy.
5. No `ERP5_FIREBASE_SERVICE_ACCOUNT_JSON` or `ERP5_SERVICE_ACCOUNT_PATH` exists in Admin production.
6. Rollback is available by reverting the Admin deployment.

## Write activation

Writes require both sides to be explicitly enabled:

- FreePass Admin: `ERP5_WRITE=on` and `FREEPASS_DATA_ADMIN_WORKFLOW_WRITE=on`
- FreePass Data Admin runtime: `FREEPASS_DATA_ADMIN_WORKFLOW_WRITE=on`

Before enabling the Data-side gate, verify least-privilege IAM and backup/restore evidence in the
FreePass Data control plane.

Acceptance uses one designated non-customer record:

`write -> reload -> retry same operationId -> exactly one committed result`

Also verify a stale read digest causes conflict rather than overwriting newer data.

## Current blocker

As of 2026-09-27, live rehearsal proved the real `freepasserp5` read path, but persistent Cloud Run
deployment remains blocked by project-level API/IAM bootstrap. Existing GitHub audit identities cannot
enable the required APIs.

Therefore source integration may proceed, but FreePass Admin production must not cut over to the Data-only
workflow transport until this runtime is actually deployed and readback passes.
