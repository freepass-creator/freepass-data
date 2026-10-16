# 원천 엔진 1단계 결과

판정: **골격 CODED / 관련 시험 TESTED, 실데이터·운영 이식·커밋 미완료**.

정본: SOURCE-ENGINE-SPEC-20261012.md 및 DESIGN-REF 사본. 시작 revision `62906b2f2cc997aaba7dde2f1c6cdce2d08b1d93` (지시서에 명시된 main 기반 위 문서 커밋), 작업선 `work/freepass-data/source-engine-core-20261012`. 시작 작업 트리는 clean. 네트워크/운영 쓰기/push 없음.

## 재사용 판정 (편집 전)

- 로컬 package.json, src/jobs/capture-shared-sheet.ts, ingest-shared-sheet-canonical.ts, adapters/shared-sheet-source.ts, normalize-shared-sheet.ts, domain/source.ts, ports/source-store.ts, infra/firestore-layout.ts 검색·검토.
- CREATE_NEW_JUSTIFIED: 공급사 상품 UID·분리된 검증 영역·읽기 시각 만료를 함께 표현하는 공통 엔진 계약은 없음. 기존 수집/정제 함수를 감싸는 domain 계약, F05 adapter, 반영 orchestration 및 회귀시험만 추가. 기존 정제/차종 정책과 Firestore 작성자를 복제하지 않음.
- 하트비트는 기존 source_runs의 시작/관측/완료/오류/건수 및 source_heads를 읽어 투영. 새 컬렉션/영속 경로 불필요. 새 attempted-run 기록도 기존 SourceIngestionStore lifecycle만 사용.
- 현재 74열 규격에는 UID 칸이 없음. UID 없는 행은 UID_REQUIRED로 보류하며 행번호나 차량번호로 UID를 발급하지 않음. 새 adapter는 명시적 UID 열이 있는 캡처를 받아 기존 74열 정제기에 연결. 라이브 열 추가/기존 바인딩 전환은 별도 작업.
- 외부 academy/Claude 호출은 사용자 오프라인 지시와 사전점검 영수증으로 생략. 독립 검토 UNAVAILABLE, PASS 아님.

## 변경 파일

| 파일 | 변경 |
| --- | --- |
| src/domain/source-engine.ts | 표준 상품/기간별 KNOWN·ZERO·UNKNOWN/원문, 읽기 완전성 계약, 런타임 검증, 설정 가능한 만료 순수 함수, 기존 source_runs 기반 heartbeat 조회 투영 |
| src/adapters/shared-sheet-engine.ts | 기존 buildSharedSheetBatch/normalizeSharedSheet/status/deposit 정책을 감싸는 UID 기반 adapter. UID 없는 행만 보류, 동일 차량번호는 중복 의심 표시, 신차는 null plate로 별도 UID 유지 |
| src/application/source-engine.ts | 기본 쓰기0 계획·digest, 행 검증 격리, 기존 상품 차종 HOLD와 조건 갱신 분리, 신규 미확정 차종 보류, 판매불가 우선, 만료·역순·중복 방어, 승인 digest/원본 백업 확인/CAS 명령/되읽기 orchestration |
| src/jobs/source-engine-shared-sheet.ts | 오프라인 캡처 시험 실행, 기존 canonical planner 재사용, 원천 상태 건수와 UID·조건·차종 HOLD 구분, 103 기준 및 공급사별 차이 출력, 외부 승인 환경변수 경계 |
| src/jobs/capture-shared-sheet.ts | 기존 읽기 transport를 captureSharedSheetReadOnly로 추출하여 재사용. 재시도·serial 전후 대조 동작 유지 |
| src/jobs/ingest-shared-sheet-canonical.ts | CLI 오류 시 stdout에 구조화된 HOLD JSON을 남김. 원문/오류 상세는 출력하지 않음 |
| tests/source-engine.test.ts | 신규 합성 회귀 24개 |
| docs/NEXT-START-HERE.md, 이 문서 | 현재 작업 결과·제약·후속 시작점 |

## 검증

- 최종 관련 검사 **170/170 PASS** (6파일): 신규 24, shared-sheet-canonical 111, capture retry 3, capture job 4, capture adapter 18, supplier layer 10.
- `npm.cmd run build`, `check:arch`, `check:data-access-boundary`, `git diff --check`: PASS.
- 전체 Vitest: **3171 PASS / 20 FAIL / 18 SKIP, 총 3209**. 이후 validator 악성 입력 시험 1개를 추가하고 관련 170개를 재검사했다. 최종 전체 재실행은 하지 않았으며 전체 PASS로 표현하지 않는다.
- 전체 실패 9파일에는 tsx 초기화의 `uv_os_get_passwd ENOMEM`, Bash 임시 경로·jq 실행 권한 거부, 5초 timeout, 로컬 dev 서버 ECONNREFUSED가 포함됨. 이 결과는 해당 플랫폼 시험 미통과이며 원격 CI에서 재검증 필요. 실패를 임의 skip하거나 의존 패키지를 바꾸지 않았다.
- HOLD JSON: 기존 catch가 stderr만 쓰고, workflow apply 단계가 실패 exit 뒤에도 빈 apply.json을 JSON.parse하는 경로를 코드로 확인. 새 CLI wrapper 회귀 PASS. 빌드 산출물 `node dist/src/jobs/ingest-shared-sheet-canonical.js --apply`도 exit1과 유효한 HOLD JSON 확인. 온라인 로그 원문은 보지 않았으므로 실제 회차의 최초 HOLD 원인 확정은 아님. 모듈 로더 자체 실패까지 CLI catch가 처리한다고 보장하지 않음.
- 합성 사례: 6774 대응 무보증 ZERO를 이전 150만원보다 우선하는 갱신(차종 HOLD 유지); 신차 4개 UID; 8320 대응 합성 중복번호 2줄 보존·중복 의심; unknown 보증금/불완전 기간 묶음/429/403/헤더 오류/미관측 보존/만료/역순/백업·되읽기 오류/행별 실패 격리.
- 실행 테스트는 메모리 command adapter를 사용한다. **실제 Firestore persistence·ERP5·카톡 반영 증거가 아니다.**

