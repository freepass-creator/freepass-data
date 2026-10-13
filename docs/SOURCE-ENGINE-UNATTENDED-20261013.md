# 원천 엔진 무인 회차 — ERP5 1시간 간격 자동 반영 (2026-10-13)

대표 결정(2026-10-13, GHD PLN 채팅): 「erp5 업데이트 제대로 신경써봐」 → 「1시간 간격으로 업데이트 되는지 개발피시 돌아갈수 있게끔 해」.
ai-ops `docs/대표-결정-장부.md` 10-13 「원천 엔진 실행 기반 · B3Q 스케줄러」에 박아 두었다. 앞선 15분 간격 표기는 1시간으로 대체.

## 무엇이 바뀌었나

- `src/jobs/source-cycle.ts` `runUnattendedSourceCycle`: 한 회차에서 ① 새 읽기로 계획(DRY_RUN) ② 변경이 있으면 그 계획의 digest 를 승인값으로 삼아 즉시 적용. 적용은 기존 `runSourceCycle(approvedPlan)` 경로를 그대로 재사용하므로 재읽기·사실 불일치 `CYCLE_REPLAN_REQUIRED`·blockers(`DOWNGRADE_RATIO_EXCEEDED`·`SOURCE_INCOMPLETE`·`CATALOG_INCOMPLETE`·`SOURCE_STALE`)·전체 백업·CAS·되읽기·연속 실패 3회 정지·원천 잠금이 전부 유지된다. 관측 전용 원천은 OBSERVED 로 끝난다. 변경 0 이면 적용 생략.
- `src/runtime/source-cycle-runtime.ts` `--unattended`: env `SOURCE_CYCLE_UNATTENDED=1` 과 플래그가 둘 다 있어야 켜진다. `--apply`·`--plan` 과 섞으면 `UNATTENDED_ARGS_INVALID`. 옛 수동 승인 경로(`--plan` → digest 외부 승인 → `--apply`)와 `jobs/source-cycle.js` 의 계획 전용 예약 경로는 그대로 남는다.
- `scripts/run-source-cycle.ps1`: 스케줄러가 부르는 실행기. 저장소 밖 비공개 EnvFile 을 읽고 `--unattended` 로 실행, 결과 한 줄을 `SOURCE_CYCLE_PRIVATE_DIR\unattended-runs.jsonl` 에 남긴다(원문·토큰 없음).
- `scripts/register-source-cycle.ps1`: `-Unattended -EnvFile <비공개 경로> -IntervalMinutes 60`(기본 60) `-Register`. `-Runtime` 옛 경로도 유지.

## 개발 PC(B3Q·DEV) 등록 절차

```powershell
git pull ; npm.cmd ci ; npm.cmd run build
# 비공개 env 파일(저장소 밖, 예: %USERPROFILE%\.codex\private\source-cycle\env.ps1):
#   $env:FIREBASE_PROJECT_ID='freepasserp5'; $env:SOURCE_CYCLE_SOURCES='F05,AICA,IANCAR,IRON,SONOGONG,AUTOPLUS'
#   $env:SOURCE_CYCLE_PRIVATE_DIR='…'; $env:SOURCE_CYCLE_*_SHEET_ID='…' (RESULT3 문서의 env 목록)
powershell -File scripts\run-source-cycle.ps1 -EnvFile <env.ps1>            # 1회 수동 실행으로 결과 줄 확인
powershell -File scripts\register-source-cycle.ps1 -Unattended -EnvFile <env.ps1> -IntervalMinutes 60   # DRY_RUN 출력 확인
powershell -File scripts\register-source-cycle.ps1 -Unattended -EnvFile <env.ps1> -IntervalMinutes 60 -Register
schtasks /Query /TN FreePass-Source-Cycle /V /FO LIST
```

기존 15분 작업이 등록돼 있으면 `scripts\unregister-source-cycle.ps1 -Remove` 로 먼저 지운다(`/F` 덮어쓰기 없음).

## 완료 판정(DEV 가 보고할 것)

- `schtasks /Query` 에 60분 간격·마지막 실행 결과 0.
- `unattended-runs.jsonl` 두 회차 이상: 첫 회차 `stage: APPLY, status: APPLIED`(또는 변경 0), 다음 회차 `변경 0: 적용 생략`.
- ERP5 되읽기: 반영된 UID 표본의 listable·가격이 원천과 같음. HOLD/STOPPED 가 나오면 원인 코드와 함께 PLN 커맨드 센터에 올린다(자동 재시도로 덮지 않음).

## 신선도 감시(대표 10-13 「데이터 원천 신선하게 erp5에 반영되게 확실하게 관리해」)

- `scripts/check-source-freshness.mjs`: `heartbeats.jsonl`·`alerts.jsonl` 만 읽어 원천별 마지막 정상 완료 나이를 판정. 기본 허용 120분(60분 회차 두 번). `STALE`·`STOPPED`·`ERROR`·`NEVER_COMPLETED`·`MISSING(--expect)` 는 UNHEALTHY, 종료 코드 1. 네트워크·Firestore 접근 없음.
- `run-source-cycle.ps1` 이 매 회차 끝에 이 판정을 `unattended-runs.jsonl` 의 `freshness` 칸에 함께 남긴다. UNHEALTHY 면 회차 종료 코드도 1 → 작업 스케줄러 「마지막 실행 결과」로 바로 보인다.
- 책임: PLN DATA 유지보수가 관리 책임자(ai-ops 결정 장부 10-13 «원천 엔진 신선도 감시»). B3Q DEV 는 UNHEALTHY 가 나오면 원인 코드와 함께 즉시 커맨드 센터에 올리고, 정상이어도 하루 두 번 `freshness` 요약을 보고한다. 신선도 판단은 기억이 아니라 이 파일과 ERP5 되읽기 근거로만.

```powershell
node scripts\check-source-freshness.mjs --dir <SOURCE_CYCLE_PRIVATE_DIR> --max-age-minutes 120 --expect RP004,RP006,RP012,RP023
```

## 검증(이 변경)

- `tests/source-cycle-runtime.test.ts` 「unattended hourly cycle」 4건: 계획→적용→다음 회차 변경 0, blocker 시 쓰기 0, 관측 전용 OBSERVED, CLI 옵트인·인자 가드.
- 관련 묶음과 build/arch/boundary 통과 여부는 NEXT-START-HERE 의 이 날짜 항목을 따른다.
