# 공급사 수집 중계 — 배포 절차 (freepasserp5)

상태: **로컬 구현 / 운영 활성 HOLD**. 이 문서는 승인된 운영 담당자의 후속 절차이며 이번 PR에서 명령을 실행하지 않았다.
코드: [supplier-relay.ts](../../src/api/supplier-relay.ts), [supplier-relay-transport.ts](../../src/api/supplier-relay-transport.ts), [serve-supplier-relay.ts](../../src/jobs/serve-supplier-relay.ts). 시작 명령 `npm run serve:supplier:relay`.

## 허용 목록과 workflow 근거

정본은 코드의 `SUPPLIER_RELAY_ALLOWLIST`. HTTP 본문은 `{}`만 허용하고 Scheduler 전체 job 이름을 항목 id에 매핑한다. 호출자가 repository/ref/inputs를 고르지 못한다.

| id | repository / workflow / ref | 고정 inputs | cron UTC | writer 그룹 | 활성 |
|---|---|---|---|---|---|
| iancar-15m | freepass-creator/freepasserp4 / erp5-ssot-refresh.yml / main | iancar_only=true, iancar_apply=true, apply=false, target=ALL | `2,17,32,47 * * * *` | erp5-inventory-publish | 검증 후 |
| hourly-all | 위와 같음 | iancar_only=false, iancar_apply=false, apply=false, target=ALL | `17 * * * *` | erp5-inventory-publish | **HOLD: 이안카 확인 후 활성 검토** |

2026-10-03 GitHub contents API 읽기는 샌드박스 네트워크 제한으로 실패했다. 아래는 **로컬 origin/main 094155bd8e03a4269654a45b2eac6237a7796ad1**의 Git 객체 근거이며 최신 원격 검증이 아니다. 활성 전에 두 yml을 원격 main에서 다시 확인한다.

- refresh L10–15: 전체 공급사 :17, 이안카 :02/:32/:47 cron.
- refresh L28–53: workflow_dispatch apply/ready_run_id/target/iancar_only/iancar_apply 정의.
- refresh L56–81: cadence가 이안카 회차일 때 자신 이외 미완료 workflow run을 최대100개 조회하고, 있으면 run_refresh=false.
- refresh L82–88: refresh job의 `erp5-inventory-publish`, `cancel-in-progress:false`, cadence 통과 조건. workflow 전체 잠금이 아니다.
- refresh L98–107: 수동 전체 회차는 IANCAR_SYNC_REQUESTED=false. iancar_apply=true를 전체 회차에 붙이면 검증 단계가 거부한다. 따라서 위 hourly-all 입력은 일반 전체 경로 후보일 뿐 자동 매시 회차의 이안카 fresh sync와 동등하지 않다. 정확히 동등한 dispatch 조합이 없어 코드에서도 HOLD로 차단한다.
- watchdog L12–22: :42 cron, force_recovery boolean(default false), 별도 `erp5-ssot-watchdog` concurrency/cancel-in-progress:false. L61–70은 refresh에 repository_dispatch를 보낸다.

### 경합 처리와 한계

중계끼리는 writer 그룹별 GCS pending CAS를 공유한다. ERP4 cron은 이 CAS를 사용하지 않는다. 사전 writerRuns IDLE 뒤 cron이 들어올 수 있다. dispatch 직후 run 목록을 다시 읽어 자기 run ID를 제외한 미완료 run이 있으면 `UNKNOWN / OVERLAP`, 조회 불명확은 `UNKNOWN / POST_DISPATCH_READ_UNKNOWN`으로 기록하고 pending을 유지한다. 자기 run이 cancelled/failure이면 자동 해제·재전송하지 않는다.

cadence 양보는 **그 단계가 조회했을 때** 이미 보이는 미완료 run만 처리한다. 이 조회와 refresh job 입장 사이의 경합까지 막는다고 단정하지 않는다. GitHub pending 대체/취소 가능성과 재조회 뒤 도착한 cron을 완전히 막을 수 없다. 성공 conclusion도 실제 수집·발행 성공의 증거가 아니다(cadence 양보로 job이 skip될 수 있음). ERP4 실제 단계와 소비처 readback을 따로 검증한다.

