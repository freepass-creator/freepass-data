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
#   $env:SHEETS_TRANSPORT='gws'; $env:GWS_BIN='<gws.exe 절대경로>'   # F05 캡처(shared-sheet-capture-reader)는 SHEETS_TRANSPORT=gws 일 때만 gws 로 읽는다 — 없으면 토큰 경로로 가서 AUTH_FAILED. 예약 환경엔 PATH 에 gws 가 없을 수 있어 GWS_BIN 절대경로(10-13 B3Q 실측)
#   $env:EANCAR_ONE_API_KEY 는 파일에 적지 말고 실행 시 Secret Manager 에서 읽는다(gcloud secrets versions access). 아이카 가격 보정은 실행기 -AcceptDrift RP004
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

## 계획 가드 보강(Codex 상의 2026-10-13, 실사고 근거)

- **보증금 UNKNOWN 보존**: 원천 보증금이 UNKNOWN(빈칸·해석 불가)이면 확인된 원천 값이 아니므로, 같은 개월의 기존 KNOWN/ZERO 보증금을 덮지 않는다(저장소 불변식 «unknown/null 은 마지막 정상값 보존»). 대여료·ZERO·KNOWN 은 원천 값 그대로. 계획 경고 `DEPOSIT_PRESERVED:n`. 신규 편입은 해당 없음. 근거 사고: 보정 허용 수동 회차에서 RP013 2문서 12개월 보증금이 null 로 쓰여 백업 롤백으로 복구함.
- **하향 비율 사유 분리**: 런타임 기본 절대 개수 하한 3(`SOURCE_CYCLE_DOWNGRADE_FLOOR`, 0 이면 옛 합산 비율). 부재 추론(SOURCE_ABSENT)은 비율 초과 AND 하한 초과일 때만, 시트가 명시한 불가·계약중은 max(상한, 0.5) 초과 AND 하한 초과일 때만 차단. 소규모 공급사의 정당한 상태 변경이 회차 전체를 막지 않고, 대량 부재·상태 열 오매핑은 계속 막는다.
- **일회성 구조적 대량 하향(예: 이안카 기존 301 vs 원천 110)**: 상한 임시 상향·단계적 하향 금지. 수동 경로로 계획을 만들어 하향 대상 목록(원천 완전성·UID 대응)을 검토하고 그 계획 digest 로 한 번 적용한다(백업·CAS 유지, 적용 직전 재계획).
- **accept-drift 는 영구 설정이 아니다**: price 를 쓰는 다른 주체를 확인하고 단일 쓰기 경로로 고정한 뒤 특정 코드·회차에만 한시적으로 쓴다.

## 신선도 감시(대표 10-13 「데이터 원천 신선하게 erp5에 반영되게 확실하게 관리해」)

## 한 회차의 흐름(코드 한 곳: `runUnattended`, src/runtime/source-cycle-runtime.ts)

1. **사전점검**: 시트 원천이면 gws 경로(`resolveGwsBin` 단일 규칙), F05 면 `SHEETS_TRANSPORT=gws`, 항상 gcloud 사용자 토큰. 하나라도 없으면 회차를 돌리지 않고 `PREFLIGHT_*` 코드 + 알림(RUNNER) + 실행 기록 한 줄, 종료 코드 1 — 원천별 AUTH_FAILED 3회 정지를 막는다.
2. **원천별 계획→적용**: `runUnattendedSourceCycle`(기존 승인 경로 재사용, blockers·백업·CAS·되읽기·3회 정지 그대로).
3. **신선도 판정**: `assessFreshness`(src/application/source-freshness.ts, 순수). heartbeats·alerts 만 읽어 원천별 마지막 정상 완료 나이 기본 120분 초과(STALE)·STOPPED·ERROR·NEVER_COMPLETED·MISSING 이면 UNHEALTHY.
4. **실행 기록**: `unattended-runs.jsonl` 한 줄(preflight·reports·freshness·exit). 종료 코드 1 이면 작업 스케줄러 「마지막 실행 결과」로 바로 보인다. 토큰·원문은 기록하지 않는다.

`run-source-cycle.ps1` 은 환경 파일을 읽어 node 를 부르고 종료 코드를 전달할 뿐이다.

## 책임·보고(대표 10-13 「데이터 원천 신선하게 erp5에 반영되게 확실하게 관리해」)

PLN DATA 유지보수가 관리 책임자(ai-ops 결정 장부 «원천 엔진 신선도 감시»). B3Q DEV 는 UNHEALTHY 면 원인 코드와 함께 즉시 커맨드 센터에 올리고, 정상이어도 하루 두 번 `freshness` 요약을 보고한다. 판단은 기억이 아니라 `unattended-runs.jsonl` 과 ERP5 되읽기 근거로만 한다.

## 검증(이 변경)

- `tests/source-freshness.test.ts`(신선도 판정·사전점검·기록·CLI 가드), `tests/source-cycle-runtime.test.ts` 「unattended hourly cycle」, `tests/source-cycle.test.ts` 가드 보강 시험.
- 관련 묶음과 build/arch/boundary 통과 여부는 NEXT-START-HERE 의 이 날짜 항목을 따른다.
