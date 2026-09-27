# FreePass Data Read Runtime — Activation Handoff

상태: **DEPLOY WORKFLOW PREPARED / GCP ADMIN BOOTSTRAP REQUIRED**

이 문서는 FreePassERP.com이 실제 FreePass Data read runtime을 사용하기 시작하는 시점과 담당을 고정한다.

## 1. 최초 시작자는 GCP 관리자

현재 `freepasserp5` 프로젝트는 Cloud Run Admin API가 비활성 상태이며,
기존 `github-data-auditor`는 `serviceusage.services.enable` 권한이 없다.

따라서 최초 1회는 GCP 프로젝트 관리자가 시작한다.

### 관리자 bootstrap

필수 API:

- `run.googleapis.com`
- `artifactregistry.googleapis.com`
- `iamcredentials.googleapis.com`
- `sts.googleapis.com`
- `secretmanager.googleapis.com`

준비할 자원:

1. Artifact Registry Docker repository
2. read runtime service account
   - Firestore `roles/datastore.viewer`
   - consumer secret에만 `roles/secretmanager.secretAccessor`
3. deploy service account
   - Cloud Run deploy
   - Artifact Registry push
   - runtime service account `actAs`
4. GitHub Actions용 deploy WIF provider
   - 이 저장소의 `.github/workflows/deploy-read-runtime.yml`만 허용
5. Secret Manager의 `FREEPASS_DATA_CONSUMERS_JSON`
6. Vercel 호출용 service account
   - Cloud Run service에 `roles/run.invoker`
7. Vercel OIDC용 GCP Workload Identity provider
   - production `freepasserp4` workload만 허용
   - caller service account에 `roles/iam.workloadIdentityUser`

## 2. GitHub repository variables

관리자가 bootstrap 후 FreePass Data 저장소에 아래 repository variables를 설정한다.

- `FREEPASS_DATA_DEPLOY_WIF_PROVIDER`
- `FREEPASS_DATA_DEPLOY_SERVICE_ACCOUNT`
- `FREEPASS_DATA_READ_REGION` — 권장 `asia-northeast3`
- `FREEPASS_DATA_READ_SERVICE_NAME` — 권장 `freepass-data-read`
- `FREEPASS_DATA_ARTIFACT_REPOSITORY`
- `FREEPASS_DATA_RUNTIME_SERVICE_ACCOUNT`
- `FREEPASS_DATA_CONSUMERS_SECRET_NAME`

## 3. 누가 read runtime을 배포하는가

**FreePass Data I-01**이 GitHub Actions에서:

`Deploy FreePass Data read runtime`

워크플로를 수동 실행한다.

이 워크플로는:

- 자동 실행하지 않는다.
- API가 미리 켜져 있지 않으면 실패한다.
- immutable SHA tag 이미지로 배포한다.
- anonymous invocation을 허용하지 않는다.
- runtime에는 Firestore read-only identity만 붙인다.
- 배포 후 Cloud Run URL과 Ready 상태만 출력한다.

## 4. 배포 후 인계

Data I-01이 아래를 ERP I-01에 넘긴다.

- Cloud Run service URL
- GCP WIF audience
- Vercel caller service account email
- `erp-com` consumer token
- White Label consumer token map

token 값은 문서·PR·로그에 남기지 않는다.

## 5. ERP 개통

ERP I-01은 먼저 Vercel Preview에서 연결값을 설정하고 실제 `catalog-compat` readback을 확인한다.

Preview PASS 후 Production에 연결값을 넣되 read mode는 먼저 둘 다 `LEGACY_DIRECT`로 둔다.

그 다음:

1. `FREEPASS_DATA_ERP_COM_READ_MODE=OBSERVE`
2. ERP.com 검증
3. `FREEPASS_DATA_WHITELABEL_READ_MODE=OBSERVE`
4. White Label 검증

이 순간부터 화면 데이터 transport가 FreePass Data를 통과한다.

## 6. 누가 최종 스위치를 넘기는가

기술 실행 담당은 **FreePassERP I-01**이다.

최종 운영 개통 판단은 사용자다.

즉 역할은:

```text
GCP 관리자
  ↓ 최초 bootstrap
FreePass Data I-01
  ↓ read runtime 배포 + URL/credential handoff
FreePassERP I-01
  ↓ Preview readback
사용자 GO
  ↓
ERP.com OBSERVE
  ↓ 확인
White Label OBSERVE
```

문제가 생기면 I-01은 해당 mode를 `LEGACY_DIRECT`로 되돌리고 재배포한다.