**Scheduler 확인 후 ERP4 cron 제거는 별도 승인**. 이 PR은 ERP4를 수정하지 않는다. hourly/watchdog 등 모든 입장 경로가 공유하는 원자적 잠금은 미구현이다.

## 고정 배포 값

```bash
PROJECT=freepasserp5
REGION=asia-northeast3
SERVICE=supplier-collect-relay
RUNTIME_SA=supplier-relay-runtime@freepasserp5.iam.gserviceaccount.com
SCHED_SA=supplier-relay-scheduler@freepasserp5.iam.gserviceaccount.com
JOB=supplier-relay-iancar-15m
AUDIENCE=https://supplier-collect-relay-110304297079.asia-northeast3.run.app
BUCKET=freepasserp5-data-audit-evidence
SHA=$(git rev-parse HEAD)
IMAGE=$REGION-docker.pkg.dev/$PROJECT/freepass-data/supplier-collect-relay:$SHA
```

기존 Secret 이름은 아래 `SUPPLIER_RELAY_ACTIONS_SECRET` 환경변수의 값으로만 지정한다. 기존 버전1을 읽으며 새 Secret 생성·값 입력·출력·복사 절차는 없다. 기존 Secret의 runtime accessor binding은 담당자가 사전 확인한다. Firestore/Sheets/공급사 API 권한을 중계에 주지 않는다.

## 최초 실행 전 필수 IAM

승인된 담당자가 SA `supplier-relay-runtime`, `supplier-relay-scheduler`를 준비한다. Scheduler SA는 이 서비스에만 run.invoker. runtime은 기존 Secret 단일 accessor, 아래 객체 권한만 부여한다. 버킷 public access prevention enforced 확인 필수.

pending **정확한 객체**는 최초 실행 전에 objectUser(create/read/update/delete 포함)가 필요하다. 403 발생 후 추가하는 선택 절차가 아니다. 현재 두 항목은 같은 그룹이므로 대상 객체는 하나다. 향후 그룹마다 정확한 객체 binding을 각각 추가한다.

```bash
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
  --member=serviceAccount:$RUNTIME_SA --role=roles/storage.objectUser \
  --condition='expression=resource.name == "projects/_/buckets/freepasserp5-data-audit-evidence/objects/supplier-relay/v1/pending/erp5-inventory-publish.json",title=supplier-relay-pending-cas'
```

`receipts/`, `outcomes/`, `completed/`, `status/`에는 prefix 조건 objectCreator + objectViewer만. `selftest/`에는 objectCreator만. 버킷 전체 objectUser 또는 pending startsWith 조건 금지.

```bash
for prefix in receipts outcomes completed status; do
  for role in roles/storage.objectCreator roles/storage.objectViewer; do
    gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
      --member=serviceAccount:$RUNTIME_SA --role="$role" \
      --condition="expression=resource.name.startsWith(\"projects/_/buckets/$BUCKET/objects/supplier-relay/v1/$prefix/\"),title=supplier-relay-$prefix"
  done
done
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
  --member=serviceAccount:$RUNTIME_SA --role=roles/storage.objectCreator \
  --condition='expression=resource.name.startsWith("projects/_/buckets/freepasserp5-data-audit-evidence/objects/supplier-relay/v1/selftest/"),title=supplier-relay-selftest-create'
```

**상태 파일은 덮어쓰지 않는다:** 회차마다 `status/<id>/<YYYYMMDDTHHMMSSZ>-<key>.json` 새 파일을 create-only로 만든다(2026-10-03 경영지원실 결정). 위 `status/` 접두사 create+read 외 권한 추가 없음. 오래된 상태 파일은 버킷 수명 규칙으로 30일 뒤 정리한다(접두사 한정, 영수증·outcomes·pending은 대상 아님):

