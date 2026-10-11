#!/usr/bin/env bash
# Existing private service metadata only. No deploy, IAM mutation or source collection.
set -euo pipefail
check() {
  local predicate="$1"
  shift
  if "$@"; then echo "VERIFY_${predicate}=PASS" >&2; else echo "VERIFY_${predicate}=FAIL" >&2; exit 1; fi
}
check MAIN_REF test "$GITHUB_REF" = refs/heads/main
check SOURCE_FORMAT bash -c '[[ "$1" =~ ^[a-f0-9]{40}$ ]]' _ "$EXPECTED_SOURCE_SHA"
check DIGEST_FORMAT bash -c '[[ "$1" =~ ^sha256:[a-f0-9]{64}$ ]]' _ "$EXPECTED_IMAGE_DIGEST"
check REVISION_FORMAT bash -c '[[ "$1" =~ ^freepass-data-read-[0-9]{5}-[a-z0-9]+$ ]]' _ "$EXPECTED_REVISION"
check TARGET test "$PROJECT_ID/$REGION/$SERVICE_NAME" = freepasserp5/asia-northeast3/freepass-data-read
check RUNTIME_ACCOUNT test "$RUNTIME_SERVICE_ACCOUNT" = freepass-data-read-runtime@freepasserp5.iam.gserviceaccount.com
check CONSUMER_PIN test "$CONSUMERS_SECRET_NAME:$CONSUMERS_SECRET_VERSION" = freepass-data-consumers:4
check ONE_PIN test "$IANCAR_SECRET_NAME:$IANCAR_SECRET_VERSION" = freepass-data-iancar-one-api:1
if [ "${VERIFY_PREFLIGHT_ONLY:-false}" = true ]; then exit 0; fi
service_json="$(gcloud run services describe "$SERVICE_NAME" --project="$PROJECT_ID" --region="$REGION" --format=json)"
check READY jq -e '.status.conditions | any(.type == "Ready" and .status == "True")' <<<"$service_json" >/dev/null
check LATEST jq -e --arg revision "$EXPECTED_REVISION" '.status.latestReadyRevisionName == $revision and .status.latestCreatedRevisionName == $revision' <<<"$service_json" >/dev/null
check TRAFFIC jq -e --arg revision "$EXPECTED_REVISION" '.status.traffic | length == 1 and .[0].revisionName == $revision and .[0].percent == 100' <<<"$service_json" >/dev/null
revision_json="$(gcloud run revisions describe "$EXPECTED_REVISION" --project="$PROJECT_ID" --region="$REGION" --format=json)"
check REVISION_READY jq -e '.status.conditions | any(.type == "Ready" and .status == "True")' <<<"$revision_json" >/dev/null
for metadata in "$service_json" "$revision_json"; do
  if jq -e '.spec.template != null' <<<"$metadata" >/dev/null; then spec="$(jq -c '.spec.template.spec' <<<"$metadata")"; else spec="$(jq -c '.spec' <<<"$metadata")"; fi
  check SERVICE_ACCOUNT jq -e --arg account "$RUNTIME_SERVICE_ACCOUNT" '.serviceAccountName == $account' <<<"$spec" >/dev/null
  check CONCURRENCY jq -e '.containerConcurrency == 8' <<<"$spec" >/dev/null
  check ENV_BINDING jq -e '[.containers[0].env[]? | select(.name == "NODE_ENV" or .name == "FREEPASS_DATA_DRIVER" or .name == "FIREBASE_PROJECT_ID") | {name,value}] | sort_by(.name) == ([{name:"NODE_ENV",value:"production"},{name:"FREEPASS_DATA_DRIVER",value:"firestore"},{name:"FIREBASE_PROJECT_ID",value:"freepasserp5"}] | sort_by(.name))' <<<"$spec" >/dev/null
  expected_secrets="$(jq -cnS '[{name:"FREEPASS_DATA_CONSUMERS_JSON",valueFrom:{secretKeyRef:{name:"freepass-data-consumers",key:"4"}}},{name:"EANCAR_ONE_API_KEY",valueFrom:{secretKeyRef:{name:"freepass-data-iancar-one-api",key:"1"}}}] | sort_by(.name)')"
  actual_secrets="$(jq -cS '[.containers[0].env[]? | select(.valueFrom != null) | {name,valueFrom}] | sort_by(.name)' <<<"$spec")"
  check SECRET_REFERENCES test "$actual_secrets" = "$expected_secrets"
  image="$(jq -r '.containers[0].image // empty' <<<"$spec")"
  image_path="${image%@*}"; image_path="${image_path%%:*}"
  check IMAGE_PATH test "$image_path" = asia-northeast3-docker.pkg.dev/freepasserp5/freepass-data/freepass-data-read
  check IMAGE_DIGEST test "${image##*@}" = "$EXPECTED_IMAGE_DIGEST"
done
source_image="asia-northeast3-docker.pkg.dev/freepasserp5/freepass-data/freepass-data-read:$EXPECTED_SOURCE_SHA"
source_digest="$(gcloud artifacts docker images describe "$source_image" --project="$PROJECT_ID" --format='value(image_summary.digest)')"
check SOURCE_IMAGE_BINDING test "$source_digest" = "$EXPECTED_IMAGE_DIGEST"
policy="$(gcloud run services get-iam-policy "$SERVICE_NAME" --project="$PROJECT_ID" --region="$REGION" --format=json)"
check PRIVATE_IAM jq -e '[.bindings[]?.members[]?] | all(. != "allUsers" and . != "allAuthenticatedUsers")' <<<"$policy" >/dev/null
url="$(jq -r '.status.url // empty' <<<"$service_json")"
check CANONICAL_URL test "$url" = https://freepass-data-read-njl7veujva-du.a.run.app
echo "url=$url" >> "$GITHUB_OUTPUT"
echo "READ_RUNTIME_DEPLOYED_URL=$url" >> "$GITHUB_ENV"
echo 'VERIFY_METADATA=PASS'
unset service_json revision_json spec metadata actual_secrets expected_secrets policy
