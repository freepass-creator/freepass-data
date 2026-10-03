# 이안카 15분 예약 중계 — 배포 절차 (freepasserp5)

상태: **절차만 작성. 실행 안 됨.** 실행은 경영지원실이 대표 승인(2026-10-03 「이안카 예약 만들고」)으로 한다.
코드: [iancar-scheduler-relay.ts](../../src/api/iancar-scheduler-relay.ts), [iancar-relay-transport.ts](../../src/api/iancar-relay-transport.ts), [serve-iancar-relay.ts](../../src/jobs/serve-iancar-relay.ts). 설계 근거: [NATIVE-SOURCE-COLLECTOR.md](../NATIVE-SOURCE-COLLECTOR.md#supplier-direct-status).

흐름: Cloud Scheduler(15분, OIDC) → 비공개 Cloud Run `freepass-data-iancar-relay` → GitHub `freepass-creator/freepasserp4` `erp5-ssot-refresh.yml` workflow_dispatch(`iancar_only=true, iancar_apply=true, apply=false, target=ALL` 고정).
중계는 Firestore·시트·이안카 API 권한이 없다. 같은 회차 중복, 진행 중인 writer, 불명확한 응답은 호출하지 않는다(SKIPPED_BUSY / UNKNOWN). 200 응답은 «갱신 완료»가 아니다 — ERP4 run 결과와 F01/F86 readback을 따로 본다.

## 0. 고정 값

| 이름 | 값 |
|---|---|
| 프로젝트 | `freepasserp5` (번호 `110304297079`) |
| 지역 | `asia-northeast3` |
| Cloud Run 서비스 | `freepass-data-iancar-relay` |
| 서비스 URL(=OIDC audience) | `https://freepass-data-iancar-relay-110304297079.asia-northeast3.run.app` |
| 중계 실행 SA | `iancar-relay-runtime@freepasserp5.iam.gserviceaccount.com` |
| Scheduler 호출 SA | `iancar-relay-scheduler@freepasserp5.iam.gserviceaccount.com` |
| Scheduler job | `projects/freepasserp5/locations/asia-northeast3/jobs/iancar-relay-15m` |
| cron (UTC) | `2,17,32,47 * * * *` |
| 영수증 버킷 / 접두사 | `freepasserp5-data-audit-evidence` / `iancar-relay/` |
| GitHub 열쇠 Secret | `eancar-relay-github-token` (대표가 등록, 버전 `1`) |
| 이미지 저장소 | `asia-northeast3-docker.pkg.dev/freepasserp5/freepass-data` |

```bash
PROJECT=freepasserp5
REGION=asia-northeast3
SERVICE=freepass-data-iancar-relay
RUNTIME_SA=iancar-relay-runtime@freepasserp5.iam.gserviceaccount.com
SCHED_SA=iancar-relay-scheduler@freepasserp5.iam.gserviceaccount.com
JOB=iancar-relay-15m
AUDIENCE=https://freepass-data-iancar-relay-110304297079.asia-northeast3.run.app
BUCKET=freepasserp5-data-audit-evidence
SECRET=eancar-relay-github-token
SHA=$(git rev-parse HEAD)   # #288 머지 후 main 의 정확한 커밋에서 실행
IMAGE=$REGION-docker.pkg.dev/$PROJECT/freepass-data/freepass-data-iancar-relay:$SHA
```

## 1. 사전 확인 (읽기만)

```bash
gcloud secrets versions describe 1 --secret=$SECRET --project=$PROJECT --format='value(state)'   # ENABLED
gcloud storage buckets describe gs://$BUCKET --format='value(iam_configuration.public_access_prevention)'   # enforced
gcloud services list --enabled --project=$PROJECT --filter='name:(run.googleapis.com cloudscheduler.googleapis.com)'
```

`cloudscheduler.googleapis.com` 이 없으면 켠다(대표 승인 범위):

```bash
gcloud services enable cloudscheduler.googleapis.com --project=$PROJECT
```

## 2. 서비스 계정 2개

```bash
gcloud iam service-accounts create iancar-relay-runtime --project=$PROJECT --display-name="Iancar relay runtime (dispatch only)"
gcloud iam service-accounts create iancar-relay-scheduler --project=$PROJECT --display-name="Iancar relay scheduler caller"
```

## 3. 최소 권한

```bash
# 3-1 GitHub 열쇠 Secret 하나만 읽기
gcloud secrets add-iam-policy-binding $SECRET --project=$PROJECT \
  --member=serviceAccount:$RUNTIME_SA --role=roles/secretmanager.secretAccessor

# 3-2 영수증: 버킷 전체가 아니라 iancar-relay/ 접두사만 (생성·읽기. 삭제 권한 없음)
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
  --member=serviceAccount:$RUNTIME_SA --role=roles/storage.objectCreator \
  --condition='expression=resource.name.startsWith("projects/_/buckets/freepasserp5-data-audit-evidence/objects/iancar-relay/"),title=iancar-relay-create'
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
  --member=serviceAccount:$RUNTIME_SA --role=roles/storage.objectViewer \
  --condition='expression=resource.name.startsWith("projects/_/buckets/freepasserp5-data-audit-evidence/objects/iancar-relay/"),title=iancar-relay-read'
```

주의: pending 객체는 generation 조건부 **덮어쓰기**(CAS)를 쓴다. GCS 덮어쓰기는 `storage.objects.delete` 가 필요하므로, 3-2만으로 첫 회차 뒤 pending 갱신이 403이면 중계는 UNKNOWN으로 멈춘다(fail closed). 그때 아래를 **같은 접두사 조건으로만** 추가한다 — 버킷 전체 권한은 주지 않는다.

```bash
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
  --member=serviceAccount:$RUNTIME_SA --role=roles/storage.objectUser \
  --condition='expression=resource.name.startsWith("projects/_/buckets/freepasserp5-data-audit-evidence/objects/iancar-relay/v1/pending.json"),title=iancar-relay-pending-cas'
```

(3-3은 Cloud Run 배포 뒤 5-1에서.)

## 4. 이미지 빌드·Cloud Run 배포 (비공개, 인증 필수)

```bash
gcloud builds submit --project=$PROJECT --region=$REGION --tag=$IMAGE .
gcloud run deploy $SERVICE --project=$PROJECT --region=$REGION --platform=managed \
  --image=$IMAGE --service-account=$RUNTIME_SA \
  --no-allow-unauthenticated --ingress=all \
  --max-instances=1 --concurrency=1 --timeout=60 \
  --command=node --args=dist/src/jobs/serve-iancar-relay.js \
  --set-env-vars="NODE_ENV=production,FIREBASE_PROJECT_ID=$PROJECT,IANCAR_RELAY_AUDIENCE=$AUDIENCE,IANCAR_RELAY_SCHEDULER_EMAIL=$SCHED_SA,IANCAR_RELAY_JOB_NAME=projects/$PROJECT/locations/$REGION/jobs/$JOB,IANCAR_RELAY_PRIVATE_EVIDENCE_BUCKET=$BUCKET,IANCAR_RELAY_ACTIONS_SECRET=$SECRET,IANCAR_RELAY_ACTIONS_SECRET_VERSION=1" \
  --quiet
```

환경변수 6개(`IANCAR_RELAY_*`) 중 하나라도 틀리면 서버가 시작을 거부한다(`RELAY_START_FAILED`) — 배포 실패가 정상 반응이다.
배포 뒤 URL이 위 AUDIENCE와 같은지 확인한다(다르면 AUDIENCE를 실제 URL로 바꿔 다시 배포):

```bash
gcloud run services describe $SERVICE --project=$PROJECT --region=$REGION --format='value(status.url,status.urls)'
```

## 5. Scheduler

```bash
# 5-1 Scheduler 호출 SA 는 이 서비스만 호출
gcloud run services add-iam-policy-binding $SERVICE --project=$PROJECT --region=$REGION \
  --member=serviceAccount:$SCHED_SA --role=roles/run.invoker

# 5-2 15분 예약 (본문은 반드시 빈 객체 {} — 다른 값이면 중계가 거부)
gcloud scheduler jobs create http $JOB --project=$PROJECT --location=$REGION \
  --schedule='2,17,32,47 * * * *' --time-zone=Etc/UTC \
  --uri="$AUDIENCE/schedule" --http-method=POST \
  --headers=Content-Type=application/json --message-body='{}' \
  --oidc-service-account-email=$SCHED_SA --oidc-token-audience=$AUDIENCE \
  --attempt-deadline=60s --max-retry-attempts=0
```

`--max-retry-attempts=0`: 중계가 UNKNOWN도 200으로 답하므로 Scheduler 재시도는 필요 없다.

## 6. 1회 실행·확인

```bash
gcloud scheduler jobs run $JOB --project=$PROJECT --location=$REGION
gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=$SERVICE" \
  --project=$PROJECT --freshness=10m --limit=20 --format='value(timestamp,httpRequest.status,textPayload)'
gcloud storage ls gs://$BUCKET/iancar-relay/v1/
gh run list -R freepass-creator/freepasserp4 --workflow erp5-ssot-refresh.yml --limit 3
```

판정:
- 응답 `ACCEPTED_PENDING` + runId → 해당 ERP4 run의 «이안카 공식 API 전체 관측 → Data 상품 반영» 단계와 F01/F86 대사 단계 결과를 본다. 공급사 `stale=true`면 그 회차 HOLD는 정상(마지막 정상 자료 유지).
- `SKIPPED_BUSY` → 다른 writer 실행 중. 다음 회차에서 다시 본다.
- `UNKNOWN` → 재실행하지 말고 로그와 영수증(`iancar-relay/v1/`)을 확인한다. pending이 UNKNOWN으로 남으면 이후 회차는 계속 건너뛴다(의도된 fail closed) — 원인 확인 뒤 사람이 정리한다.
- 401 → Scheduler SA/audience 불일치. 400 → 본문·job 이름 불일치.

이후 24시간 동안 `ACCEPTED_PENDING` 회차 수와 실제 ERP4 이안카 run 수, 공급사 syncedAt 전진을 비교해 [NEXT-START-HERE.md](../NEXT-START-HERE.md)에 기록한다. ERP4 workflow의 GitHub cron `2,32,47`은 이 확인이 끝날 때까지 그대로 둔다(겹치면 ERP4 쪽이 양보).

## 7. 되돌리기

가벼운 순서 → 무거운 순서:

```bash
# 7-1 즉시 멈춤 (되살리기: resume)
gcloud scheduler jobs pause $JOB --project=$PROJECT --location=$REGION

# 7-2 완전 제거
gcloud scheduler jobs delete $JOB --project=$PROJECT --location=$REGION --quiet
gcloud run services delete $SERVICE --project=$PROJECT --region=$REGION --quiet
gcloud secrets remove-iam-policy-binding $SECRET --project=$PROJECT \
  --member=serviceAccount:$RUNTIME_SA --role=roles/secretmanager.secretAccessor
gcloud storage buckets remove-iam-policy-binding gs://$BUCKET --member=serviceAccount:$RUNTIME_SA --role=roles/storage.objectCreator --all
gcloud storage buckets remove-iam-policy-binding gs://$BUCKET --member=serviceAccount:$RUNTIME_SA --role=roles/storage.objectViewer --all
gcloud storage buckets remove-iam-policy-binding gs://$BUCKET --member=serviceAccount:$RUNTIME_SA --role=roles/storage.objectUser --all   # 3-2 추가분을 넣었을 때만
gcloud iam service-accounts delete $SCHED_SA --project=$PROJECT --quiet
gcloud iam service-accounts delete $RUNTIME_SA --project=$PROJECT --quiet
```

영수증 객체(`iancar-relay/`)는 증거이므로 지우지 않는다. GitHub 토큰 폐기는 대표가 GitHub 설정에서 한다.
