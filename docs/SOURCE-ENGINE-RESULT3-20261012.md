# 원천 엔진 3단계 — runtime 구현 결과 및 실행 한 장

판정: **코드·합성 시험 구현 / 라이브 캡처 적합성·운영 적용 HOLD**.
네트워크 요청, 라이브 연결 시험, 운영 쓰기, 외부 스크립트 실행, 커밋, push, 배포, schtasks 등록 모두 0.

## 목적 / 대상 revision / 정본 / 재사용

- SPEC3의 로컬 ES 모듈 `{plugins, commands, control}`과 Firestore REST 조건부 상품 반영을 연결했다. 원천을 새로 읽는 기본 실행은 DRY_RUN이다.
- 시작 HEAD `3ac8cb283209eb9ae8c12bb55c49956b8359e9ee`, 가지 `work/freepass-data/source-engine-core-20261012`. 커밋하지 않은 작업 트리 변경이다. 사용자 제공 untracked SPEC3는 수정하지 않았다.
- 정본: `SOURCE-ENGINE-SPEC3-20261012.md`, SPEC2/RESULT2, SPEC/RESULT, DESIGN-REF, 저장소 AGENTS와 stable entry guide. 최신 사용자 실행 규칙에 따라 SPEC 사전점검 영수증으로 대체했다. 원격 main/Issue/PR 및 academy/외부 AI 호출은 생략했다. Claude 독립 검토는 **UNAVAILABLE**이며 PASS가 아니다.
- 기존 `planSourceCycle`/`applySourceCycle`, `fileCycleControl`, F05 `captureSharedSheetReadOnly`와 `sharedSheetEngine`, ONE full-facts 수집기, `resolveTargetProject`, `stableDigest`를 재사용했다.
- 지정된 다른 worktree의 `exposure-apply.mjs`는 파일이 없어 읽지 못했다. 실행하지 않았다. 대체 필드 근거는 저장소의 `iancar-publication-withdrawal-firestore.ts`(특히 `원문.차명`), `buildIancarOnePublicationProducts`, 기존 합성 시험이다. 실제 상품 조회를 했다고 주장하지 않는다.
- **CREATE_NEW_JUSTIFIED**: 2단계에는 Firestore REST command 구현, 실제 transport 조합, native 캡처 매핑 및 복구 CLI가 없다. 기존 계획/제어를 복제하지 않고 아래 세 모듈과 시험/결과 문서를 추가했다. 새 Firestore 컬렉션, Firebase 앱, 차종 판정 규칙은 만들지 않았다.

## 변경 파일

| 파일 | 변경 |
|---|---|
| `src/infra/source-cycle-firestore.ts` | 명시 target, gcloud 사용자 토큰, 필요한 필드의 전체 pagination, 대상 원본 전량 백업, updateTime/exists CAS, PATCH, 깊은 되읽기, receipt, 조건부 복구 |
| `src/adapters/source-cycle-native.ts` | 차량번호 우선 UID, 최초 중복만 유지, F05 가시성·UID adapter, 아이카 A/B/C와 기간 헤더, 아이언 명시 listing envelope 매핑 |
| `src/runtime/source-cycle-runtime.ts` | 여섯 원천 조합, `{plugins, commands, control}`, 기본 DRY_RUN 및 외부 digest 적용/복구 CLI |
| `src/adapters/source-cycle-plugins.ts` | 관측 전용 표시, 행별 UID/중복 보류 사유 전달 |
| `src/jobs/source-cycle.ts`, `src/ports/source-cycle.ts` | 관측 전용 상품 명령 차단, 대수 heartbeat, 번호미배정 요약, 승인 후 최신 원천 재대조 |
| `scripts/check-data-access-boundary.mjs` | SPEC3 REST 조합 파일 한 곳을 명시 허용. 일반 API/job의 기존 제한은 유지 |
| `tests/source-cycle-runtime.test.ts` | 주입 fetch 기반 가짜 Firestore와 native 캡처 합성 회귀 |
| `docs/NEXT-START-HERE.md`, 이 문서 | 결과/실행/남은 HOLD 인계 |

