# 원천 엔진 온라인 실행 설계 — 운영 PC(B3Q) 예약 작업을 GitHub Actions 로 (2026-10-14)

목표(대표): ERP5 가 최신 원천으로 일정 간격마다 새로고침되어, 팔린 차는 내려가고(하향) 새 차는 편입되는 것.
엔진은 이 동작(편입·갱신·재노출·부재 하향·계약 잠금 보존·회차 상한·백업·되읽기)을 이미 한다. 공백은 «어디서 도느냐»다:
지금은 B3Q 개발 PC 의 작업 스케줄러에서만 돈다(PC 가 꺼지거나 로그인 토큰이 만료되면 멈춤).
상태: DESIGNED + DRY_RUN 워크플로 CODED·TESTED. 운영 쓰기 전환은 커맨드 센터 승인 사항.

## 1. 현재 B3Q 예약 작업 (코드·문서 근거)

| 예약 | 명령 | 간격 | 근거 |
|---|---|---|---|
| 전체 정시 회차 | `scripts/run-source-cycle.ps1 -EnvFile <저장소 밖>` → `dist/src/runtime/source-cycle-runtime.js --unattended` | 60분(:00) | `scripts/register-source-cycle.ps1`, 대표 2026-10-13 |
| 이안카 RP031 단독 | 같은 실행기 `-Source RP031 -OnlyWhenSynced` | 60분(:05) | `docs/SOURCE-CYCLE-OPS-HANDOFF-20261014.md` §5 |

무인 적용은 `SOURCE_CYCLE_UNATTENDED=1` 과 `--unattended` 둘 다 있어야 켜진다(코드 가드). 결과 기록은 개인 폴더의 `unattended-runs.jsonl`·`heartbeats.jsonl`·`alerts.jsonl`.

## 2. 로컬 의존 요소 → 온라인 대체

| 의존 | 지금(B3Q) | 온라인 대체 | 상태 |
|---|---|---|---|
| Firestore 인증 | `gcloud auth print-access-token`(사용자 계정) | WIF + 서비스 계정 → `google-github-actions/auth` 후 같은 gcloud 명령이 그대로 동작 | 변수 `SOURCE_CYCLE_WIF_PROVIDER`·`SOURCE_CYCLE_READ_SERVICE_ACCOUNT` 필요(읽기 전용 SA) |
| 시트 읽기(F05·아이카·오토플러스 시트) | `gws` CLI(회사 계정 위임) | 서비스 계정에 시트 «보기» 공유 + Sheets API 토큰 전송(코드 변경 필요: `SHEETS_TRANSPORT=gws` 외 전송 추가) | **HOLD** — 다음 PR |
| 개인 폴더(잠금·상태·백업·기록) | `~/.codex/private/source-cycle` | DRY_RUN: 실행기 임시 폴더(쓰기 없음이라 충분). 적용 단계: 백업·기록을 비공개 GCS 버킷으로, 잠금은 workflow `concurrency` + Firestore 리스 | 적용 전 설계 확정 필요 |
| ERP4 수집 증거(`gh api`) | B3Q 의 gh 로그인 | Actions `GITHUB_TOKEN` 또는 생략(ERP4 폐기 방향) | ERP4 폐기 후 제거 |
| 원천 비밀(이안카 ONE 키, 손오공 API 키, 시트 ID) | 저장소 밖 env 파일 | 저장소 Secrets/Variables(값은 커밋·로그 금지) | 커맨드 센터가 등록 |

## 3. 단계 (원천 하나씩, 이중 쓰기 금지)

1. **DRY_RUN(이 PR)** — `.github/workflows/source-cycle-dry-run.yml`: 수동 실행 + 정기(:17) 실행, 정기는 `vars.FREEPASS_SOURCE_CYCLE_DRY_RUN_SCHEDULE=on` 일 때만.
   원천 종류 IANCAR·IRON·AUTOPLUS 만(공개 홈피·API 키로 읽히는 원천). `--apply`·`--unattended` 를 넘기지 않고 쓰기 스위치·승인 digest 를
   자식 환경에서 지운다. 엔진은 apply 없으면 `DRY_RUN, writes 0`. 결과는 실행 요약 표(원천별 «원천 N → 노출 M (계획), 하향·편입·재노출·갱신»).
2. **B3Q 와 병행 비교** — 같은 시각 B3Q 회차의 계획 digest·요약과 DRY_RUN 결과를 며칠 대조(차이 = 읽기 환경 차이).
3. **시트 전송 추가** — Sheets API 서비스 계정 전송 → F05·아이카·오토플러스 시트도 DRY_RUN 에 편입.
4. **적용 전환(원천별)** — 쓰기 SA(Firestore 쓰기, products 한정) + 백업·기록 GCS + 리스 잠금 → B3Q 의 그 원천 예약 정지 → Actions 적용 켜기 → 5칸 지표 확인.
   롤백 = Actions 스위치 off + B3Q 예약 재개.
5. **간격** — 기본 60분(현행과 같음). 원천별 더 짧게(예: 이안카 갱신 직후) 는 4 이후 결정.

## 4. 커맨드 센터가 할 일 (이 PR 합침 후)

- 읽기 전용 SA + WIF 공급자 생성, `SOURCE_CYCLE_WIF_PROVIDER`·`SOURCE_CYCLE_READ_SERVICE_ACCOUNT` 변수 등록(Firestore 읽기만).
- `EANCAR_ONE_API_BASE_URL`(변수)·`EANCAR_ONE_API_KEY`(비밀)·`SOURCE_CYCLE_IRON_LIST_URL`(변수) 등록 — 없으면 그 원천은 SKIPPED.
- 수동 실행으로 확인 후 정기 스위치 on.