```bash
cat > /tmp/supplier-relay-lifecycle.json <<'JSON'
{"rule":[{"action":{"type":"Delete"},"condition":{"age":30,"matchesPrefix":["supplier-relay/v1/status/"]}}]}
JSON
gcloud storage buckets describe gs://$BUCKET --format='json(lifecycle_config)'   # 기존 규칙 먼저 확인 — 있으면 합쳐서 넣는다(덮어쓰기 주의)
gcloud storage buckets update gs://$BUCKET --lifecycle-file=/tmp/supplier-relay-lifecycle.json
```

## 비공개 Cloud Run

승인된 배포자가 고정 SHA로 이미지를 빌드하고 배포한다. 최초에는 /verify만 호출한다.

```bash
gcloud builds submit --project=$PROJECT --region=$REGION --tag=$IMAGE .
gcloud run deploy $SERVICE --project=$PROJECT --region=$REGION --image=$IMAGE \
  --service-account=$RUNTIME_SA --no-allow-unauthenticated --ingress=all \
  --max-instances=1 --concurrency=1 --timeout=300 \
  --command=node --args=dist/src/jobs/serve-supplier-relay.js \
  --set-env-vars="NODE_ENV=production,FIREBASE_PROJECT_ID=$PROJECT,SUPPLIER_RELAY_AUDIENCE=$AUDIENCE,SUPPLIER_RELAY_SCHEDULER_EMAIL=$SCHED_SA,SUPPLIER_RELAY_JOB_PREFIX=projects/$PROJECT/locations/$REGION/jobs/,SUPPLIER_RELAY_PRIVATE_EVIDENCE_BUCKET=$BUCKET,SUPPLIER_RELAY_ACTIONS_SECRET=eancar-relay-github-token,SUPPLIER_RELAY_ACTIONS_SECRET_VERSION=1"
gcloud run services describe $SERVICE --project=$PROJECT --region=$REGION --format='value(status.url,status.urls)'
```

실제 URL과 audience 정확히 일치 확인. 잘못된 config는 startup 실패. 배포자 권한을 runtime에 부여하지 않는다.

## Scheduler 활성 전 검증

### 1. paused job와 OIDC 무쓰기 검증

Scheduler 생성 직후 pause까지의 경합을 피하려고 최초 URI는 **/verify**로 만든다. 생성 API에는 원자적인 paused 생성 옵션이 없으므로 생성 후 즉시 pause하고 PAUSED를 확인한다. 이 사이 실행돼도 /verify는 dispatch/GCS 쓰기를 하지 않는다.

```bash
gcloud scheduler jobs create http $JOB --project=$PROJECT --location=$REGION \
  --schedule='2,17,32,47 * * * *' --time-zone=Etc/UTC \
  --uri="$AUDIENCE/verify" --http-method=POST --headers=Content-Type=application/json --message-body='{}' \
  --oidc-service-account-email=$SCHED_SA --oidc-token-audience=$AUDIENCE \
  --attempt-deadline=300s --max-retry-attempts=0
gcloud scheduler jobs pause $JOB --project=$PROJECT --location=$REGION
gcloud scheduler jobs describe $JOB --project=$PROJECT --location=$REGION --format='value(state)'
```

권한 있는 운영 담당자가 Scheduler SA의 OIDC 토큰으로 /verify를 호출한다. 토큰은 파이프로만 전달하고 터미널·파일·로그에 출력하지 않는다. shell trace 비활성 필수. impersonation 권한이 없으면 HOLD이며 이 절차가 권한 추가 승인은 아니다.

```bash
set +x
gcloud auth print-identity-token --impersonate-service-account=$SCHED_SA --audiences=$AUDIENCE --include-email \
  | { IFS= read -r oidc_token; printf 'header = "Authorization: Bearer %s"\n' "$oidc_token"; } \
  | curl --config - --silent --show-error --fail-with-body \
      -H 'Content-Type: application/json' \
      -H "X-CloudScheduler-JobName: projects/$PROJECT/locations/$REGION/jobs/$JOB" \
      --data '{}' "$AUDIENCE/verify"
```