## 구현 경계

- F05는 현행 정본의 **12탭/15공급사코드**를 사용한다. 같은 탭의 회사명으로 코드를 나눈다. 기존 캡처 앞뒤로 행 숨김 메타데이터와 전체 값 응답을 대조한다. 기존 74칸 밖에 명시된 UID 열만 붙인다. UID를 시트에 쓰지 않는다. 종합/숨김 탭/사용자·필터 숨김 행은 제외한다. 숨김 탭 또는 가시성 증거 부족은 불완전이며 그 공급사의 누락 하향을 하지 않는다. 출고불가 행은 판매 가능 수에서 제외하되 기존 상품의 명시 하향 근거로 보존한다.
- 번호가 있으면 문서 ID=공백 정리한 차량번호다. 번호가 없으면 실제 시트 UID만 사용한다. 없으면 `UID_REQUIRED` 및 `번호미배정 N`; 행 번호는 추적 정보에만 쓴다. 중복은 최초 행만 유지하고 후속 행을 `DUPLICATE_UID_SUSPECT`로 보류한다. UID/중복 HOLD가 있으면 누락 하향을 하지 않는다. 다른 공급사가 동일 문서 ID를 점유하면 쓰기 전에 중단한다.
- 아이카는 A 배차상태/B 구분/C 차량번호 헤더를 검사한다. `N개월`, `N개월 보증금` 또는 `보증금`, `연주행`, `차명 원문` 또는 `차명`, 선택 `UID`로 읽는다. 숫자는 원 단위 숫자 셀, 무보증은 ZERO, 빈칸/해석 불명은 UNKNOWN이다. 월렌트는 `product_group=MONTHLY`로 분리하고 원본 탭/행을 남긴다. 실제 헤더가 다르면 추정하지 않고 HOLD다.
- ONE은 기존 full-facts collector를 직접 사용하며 키는 `EANCAR_ONE_API_KEY`로만 받는다. AVAILABLE/PREPARING과 plate UID를 적용한다. API의 자체 vehicleId는 RAW에 남는다. 기간별 복수 주행조건은 기존 표준 타입의 중복기간 HOLD를 그대로 유지하며 임의 요금 하나를 선택하지 않는다.
- 손오공 RP012(`source=sonokong`)과 오토플러스 RP023(`source=website`)는 현재 products만 관측한다. 상품 계획/백업/쓰기 호출 없이 대수 heartbeat만 남기고, REST command/복구에도 해당 공급사 쓰기 금지 방어가 있다. 이 관측은 **기존 수집 결과 조회 시점**이지 공급사의 원천 갱신 시각이 아니다.
- 아이언은 환경변수로 받은 `https://ironrentcar.com` 목록을 GET하며 명시적인 `__NEXT_DATA__.props.pageProps`의 `vehicles`, `total`, `hasNextPage=false`가 입증된 경우만 전량으로 인정한다. 레코드는 `published`, `car_number`, `car_name`, `price{기간:{rent,deposit,mileage}}`를 요구한다. **이 listing 형식의 실제 홈페이지 일치는 로컬 자료로 확인되지 않았다.** 다른 형태의 HTML을 판매0으로 처리하지 않고 `IRON_LIST_SCHEMA_HOLD`/`IRON_LIST_COVERAGE_HOLD`로 중단한다. 기존 상세 HTML parser는 전량 목록 증거를 제공하지 못하므로 억지로 재사용하지 않았다.
- 신규 상품은 호환 칸 `car_number`, `provider_company_code`, `price`, `status/status_kind/vehicle_status`, `listable`, `source`, `원문.차명`, 추적 칸을 쓴다. 차종 4칸은 비우고 확인 필요 표식을 붙인다. 기존 차종/원문/무관 필드는 PATCH mask 밖에 남긴다. 하향은 기존 가격 맵의 alias/UNKNOWN까지 보존한다.
- 백업은 `~/.codex/private/source-cycle/backups` 기본 경로에 원본 **전체 Firestore fields/updateTime**와 envelope를 불변 생성한다. Windows 운영 폴더 ACL은 연결 담당이 확인해야 한다. 백업 검증 후에도 현재 원본·계약락을 다시 확인하고 CAS한다. 신규는 `currentDocument.exists=false`다. 가격 맵 순서만 달라지면 통과하고 실제 차이는 중단한다. 쓰기/되읽기 불확실은 `APPLY_UNCERTAIN`이며 자동 재시도하지 않는다.
- 승인 후에는 원천을 다시 읽고 내용/완전성/보류 수를 대조한다. 관측 시각만 달라진 경우 승인 계획의 시각을 유지해 기존 TTL을 검사한다. `synced_at`이나 조건이 바뀌면 재계획한다. 승인은 코드에서 만들지 않는다.
- heartbeat와 실패3회 정지/잠금은 비공개 로컬 파일에 남긴다. 기존 source_runs writer를 새로 열지 않았다. Firestore heartbeat 연계나 클라우드 영속 제어가 완료됐다고 표현하지 않는다.

