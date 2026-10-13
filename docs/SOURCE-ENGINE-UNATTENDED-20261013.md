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

## 이안카 적용에서 드러난 구조 보강(2026-10-13 실측)

- **항 식별**: 이안카 ONE 은 개월마다 약정거리 옵션을 여럿 준다. 항 식별자는 (개월, 약정거리). 원천 기록에는 옵션 전부, 판매 가격 칸에는 개월 키 하나(대표 항 = 연 환산 약정거리가 가장 작은 기본 옵션)와 소비처가 읽는 옵션 키(`{개월}_월{N}km`·`{개월}_연{N}km`, 값 {rent, deposit})를 함께 쓴다. 단일 항 원천은 옵션 키를 만들지 않는다. 옵션 키가 빠진 노출 문서는 한 번 다시 쓴다.
- **문서 ID 가 다른 같은 차량**: 같은 공급사·같은 차량번호 문서가 정확히 하나이면 새 문서를 만들지 않고 그 문서를 갱신한다(`UID_BRIDGED`). 문서 ID 는 옮기지 않는다.
- **문서 크기**: 문서에는 압축 레코드만 저장하고(큰 원문 값은 digest), 쓰기 전에 문서 크기를 점검해 한도(1MiB)에 가까운 쓰기가 있으면 계획 전체를 막는다(`DOC_TOO_LARGE`, 백업·쓰기 전).
- **상류 정지**: 공급사 원천이 갱신되지 않은 것(`UPSTREAM_STALE`)은 우리 쪽 실패가 아니다. 쓰기 0, 연속 실패로 세지 않고 정지하지 않으며 신선도는 ERROR 로 보인다. 불완전 사유는 알림에 `INCOMPLETE_<사유>` 로 남는다.
- **대표 지시로 내린 공급사**: `contracts/withdrawn-suppliers.v1.json`. 엔진이 매 회차 그 공급사의 노출 문서를 `DECISION_WITHDRAWN` 으로 내려 재노출을 막는다. `scripts/exposure-apply.mjs --approved-unsellable-supplier`(#573)는 같은 목적의 일회성 수동 도구이고, 이 목록에 있는 공급사는 엔진이 계속 유지한다.

## 운영 주의(B3Q 등록 실측 2026-10-13)

- 작업은 Interactive 로그온 형식이라 계정이 로그온(잠금 포함) 상태일 때만 돈다. 완전 로그오프·재부팅 뒤 자동 로그온이 없으면 정지한다. B3Q 는 AI 전용 상시 PC 이므로 자동 로그온을 유지한다.
- 예약 실행기는 이 가지의 작업 폴더 경로를 가리킨다. 가지가 main 에 합쳐지면 작업 경로를 main 체크아웃으로 옮기고(`unregister` → `register -Register`), 작업 폴더를 지우지 않는다.
- 이번 등록에서 제외한 원천(이안카·아이언)은 회차에서 읽지 않고 신선도 판정에도 들어가지 않는다. 별도 건으로 추적해 되살리는 때 `SOURCE_CYCLE_SOURCES` 에 다시 넣는다.
- 보정 허용(`-AcceptDrift`)으로 통과한 문서는 값이 원천과 같아도 한 번 다시 써서 저장 digest 를 맞춘다. 이후 같은 코드에서 DRIFT 가 또 나오면 다른 쓰기 주체가 price 를 바꾼 것이므로 영구 허용하지 말고 건수와 차이 필드를 보고한다.

## 책임·보고(대표 10-13 「데이터 원천 신선하게 erp5에 반영되게 확실하게 관리해」)

PLN DATA 유지보수가 관리 책임자(ai-ops 결정 장부 «원천 엔진 신선도 감시»). B3Q DEV 는 UNHEALTHY 면 원인 코드와 함께 즉시 커맨드 센터에 올리고, 정상이어도 하루 두 번 `freshness` 요약을 보고한다. 판단은 기억이 아니라 `unattended-runs.jsonl` 과 ERP5 되읽기 근거로만 한다.

## 검증(이 변경)

- `tests/source-freshness.test.ts`(신선도 판정·사전점검·기록·CLI 가드), `tests/source-cycle-runtime.test.ts` 「unattended hourly cycle」, `tests/source-cycle.test.ts` 가드 보강 시험.
- 관련 묶음과 build/arch/boundary 통과 여부는 NEXT-START-HERE 의 이 날짜 항목을 따른다.

## 이안카 상류 갱신 주기 변화와 예약 분 이동(2026-10-14 승인: 커맨드 센터)

- 근거(B3Q 실측 2026-10-13): ONE 목록 syncedAt 이 08:44:27Z·08:59:43Z·09:15:04Z(15분 간격) 뒤 정지했다가 14:51:45Z·15:52:43Z(약 60분 간격)로 재개됐다. 상류 갱신 주기가 15분에서 약 60분으로 바뀐 것이다.
- 증상: 엔진이 매시 :25 에 돌아 상류 갱신 33~34분 뒤라 `IANCAR_ONE_SOURCE_FRESHNESS_EXCEEDED`(임계 15분, 대표 정책)가 항상 발생해 RP031 이 `UPSTREAM_STALE`(쓰기 0, 연속 실패 아님)로 STALE 이 된다. 적용 데이터에는 영향이 없고 신선도 점검만 UNHEALTHY 로 보인다.
- 결정: 임계(15분)는 유지하고 예약 시작 분을 :25 → :00 으로 옮겼다(B3Q 실측: 회차 안에서 RP031 읽기는 시작 + 약 3.7분이라 :00 시작이면 상류 갱신 :51~:58 뒤 약 10~12분, :05 시작이면 15~16분으로 임계 초과 가능; 승인 범위 :05~:08 에서 벗어나 :00 을 택한 근거). ERP4 풀 회차(cron :17)와는 4분 회차라 겹치지 않는다. 임계 상향(75분)은 신선도 의미가 약해져 택하지 않는다.
- 되돌림: 이전 등록값(시작 :25, -IntervalMinutes 60)은 B3Q 가 옮기기 전에 기록한다. 상류가 15분 주기로 복구되면 :05 도 그대로 유효하다.
- 공급사 직접 문의는 하지 않는다. 지속될 때만 09:00 KST 이후 별도 판단.

## 엔진 변경 시험 체크리스트(실데이터 계획 확인)

- 모의 시험은 필드 마스크·실제 문서 모양·대량 데이터를 놓친다(2026-10-14 statusKindStale 판정이 마스크에 없는 필드를 읽어 두 번 0건으로 통과). 쓰기 경로를 바꾸는 엔진 수정은 갱신 후 첫 회차를 쓰기 전에 **실데이터 계획(plan, DRY_RUN) 출력만 먼저 확인**한다. 기대한 건수·대상 필드와 맞을 때만 쓰기를 진행하고, 기대한 변경이 0건이면 쓰지 말고 보고한다.
- 목록 읽기 필드 마스크(source-cycle-firestore.ts 의 list)에 없는 필드를 읽는 판정을 추가하면 마스크도 함께 고친다. 시험 모의는 마스크를 실제처럼 적용한다.

## 손오공·오토플러스 신선도 근거(2026-10-14, 커맨드 센터 요청)

- ERP4 는 바뀐 문서만 쓰므로 문서 updateTime 은 수집 성공 시각이 아니다. 관측 어댑터는 ERP4 풀 회차의 «원천에서 ERP5 현재 원자 계산» 단계가 마지막으로 success 였던 시각(GitHub REST jobs.steps.completed_at)과 문서 시각 중 더 최근 값을 관측 시각으로 쓴다. 발행 단계 실패와 무관하고, 이안카 전용 회차(단계 skipped)는 제외된다.
- 켜는 법: 환경값 SOURCE_CYCLE_ERP4_REPO=owner/repo (인증된 gh CLI 필요, 읽기 전용, 회차당 최대 9회 호출). 없거나 gh 가 실패하면 문서 시각으로 되돌아가며 신선해 «보이게» 하는 방향으로는 폴백하지 않는다.
- 임시 오탐 표기 SOURCE_CYCLE_STALE_FALSE_POSITIVE=RP012,RP023 은 이 근거가 반영되면 비운다.

## 오토플러스 홈피 관측 병행 (2026-10-14, 대표 확정: 오토플러스 = 홈피 정본)

- 어댑터: `src/adapters/autoplus-homepage.ts` — 사이트맵 전수(렌트 상품 URL) → 상품별 세션 부트스트랩 → 상세 POST, 직렬·150ms·토큰 1020 재시도 4회. 상태 신호는 «사이트맵에 있음 = 게시 중» 뿐이고 보증금은 응답에 없다(UNKNOWN).
- 켜는 법(관측 병행, 쓰기 0): 환경값 SOURCE_CYCLE_AUTOPLUS_HOMEPAGE_REPORT=<보고 파일 경로>. 오토플러스 관측 회차에서 홈피 전수를 읽어 Firestore RP023 문서와 번호 기준으로 비교한 요약(건수·끝 4자리·실패 코드)을 그 파일에 쓴다. 실패는 회차에 영향이 없다.
- 쓰기 전환 전 결정 필요: ① 보증금 규칙(시트 경로는 대여료 × 국산 2·수입 3, 홈피 응답에는 없음) ② 계약중·출고협의 신호가 홈피에 없음(게시 여부만) ③ 시트 경로 문서와의 이중 쓰기 정리(ERP4 오플 시트 수집 중단 시점) ④ 가격 없는 행 처리.
