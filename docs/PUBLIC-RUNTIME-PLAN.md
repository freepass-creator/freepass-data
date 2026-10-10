# Public Runtime Plan

Status: CODED, not deployed. No IAM, Cloud Run, Secret Manager, or production command was run for this plan.

```json public-runtime-plan
{
  "schema": "freepass-data-public-runtime-plan/v1",
  "service": {
    "name": "freepass-data-public",
    "region": "asia-northeast3",
    "projectId": "freepasserp5",
    "entrypoint": "dist/src/api/public-server.js",
    "serviceAccount": "freepass-data-public-runtime@freepasserp5.iam.gserviceaccount.com"
  },
  "runtimeLimits": {
    "maxInstances": 4,
    "concurrency": 16,
    "timeoutSeconds": 30,
    "cpu": "1",
    "memory": "512Mi"
  },
  "environment": {
    "plain": {
      "NODE_ENV": "production",
      "FREEPASS_DATA_DRIVER": "firestore",
      "FIREBASE_PROJECT_ID": "freepasserp5",
      "HOST": "0.0.0.0",
      "FREEPASS_DATA_ENTRYPOINT": "dist/src/api/public-server.js",
      "FREEPASS_PUBLIC_PROVIDER_ALLOWLIST": "optional comma-separated provider codes",
      "FREEPASS_PUBLIC_TRUST_PROXY_HOPS": "optional 0..3"
    },
    "secrets": []
  },
  "routes": {
    "registered": [
      "GET /health",
      "GET /v1/public/catalog/feed",
      "GET /v1/public/catalog/quote"
    ],
    "notRegistered": [
      "/v1/consumers/{consumerId}/catalog",
      "/v1/consumers/{consumerId}/catalog-compat",
      "/v1/consumers/{consumerId}/admin-workflow/*",
      "/v1/consumers/{consumerId}/settlement-ledger",
      "/v1/commands/*"
    ]
  },
  "firestoreReadScopeByCode": {
    "reader": "src/infra/erp5-compat-catalog-reader.ts",
    "publicEntrypointUses": "createFirestoreCatalogCompatibilityReader(undefined, { readCollections: ['products', 'policy'] })",
    "collections": [
      "products",
      "policy"
    ],
    "writeCollections": []
  },
  "iamChanges": {
    "runtimeServiceAccount": [
      {
        "member": "serviceAccount:freepass-data-public-runtime@freepasserp5.iam.gserviceaccount.com",
        "role": "Firestore read-only role only",
        "reason": "read products and policy through the compatibility reader for public feed/quote"
      }
    ],
    "deployerAdditionalPermissions": [
      "run.services.get",
      "run.services.create",
      "run.services.update",
      "run.services.getIamPolicy",
      "run.services.setIamPolicy only for service freepass-data-public and role roles/run.invoker",
      "iam.serviceAccounts.actAs on freepass-data-public-runtime@freepasserp5.iam.gserviceaccount.com",
      "artifactregistry.repositories.uploadArtifacts/read on the existing FreePass Data Artifact Registry repository"
    ],
    "publicInvoker": [
      {
        "member": "allUsers",
        "role": "roles/run.invoker",
        "resource": "Cloud Run service freepass-data-public",
        "gate": "workflow input grant_public_invoker=true after environment protection"
      }
    ],
    "noChange": [
      "freepass-data-read invoker IAM",
      "consumer tokens secret",
      "Iancar secret",
      "Firestore data"
    ]
  },
  "rollback": [
    "Remove roles/run.invoker binding for allUsers from Cloud Run service freepass-data-public",
    "Delete Cloud Run service freepass-data-public",
    "Remove Firestore read-only role from serviceAccount:freepass-data-public-runtime@freepasserp5.iam.gserviceaccount.com if no longer used",
    "Keep freepass-data-read unchanged"
  ]
}
```

## Notes

- The public service uses `src/api/public-server.ts`, which registers only `/health`, `/v1/public/catalog/feed`, and `/v1/public/catalog/quote`; the not-found handler returns 404 for every other path.
- Code evidence for Firestore scope is `createFirestoreCatalogCompatibilityReader(undefined, { readCollections: ['products', 'policy'] })`, then `read()` in `src/infra/erp5-compat-catalog-reader.ts`; the public feed/quote path reads `products` and `policy` only. It does not call Iancar photo code because no photo reader or `EANCAR_ONE_API_KEY` is provided.
- `FREEPASS_DATA_CONSUMERS_JSON` is intentionally absent from the public service. Consumer gateway, admin, settlement, estimate, and command routes are not registered.
- `deploy-public-runtime.yml` calls `deploy-read-runtime.yml` with different inputs instead of copying the deployment workflow. `grant_public_invoker` defaults to false.
- Rollback is IAM removal and service deletion only; no data rollback is expected because the runtime has no write path.

Digest command:

```powershell
npm.cmd run build
node scripts/public-runtime-plan-digest.mjs docs/PUBLIC-RUNTIME-PLAN.md
```

Plan digest sha256: `7f3d6f44442dd3f313f8afe282d324800c10c9c1663e3099cad1e444dab8a96b`