## 시험 / 검증

- 신규 **37/37 PASS**. 관련 9파일 **265/265 PASS**(신규37 + 사이클41 + 골격24 + F05 capture18 + capture job4 + retry3 + canonical111 + supplier layer10 + source intake17).
- 가짜 Firestore: 조건부 쓰기 충돌, 백업 시점 drift, 완전 원본 백업/변조 검출, 키순서 무관 되읽기, 가격/노출 실제 불일치, 계약락 사전/경합, 타공급사 UID 충돌, pagination loop, HTTP403/429/503, 관측 전용 무쓰기, 신규/하향/재노출/조건갱신/멱등, 승인 복구·신규 복구의 비삭제 확인.
- native 합성: 첫 UID 중복, 번호미배정 HOLD와 누락 하향 방어, 사용자/필터 숨김, 숨김 탭, 아이카 헤더/상품군, 아이언 목록 완전성, 최신 원천 재대조.
- 확장 ONE 시험 **97/99 PASS, 2 FAIL**. 두 CLI subprocess는 기존 RESULT2와 동일하게 tsx 초기화의 `uv_os_get_passwd ENOMEM`으로 exit1이었다. 로직 진입 전 실패이며 테스트/환경을 우회 수정하지 않았다. 합산 **362 PASS / 2 FAIL**, 전체 저장소 시험은 미실행이다.
- build, architecture, data-access-boundary, `git diff --check` PASS. 변경10파일 UTF-8 strict decode 및 신규 파일 공백 검사 PASS. 마지막 runtime 회귀37/37 재실행 PASS.
- 외부 원천/Firestore/ERP5/F01 실측 수치와 공급사 간 UID 집합 일치: **UNKNOWN**. 운영 persistence/deployment/cutover 검증 없음.

## 실행 명령 한 장 — 연결 담당용, 이번에는 실행하지 않음

환경변수 이름(값/ID/키는 저장소에 기록하지 않음):

`FIREBASE_PROJECT_ID`, `NODE_ENV`, `SOURCE_CYCLE_SOURCES`, `SOURCE_CYCLE_PRIVATE_DIR`, `SOURCE_CYCLE_MAX_DOWNGRADE_RATIO`, `SOURCE_CYCLE_F05_SHEET_ID`, `SOURCE_CYCLE_AICA_SHEET_ID`, `SOURCE_CYCLE_IRON_LIST_URL`, `EANCAR_ONE_API_KEY`, `EANCAR_ONE_API_BASE_URL`, `EANCAR_ONE_API_TIMEOUT_MS`, `SOURCE_CYCLE_APPROVED_DIGEST`.

기존 F05 read-only 수집기 인증에 해당할 때만: `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_SHEETS_APPLICATION_CREDENTIALS`, `GOOGLE_SHEETS_SUBJECT`.