기대값: VERIFIED, checks.config/secret/gcsRead=VERIFIED, githubRuns=IDLE 또는 BUSY. UNKNOWN은 HOLD. 인증 issuer/audience/verified email을 검증하며 Secret 읽기, pending metadata/media 읽기, GitHub run 목록 GET만 수행한다. dispatch/GCS mutation은 0이다. pending 404는 미생성으로 처리하므로 실제 IAM binding도 별도로 확인해야 한다.

### 2. 조건부 create-only selftest — **쓰기 1건**

무쓰기 검증이 아니다. 별도 승인된 담당자만 runtime SA로 고유 시험 객체에 1회 실행한다. 운영 pending/status는 건드리지 않는다. 이 성공은 pending 덮어쓰기/delete 권한을 증명하지 않는다.

```bash
printf '{"schema":"supplier-relay-selftest/v1"}\n' | gcloud storage cp - \
  "gs://$BUCKET/supplier-relay/v1/selftest/$SHA-$(date -u +%Y%m%dT%H%M%SZ).json" \
  --if-generation-match=0 --impersonate-service-account=$RUNTIME_SA
```

### 3. 경합 확인

로컬 mock: IDLE 판정 후 cron 등장 → dispatch 후 재조회 BUSY → UNKNOWN/OVERLAP pending 유지, pending 교체로 cancelled → 자동 재전송0, 같은 writerGroup 두 항목 → admission1, /verify → dispatch/GCS mutation0. 실제 cron 경합은 미검증이다. 승인된 시험에서는 run ID·createdAt·cadence 출력·refresh job 상태·cancelled 결론·pending 세대·status를 대조한다. UNKNOWN을 수동 재실행하지 않는다.

### 4. 모든 게이트 통과 후에만 resume

위 검증, 최신 yml 재확인, 독립 검토, 실행 승인을 모두 충족한 뒤 PAUSED 상태에서 URI를 변경하고 resume한다. hourly-all job은 만들지 않는다.

```bash
gcloud scheduler jobs update http $JOB --project=$PROJECT --location=$REGION --uri="$AUDIENCE/schedule"
gcloud scheduler jobs resume $JOB --project=$PROJECT --location=$REGION
```

## 모니터 계약

`gs://<bucket>/supplier-relay/v1/status/<id>/<YYYYMMDDTHHMMSSZ>-<key>.json` (회차별 새 파일, 이름순 = 시각순):
`schema="supplier-relay-status/v1"`, `id`, `writerGroup`, `key`(job+scheduleTime SHA256), `jobName`, `scheduleTime`(UTC), `observedAt`(UTC), `outcome`(ACCEPTED_PENDING/SKIPPED_BUSY/UNKNOWN/FAILED), `runId`(string|null), `reason`(string|null).

최신 상태 = `status/<id>/` 아래 이름순 마지막 파일. 같은 key 파일이 이미 있으면 그 회차 기록을 유지한다(덮어쓰기·삭제 없음). status 쓰기 실패 때는 새 파일이 생기지 않으므로 시각 정체도 경보로 처리한다. HOLD 항목·미인증·잘못된 요청은 쓰지 않는다.

`receipts/<key>.json`, `outcomes/<key>.json`, `completed/<key>.json`은 create-only. `pending/<writerGroup>.json`은 RESERVED/ACCEPTED_PENDING/UNKNOWN/FAILED와 owner key·runId·reason 또는 CAS tombstone null이다. lease 만료 해제는 없다. UNKNOWN/OVERLAP과 cancelled는 자동 해제하지 않는다. 감시자 읽기 권한은 runtime과 분리해 승인한다.

2xx/ACCEPTED_PENDING은 갱신 성공이 아니다. 실제 ERP4 run 단계·source syncedAt/stale·canonical·F01/F86/소비처 readback을 대조한다. 장애 시 Scheduler pause 후 증거를 보존한다. pending 삭제나 재dispatch로 우회하지 않는다.
