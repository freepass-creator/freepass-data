# 원천 엔진 온라인 이전 설계 한 장 (2026-10-14, 커맨드 센터 지시 «로컬에서 작업하지 말고 온라인 배포 기준»)

목표: B3Q 작업 스케줄러가 돌리는 원천 엔진(정시 전체 회차 + RP031 단독)을 GitHub Actions 스케줄(또는 Cloud Run Job + Cloud Scheduler)로 옮긴다. 이중 실행 없이, 키·서비스 계정 값은 비밀값에만 두고 로그에 출력하지 않는다.

## 1. 지금 B3Q 에 있는 것(이전 대상)
| 항목 | 현재 | 온라인 대응 |
|---|---|---|
| 예약 작업 | FreePass-Source-Cycle(정시, 전체 원천), FreePass-Source-Cycle-RP031(:05, 단독), FreePass-ERP4-Round-Ensure(비활성), CollectionHealthWatch | Actions `schedule`(정시·:05) + `concurrency` 그룹 1개 + 엔진 Firestore 잠금 |
| 실행기 | `scripts/run-source-cycle.ps1` → `dist/src/runtime/source-cycle-runtime.js --unattended` | 같은 JS 를 Actions Linux 에서 `npm ci && npm run build` 후 실행 (PowerShell 래퍼 불필요) |
| 환경변수(env.ps1 비공개) | FIREBASE_PROJECT_ID, SOURCE_CYCLE_SOURCES, SOURCE_CYCLE_*_SHEET_ID(F05·AICA·오토플러스), AUTOPLUS 스위치, FRESHNESS_EXEMPT, STALE_FALSE_POSITIVE, SHEETS_TRANSPORT, GWS_BIN, EANCAR_ONE_API_KEY, (손오공) API 키 | 비밀 아닌 값은 저장소 변수(vars), 키류는 Secret(저장소 비밀값) |
| 로컬 파일 상태 | `SOURCE_CYCLE_PRIVATE_DIR`: 회차 기준 건수·잠금 표식·heartbeats.jsonl·unattended-runs.jsonl·alerts.jsonl·백업 영수증·ENROLL_CAP_ONCE 표식 | **Firestore(ops 컬렉션)로 이전** 또는 Actions artifact 보존; 표식·기준 건수는 반드시 Firestore(러너는 휘발) |
| 인증 | gcloud 사용자 토큰(gcloudUserToken), gws(pyh@teamjpk.com 시트 읽기) | Firestore: 서비스 계정(Workload Identity Federation, 키 파일 없음). 시트: data-owned-refresh.yml 의 위임 읽기 패턴 재사용 |
| 체크아웃 교체 절차 | prev-commit 파일·프로세스 대기 | 불필요(Actions 가 main 최신으로 실행). 롤백 = 워크플로 pin(SHA) 되돌리기 |

## 2. 막힌 지점과 대표 손(1회)
1. 서비스 계정 연동(WIF)·Secret 등록은 IAM/비밀값 → 대표 손. 필요 값: 엔진 서비스 계정(쓰기: Firestore datastore.user), 손오공 키 번들 해제 → 저장소 비밀값 `SONOGONG_API_KEY` 한 번.
2. Drive 읽기·이안카 키 등은 같은 방식으로 비밀값.
3. 손오공 키는 지금 B3Q 로컬 DPAPI(Codex 앱 로컬 캐시)에만 있다 — 온라인에는 못 간다.

## 3. 이전 순서(원천별 무중단)
1. 읽기 전용 원천(오토플러스 시트·F05·AICA)부터 Actions `DRY_RUN`(쓰기 0) 시험 → B3Q 같은 회차 plan 과 digest 일치 확인.
2. 일치하면 해당 원천만 Actions 쓰기 켜기 + B3Q `SOURCE_CYCLE_SOURCES` 에서 제외(이중 실행 금지).
3. 이안카·아이언·손오공 순(키 필요) 반복.
4. 전부 이전되면 B3Q 예약 작업 비활성, 신선도 판정은 Actions 실행 기록(`unattended-runs` Firestore)을 정본으로.
5. 각 단계 후 `/api/catalog` 원천별 5칸 대사(gap 0) 온라인 되읽기.

## 4. 위험·가드
- 이중 실행: concurrency 그룹 + Firestore 잠금(이미 있음) + B3Q 에서 해당 원천 제외를 «먼저».
- 실행 시간: Actions 6시간 한도 내(현재 전체 회차 약 27분). 스케줄 지연은 신선도 감시가 잡는다.
- 비밀값 출력 금지: `::add-mask::`, 키를 인자·파일에 쓰지 않는다.
- 롤백: B3Q 예약 작업을 다시 켜고(원천 목록 복원) Actions 스케줄을 끈다.

## 5. 구현 현황 (클라우드 구현 담당, 2026-10-14)
- **DRY_RUN 워크플로(#608)**: `.github/workflows/source-cycle-dry-run.yml` + `scripts/ci/source-cycle-dry-run.mjs`. 수동 + 정기(:17, `vars.FREEPASS_SOURCE_CYCLE_DRY_RUN_SCHEDULE=on` 일 때만). `--apply`·`--unattended` 없음, 쓰기·승인·인계 스위치를 자식 환경에서 삭제, 적용 흔적이 보이면 실패. 읽기 SA 변수(`SOURCE_CYCLE_WIF_PROVIDER`·`SOURCE_CYCLE_READ_SERVICE_ACCOUNT`) 없으면 실패로 표시. 원천 키·주소 없으면 그 원천 SKIPPED. 지금 대상: IANCAR·IRON·AUTOPLUS(홈피).
- **시트 ADC 전송(#618)**: `SHEETS_TRANSPORT=adc` 면 F05·아이카·오토플러스 시트를 gws 없이 읽는다(§1 «data-owned-refresh 위임 읽기 패턴» = `GOOGLE_SHEETS_APPLICATION_CREDENTIALS`·`GOOGLE_SHEETS_SUBJECT` 또는 ADC). 기본값(gws, B3Q) 동작 불변. #618 합침 후 DRY_RUN 원천 목록에 F05·AICA 추가(후속 PR) → §3-1 순서대로.
- **남은 코드 작업**: 회차 상태(기준 건수·잠금·한 회차 표식·heartbeat·실행 기록)를 Firestore ops 컬렉션으로(§1, 쓰기 전환의 전제). 그 전까지 온라인은 DRY_RUN 만.