`SOURCE_CYCLE_SOURCES`는 `F05,AICA,IANCAR,IRON,SONOGONG,AUTOPLUS` 중 연결할 항목을 쉼표로 지정한다. Firestore/visibility/아이카 GET은 기존 gcloud 사용자 로그인 토큰을 사용하며, F05 값 캡처는 기존 Sheets reader 인증 경로를 유지한다. 새 로그인/키 저장은 하지 않는다.

```powershell
# 오프라인 검증
npm.cmd run build
npm.cmd test -- --run tests/source-cycle-runtime.test.ts tests/source-cycle.test.ts tests/source-engine.test.ts

# 라이브 읽기 dry-run: 아래부터는 연결 담당이 명시 환경 설정 후 실행
# plan은 개인정보가 있는 비공개 폴더 경로. 같은 파일을 덮어쓰지 않는다.
node dist/src/runtime/source-cycle-runtime.js --source <공급사코드> --plan <비공개-plan.json>

# 검토받은 plan digest를 SOURCE_CYCLE_APPROVED_DIGEST에 외부 입력한 뒤
node dist/src/runtime/source-cycle-runtime.js --source <공급사코드> --plan <비공개-plan.json> --apply

# 기존 2단계 runner의 ES-module 계약으로도 DRY_RUN 가능
node dist/src/jobs/source-cycle.js --runtime dist/src/runtime/source-cycle-runtime.js --source RP031 --only-when-synced

# 복구 대상 key는 비공개 *.backup.json의 key. 먼저 복구 digest 출력만
node dist/src/runtime/source-cycle-runtime.js --rollback <backup-key>
# 출력 digest를 외부 승인받아 SOURCE_CYCLE_APPROVED_DIGEST에 입력한 뒤
node dist/src/runtime/source-cycle-runtime.js --rollback <backup-key> --apply
```

복구는 성공 receipt와 현재 문서가 정확히 일치하고 계약락이 없을 때만 실행한다. 기존 상품은 원본 필드를 복원하고 신규 편입은 삭제 대신 노출 하향한다. 복구 직전 원본도 별도 백업하고 되읽는다. 불확실 회차에는 성공 receipt가 없을 수 있으므로 위 명령을 무작정 재시도하지 않고 현재 상태와 백업부터 대조한다.

15분 예약 등록/제거 스크립트는 2단계 것을 재사용한다. 실제 등록하지 않았으며 예약 runner는 DRY_RUN이다. 매15분 자동 적용에 필요한 회차별 외부 승인 공급/작성자 통제는 별도 운영 연결이다.

## 남은 일 / next_start_here

1. 지휘통제실이 이 작업 트리 diff와 SPEC3를 검토/커밋한다. 시작 revision과 변경 파일을 기준으로 확인한다.
2. 연결 담당이 비공개 실캡처로 아이카 실제 헤더/원 단위, 아이언 listing 형식과 완전성, F05 UID 열/rowMetadata 반환, ONE 동일기간 복수주행조건 및 과거 vehicleId 문서 이행을 확인한다. 실제 형식이 다르면 해당 매핑만 보완하고 합성 회귀를 추가한다. 임의 신규 키/요금 선택 금지.
3. 정상 subprocess 환경에서 기존 ONE 실패2를 재검증하고 독립 검토를 받는다. Windows gcloud 명령/개인폴더 ACL, 실제 updateTime precondition과 되읽기는 연결 담당이 검증한다.
4. 승인된 회차의 원천 UID 집합·프리패스 데이터·ERP5 대조, source freshness/관측 시각 구분, 기존 작성자와 동시 적용 금지, 예약 적용 승인을 연결한다. 기존 코드는 이 단계들을 증명하지 않는다.

`next_start_here`: SPEC3 → 이 문서 → `tests/source-cycle-runtime.test.ts` → `src/runtime/source-cycle-runtime.ts`. 먼저 비공개 dry-run을 확인하고, 실측 전에는 운영 완료로 보고하지 않는다.
