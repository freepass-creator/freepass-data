# FreePass Data Read Runtime — Deployment Readiness

Status: **PREPARED / NOT DEPLOYED**

This runbook prepares the authenticated read runtime for a private Cloud Run deployment.
It does not create IAM bindings, secrets, Cloud Run services, or consumer cutover by itself.

## 1. Security model

Use two independent authentication layers:

1. **Cloud Run IAM authentication**
2. **FreePass consumer token**

The calling backend should send:

- `X-Serverless-Authorization: Bearer <Google ID token>`
- `Authorization: Bearer <FreePass consumer token>`

Cloud Run officially supports `X-Serverless-Authorization` when an application already
uses the `Authorization` header for custom authorization.

References:

- https://cloud.google.com/run/docs/authenticating/service-to-service
- https://cloud.google.com/run/docs/container-contract

Do not allow anonymous Cloud Run invocation for the production read service.

## 2. Runtime service identity

Create a dedicated service account for the read runtime.

Recommended data role on project `freepasserp5`:

- `roles/datastore.viewer`

This role provides entity read/list access without entity create/update/delete permissions.

Reference:

- https://cloud.google.com/iam/docs/roles-permissions/firestore

Do **not** grant:

- `roles/datastore.user`
- Editor
- Owner
- Firebase Admin

to the runtime merely for reading.

## 3. Consumer token secret

Store `FREEPASS_DATA_CONSUMERS_JSON` in Secret Manager.

Grant the runtime service account:

- `roles/secretmanager.secretAccessor`

Prefer granting this role on the **single consumer-config secret**, not project-wide.

Reference:

- https://cloud.google.com/run/docs/configuring/services/secrets
- https://cloud.google.com/secret-manager/docs/access-control

## 4. Container contract

The Docker image:

- builds with Node.js 22
- runs compiled JavaScript, not `tsx`
- sets `HOST=0.0.0.0`
- does **not** set `PORT`
- relies on Cloud Run to inject `PORT`
- runs as the non-root `node` user
- contains runtime dependencies and contracts only

Cloud Run requires the ingress container to listen on `0.0.0.0` and on the injected
`PORT`.

## 5. Build

Example only:

```bash
gcloud builds submit \
  --tag REGION-docker.pkg.dev/PROJECT/REPOSITORY/freepass-data-read:REVISION
```

Pin the deployed image to an immutable digest or revision-specific tag.

## 6. Cloud Run service configuration

Required environment:

```text
NODE_ENV=production
FREEPASS_DATA_DRIVER=firestore
FIREBASE_PROJECT_ID=freepasserp5
```

Required secret:

```text
FREEPASS_DATA_CONSUMERS_JSON=<Secret Manager secret>
```

Do not configure `PORT`; Cloud Run injects it.

Recommended access posture:

- Require authentication
- Grant `roles/run.invoker` only to approved backend caller identities
- Do not grant `allUsers`
- Keep service identity separate from caller identities

## 7. Post-deploy smoke check

Use:

```bash
READ_RUNTIME_URL="https://..." \
READ_RUNTIME_CONSUMER_ID="erp-com" \
READ_RUNTIME_TOKEN="..." \
READ_RUNTIME_CLOUD_RUN_ID_TOKEN="..." \
npm run check:read-runtime
```

The checker:

- never prints either token
- validates the Health contract identity
- verifies HTTP/status semantics
- prints only Health metadata/summary
- exits non-zero for BLOCKED
- exits non-zero for DEGRADED unless `READ_RUNTIME_ALLOW_DEGRADED=1`

Optional catalog metadata check:

```bash
READ_RUNTIME_CHECK_CATALOG=1 npm run check:read-runtime
```

It prints release metadata and product count, not product rows.

## 8. Shadow gate before cutover

Before any ERP.com or white-label backend switches reads:

1. Existing consumer path remains live.
2. New runtime is read-only.
3. Query the same logical product set from both paths.
4. Compare IDs, release identity, counts, prices/terms and required display fields.
5. Investigate every mismatch.
6. Confirm Health is `HEALTHY` unless an explicitly accepted degraded dimension exists.
7. Verify rollback by disabling the new reader and confirming the old path still serves.
8. Only then approve one consumer at a time.

## 9. Non-goals

This deployment does not prove:

- Source freshness
- Source-to-Canonical parity
- whole-Catalog atomic snapshot
- F01/F86/Admin migration readiness
- production writer cutover

Those remain separate gates.