## 실데이터 시험 실행 숫자

**BLOCKED_NETWORK: 최신 F05 읽기 전용 캡처 및 동일 시점 Firestore 정본 조회 필요.** 저장소 내 실제 캡처는 찾지 못했으며 외부 연결을 시도하지 않았다. 실제 관측 건수는 **UNKNOWN(null)**, 0 또는 103 PASS가 아니다.

지시서 기준만 보존: 빌린카30·우리캐피탈13·스타13·KH11·경진9·웰릭스6·제이앤제이6·에코5·렌트존4·리더스3·센트로2·퍼시픽1 = 103. 이번 실제 공급사별 건수는 모두 미검증. 이 기준은 캡처 시각과 UID 집합의 일치를 증명하지 않는다.

오프라인 도구 예: 빌드 후 `node dist/src/jobs/source-engine-shared-sheet.js --capture <비공개 로컬 capture.json>`.
기존 canonical planner가 참조하는 F04 환경 설정도 필요하며, 없으면 구조화된 HOLD로 종료한다. 운영 ID를 시험값으로 대체해서 실데이터 대조 PASS를 만들지 않는다. CLI는 수치/보류 사유만 출력하고 원문 파일을 생성하지 않는다.

## 남은 일 / 적용 경계

1. 현재 live capture 범위는 기존 74열이다. UID 열의 실제 위치·규격·읽기 범위가 아직 연결되지 않았으며, adapter의 추가 UID 열 지원은 오프라인 계약 시험대다. 실제 열 추가나 사람 시트 쓰기를 하지 않았다. 기존 plate 기반 source binding에서 UID로의 대조·이행은 미완료.
2. `SourceRecordCommands`는 기존 CatalogStore의 트랜잭션·작성자·명령 영수증·감사에 연결할 **명령 경계**다. 실제 Firestore adapter는 미연결이며 메모리 합성 시험만 수행했다. 기존 canonical planner/write CLI를 이 새 경계로 자동 전환하지 않았다. 따라서 기존 운영 경로의 차종 HOLD를 모두 해소하거나 실제 보증금을 갱신했다는 의미가 아니다.
3. 새 F05 adapter는 차종을 추정하지 않고 `VEHICLE_MASTER_REVIEW_REQUIRED`를 유지한다. 실제 sealed master 판정 결과 연결과 차종 확인 동선(소비처)은 후속 작업. 기존 상품의 독립 조건 갱신은 command 시험으로 확인했다.
4. heartbeat는 기존 SourceRun 기록을 원천별로 투영하는 함수다. 별도 컬렉션/자동 기록기를 생성하지 않았다. 각 엔진 실행이 기존 SourceIngestionStore begin/complete/fail lifecycle에 연결되고 소비자가 해당 런을 공급해야 실제 감시가 된다. ERP5·카톡 만료 호출 및 다른 공급사 adapter 연결도 다음 단계.
5. 독립 Claude 검토 UNAVAILABLE. 전체 환경 의존 시험 실패 해소 및 원격 검증은 미완료. 배포·소비처 cutover·운영 쓰기 모두 0.

## 커밋 / next_start_here

**BLOCKED_FILESYSTEM: 로컬 커밋 실패.** `git add`와 `git commit` 모두 실제 Git metadata 경로 `C:/dev/freepass-data/.git/worktrees/fd-engine/index.lock` 생성 권한 거부로 실패했다. 현재 허용 쓰기 경로는 `C:/dev/fd-engine`이며 다른 경로의 권한을 바꾸거나 우회하지 않았다. 신규 커밋 없음; 변경은 작업 트리에 보존됨.

다음 담당은 이 문서와 최종 diff를 읽고 허용된 Git metadata 환경에서 변경 9파일을 커밋한다. 이어서 UID 실제 캡처·기존 binding 이행 계약을 고정 → 기존 CatalogStore command adapter 연결/백업·영수증 회귀 → 최신 F05 read-only 캡처와 UID 집합·103 기준 대조 → 독립 검토/환경 시험 재실행. 운영 적용·push·PR은 이 작업에서 하지 않는다.
