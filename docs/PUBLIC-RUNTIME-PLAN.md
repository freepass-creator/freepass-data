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
    "publicEntrypointUses": "createFirestoreCatalogCompatibilityReader(undefined, undefined, { readCollections: ['products', 'policy'] })",
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
        "gate": "plan digest and exact target preflight before authentication/build/deploy; private deploy then explicit grant_public_invoker=true"
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
  ],
  "scopeBoundaries": {
    "A_publicRuntime": {
      "purpose": "public feed/quote DTO only, not a consumer cutover",
      "contract": "contracts/public-product-feed-v1.schema.json",
      "privateCollectionsNotRead": [
        "partner",
        "user",
        "vehicle_master"
      ],
      "secrets": [],
      "sourceScopeExpansion": false,
      "mediaBytesAndManifest": "HOLD: no supplier credentials or public photo proxy approved",
      "whitelabelCutover": "HOLD: current approved channel registry and equivalent fence must be verified"
    },
    "B_sourceAggregateRead": {
      "includedInThisDeployment": false,
      "purpose": "separate existing-authority count-only observation",
      "browserCollectedPayload": false,
      "sourceHoldResolution": false,
      "canonicalCutover": false,
      "approval": "separate exact caller/sourceScope and sanitized counts/observation evidence; does not authorize source inventory publication"
    }
  }
}
```

## Notes

- The public service uses `src/api/public-server.ts`, which registers only `/health`, `/v1/public/catalog/feed`, and `/v1/public/catalog/quote`; the not-found handler returns 404 for every other path.
- Code evidence for Firestore scope is `createFirestoreCatalogCompatibilityReader(undefined, undefined, { readCollections: ['products', 'policy'] })`, then `read()` in `src/infra/erp5-compat-catalog-reader.ts`; the public feed/quote path reads `products` and `policy` only. It does not call Iancar photo code because no photo reader or `EANCAR_ONE_API_KEY` is provided.
- `FREEPASS_DATA_CONSUMERS_JSON` is intentionally absent from the public service. Consumer gateway, admin, settlement, estimate, and command routes are not registered.
- `deploy-public-runtime.yml` calls `deploy-read-runtime.yml` with different inputs instead of copying the deployment workflow. `grant_public_invoker` defaults to false.
- Public approval preflight binds project, region, service, runtime service account, entrypoint and secret-free mode before any deploy authentication, image publication or Cloud Run change. Every deployment uses `--no-allow-unauthenticated`; only the separately guarded IAM step can grant allUsers. The public service does not receive the F04 sheet environment or consumer/Iancar secrets.
- Rollback is IAM removal and service deletion only; no data rollback is expected because the runtime has no write path.

Digest command:

```powershell
npm.cmd run build
node scripts/public-runtime-plan-digest.mjs docs/PUBLIC-RUNTIME-PLAN.md --service freepass-data-public --service-account freepass-data-public-runtime@freepasserp5.iam.gserviceaccount.com --entrypoint dist/src/api/public-server.js --use-consumer-secrets false --max-instances 4 --runtime-concurrency 16
```

Plan digest sha256: `9b867764c02847a861dcfeb12200ffc0aa7920cd0dc3c4b35b99fa84e52f1303`

## Reviewable scope and remaining evidence

A is the public-only runtime candidate and its narrowly scoped service-account/deployer/invoker changes. It reuses the existing feed/quote allowlist schema. Public deploy arguments pin 4 instances, concurrency 16, timeout 30 seconds, CPU 1 and 512Mi. Approval for A does not approve B or any consumer/whitelabel switch. No new source writer, COLLECTED browser payload, source inventory publication, Canonical activation, consumer registration or supplier secret is included.

B is a separate count-only observation request using existing authorized source/consumer scopes. Its caller, identifiers, observed time, total/public/HOLD/excluded definitions and evidence access must be settled before execution. Missing evidence is HOLD, not zero. This plan neither resolves RAW/candidate HOLDs nor enables a collected-reference grant.

Before any operational execution, pin the final candidate commit, image digest, current approved plan digest and exact service account; confirm the public field allowlist, current channel fence and URL contract with API/ERP owners. Current main integration and local tests do not prove deployment, source freshness, completeness or Data-to-ERP runtime traversal. The public server has no supplier-backed photo byte/manifest route and whitelabel equivalence is not assumed from historical cutover records.

After separately authorized deployment, verify service revision/image/traffic/secret absence/private-route 404s, anonymous feed and quote schema/privacy, deposit states and nullable evidence, supplier filters, image URL preservation and each approved channel fence. Compare the same observed snapshot with ERP5; retain lack of freshness/coverage evidence explicitly. HTTP200/health alone is insufficient. Rollback is revoking public invoker and retiring this isolated service; the existing private read service and source data remain owned by their existing runtimes.

Public replacement readiness remains HOLD: the existing privacy text filter rejects some numeric/currency/percent display strings, type/status enum conversion and policy-field coverage differ from ERP output, and no full observed public-DTO fixture/deepEqual proves the 475-product/4438-price-row snapshot. Standalone request rate limits, the current approved whitelabel registry and photo byte/manifest delivery also remain unverified. Local compatibility tests do not authorize an ERP origin switch.
