# 원천 엔진 2단계 결과 — 반복 사이클

판정: **사이클 코드·오프라인 시험 구현 / 운영 연결·실측 HOLD**. 네트워크 요청, 운영 상품 쓰기, 배포, push, 스케줄러 등록·제거, 커밋 모두 0.

## 목적 / 대상 revision / 정본

- 목적: 원천 UID 기준으로 매 회차 하향·신규 편입·재노출·기간별 조건 갱신을 계획하고, 승인된 계획만 백업/CAS/되읽기로 반영하는 반복 실행 경계.
- 시작 HEAD: `91eff5ee57799e6d88d0638245bd00d5c259884d`, 가지 `work/freepass-data/source-engine-core-20261012`. 이번 신규 커밋 없음. 시작 시 사용자 제공 SPEC2만 untracked였으며 그대로 보존했다.
- 정본: `SOURCE-ENGINE-SPEC2-20261012.md`, 이전 SPEC·DESIGN-REF·RESULT. 사용자 실행 규칙에 따라 SPEC 사전점검 영수증으로 갈음했다. 원격 main/Issue/PR 재조회, academy, Claude 호출은 하지 않았다. 독립 검토 **UNAVAILABLE**, PASS 아님.
- 위험: 조건/공개 보류를 다루는 적용 코드는 고위험 경계로 설계하고 합성 메모리에서만 실행했다. 이번 변경은 코드·시험·문서 범위이며 운영 승인이 아니다.

## 재사용 판정

1. 1단계 `domain/source-engine.ts`의 표준 레코드·UID 키·검증·신선도와 `stableDigest`를 재사용. F05는 기존 `sharedSheetEngine` → `normalizeSharedSheet`를 직접 감싼다. 별도 차종 판정·금액 추정기를 만들지 않았다.
2. 지정된 읽기 전용 worktree의 `sellable-count.mjs`, `sellable-lib.mjs`, `exposure-apply.mjs`, `supplier-freshness-lib.mjs`를 검토했다. 숨김 행/탭 배제, 원천별 판정, 계약 잠금, withdrawal/prior, 전량 백업·조건부 쓰기·되읽기를 TypeScript 경계로 옮겼다. 해당 worktree는 수정하지 않았다.
3. 참고 도구의 차량번호 집합 대조는 UID 계약에 맞지 않아 이전하지 않았다. 가격 맵의 `JSON.stringify` 비교도 이전하지 않고 기존 정렬 digest를 이용한 깊은 비교로 대체했다. 배열 순서는 유지한다.
4. **CREATE_NEW_JUSTIFIED**: 기존 1단계 반영기는 관측된 개별 상품만 처리하며 전체 원천 대조·계약잠금 envelope·누락 하향 상한·반복 제어 상태·예약 명령이 없다. 따라서 공통 타입은 ports, 새 사이클 계획/적용은 application, 원천/제어 연결은 adapters, 실행 조합은 jobs에 추가했다. 새로운 Firestore 컬렉션·대체 Canonical 저장소·두 번째 Firebase 앱은 없다.

## 변경 파일

| 파일 | 구현 |
| --- | --- |
| `src/ports/source-cycle.ts` | 상품/withdrawal/계약잠금 envelope, 원천 완전성, 계획·제어 상태·명령 포트 |
| `src/application/source-cycle.ts` | UID 대조, 네 가지 변경, 하향 상한, 승인 digest, 재계획 검사, 전체 백업 검증, CAS·깊은 되읽기 |
| `src/adapters/source-cycle-plugins.ts` | 설정형 여섯 원천 플러그인, F05 기존 변환기 연결, ONE full-facts 변환, 가시성/수집 범위 검사 |
| `src/adapters/source-cycle-control.ts` | 원천별 배타 파일 잠금, 원자 상태 저장, 로컬 알림, 기존 SourceIngestionStore heartbeat 연결 |
| `src/jobs/source-cycle.ts` | 단일 회차/원천별 순차 실행, 3회 실패 정지, synced_at 감지, 기본 DRY_RUN CLI·오프라인 snapshot 모드 |
| `scripts/register-source-cycle.ps1` | Windows 15분 예약 등록 명령. 기본 출력만, 명시적 `-Register` 때만 schtasks 실행 |
| `scripts/unregister-source-cycle.ps1` | 기본 출력만, 명시적 `-Remove` 때만 지정 task 제거 |
| `tests/source-cycle.test.ts` | 합성 회귀 41개 |
| `docs/NEXT-START-HERE.md`, 이 문서 | revision·검증·미연결 범위·실행 경로 인계 |

## 원천과 적용 안전선

- 설정은 공급사 `sourceId`, `kind`, 전체 수집 범위 `scopes`, `maxDowngradeRatio`다. F05는 공급사별 하나의 플러그인으로 분리한다. `종합`은 제외한다. 보이는 공급사 탭/행만 판매 후보이며 숨긴 탭·사용자/필터 숨김 행·출고불가는 비판매다. 가시성 메타데이터가 빠지면 불완전/상태 UNKNOWN으로 처리한다.
- 아이카는 장기특별이벤트·신차선출고·중고재렌트·월렌트 네 범위를 모두 요구한다. 배차문의/수리중은 후보에 포함하며 원문과 별도로 출고협의/상품화중 표시를 보존한다.
- ONE은 AVAILABLE/PREPARING 포함, UNAVAILABLE/RESERVED/RENTED 제외. 기존 full-facts의 `vehicleId`, 기간별 요금·보증금·거리/주기·원문 조건을 읽는다. 목록만으로 요금/보증금을 채우지 않는다. 원천 `synced_at`을 freshness 기준으로 사용한다.
- 아이언은 게시만 포함. 오토플러스·손오공은 기존 수집 결과가 제공한 표준 상태/조건을 사용한다. 손오공 새 ERP 로그인·새 수집기는 만들지 않는다.
- `complete=false`, 429/403/부분 실패, UID 변환 누락·중복이 있으면 **SOURCE_ABSENT 하향 0**. 불완전 회차에도 실제 관측한 명시적 판매중지/조건 변경은 별도로 계획할 수 있으며 회차 전체는 HOLD로 기록한다. 완전성은 빈 배열만으로 추정하지 않는다.
- 기존 계약잠금 또는 기존 상태 `계약중`은 모든 변경에서 제외한다. 상품 삭제 API가 없다. 원문은 관측 레코드/기존 RAW 경계에, 이전 상품 전체는 적용 전 백업에, 이전 노출 값은 `publication_withdrawal_prior`에 보존한다. 갱신 시 관련 없는 기존 envelope 필드도 유지한다.
- 하향 비율 = 이번 하향 / 현재 노출 상품. 설정 상한 **초과** 시 백업/상품 쓰기 전 중단하고 알린다. 상한과 같은 비율은 허용한다(SPEC2의 ‘초과’; 참고 스크립트의 `>=`를 그대로 복제하지 않음).
- 신규 상품은 원천 레코드에서만 구성한다. 차종 검토 표식을 유지하며 차종/가격을 기존 상품에서 추정하지 않는다. UNKNOWN 조건은 0원으로 바꾸지 않으며 신규 편입을 보류한다. 기존 상품의 조건 bundle 오류는 이전 조건을 보존하고 노출을 보류한다.
- 승인 digest와 현재 상태 재대조 → **모든 대상 백업·백업 되읽기** → 개별 CAS → 키 순서 무관 깊은 되읽기. CAS 구현은 CatalogStore 트랜잭션 안에서 계약잠금/전체 before digest를 함께 확인해야 한다.
- 쓰기 응답/되읽기 불확실은 `APPLY_UNCERTAIN`이다. 이미 반영되었을 수 있으므로 추가 쓰기를 중단하며 자동 롤백·같은 명령 재시도를 하지 않는다. 다음 회차는 현재 상태를 새로 읽어 다시 계획한다.
- 의미 있는 값이 같고 관측 시각만 바뀌면 상품 변경 0이다. 관측 시각 갱신은 RAW/heartbeat가 담당한다. 향후 소비처 freshness는 이 최신 관측을 사용해야 하며, 마지막 상품 변경 시각을 마지막 수집 시각으로 사용하면 안 된다.
- 파일 잠금은 원천 ID의 해시 이름과 배타 생성(`wx`)을 사용한다. 프로세스 종료 후 잔존 잠금을 시간만으로 탈취하지 않는다. 같은 PC의 모든 실행은 동일한 제어 디렉터리를 공유해야 한다. 3회 실패 정지는 파일에 남아 다음 프로세스에서도 유지된다. 원인 확인 후 상태/잔존 잠금 해제는 운영자의 별도 조치다.
- heartbeat 연결은 기존 source_runs/RAW lifecycle을 사용한다. `:cycle-heartbeat` 범위를 PARTIAL/INCOMPLETE로 기록하여 원래 전량 재고 head를 밀어내지 않는다. 별도 source-head 판정기를 만들지 않았다. 현재 라이브 store에는 연결하지 않았다.

## 검증

- 최종 신규 **41/41 PASS**. 관련 7파일 **211/211 PASS**: 신규41 + 1단계24 + canonical111 + capture retry3 + capture job4 + capture adapter18 + supplier layer10.
- 확장 검사에서 기존 ONE 시험 **97/99 PASS, 2 FAIL**. 두 CLI subprocess가 tsx 초기화의 `uv_os_get_passwd ENOMEM`으로 exit1: 기대 exit2/빈 stderr 검사 실패다. 애플리케이션 로직 진입 전 오류이며 해당 시험·의존성·환경을 우회 수정하지 않았다. 확장 실행 당시 전체는 305/307; 이후 새 회귀 3개를 추가하고 위 211개를 최종 재실행했다. 전체 저장소 시험은 이번에 실행하지 않았다.
- `npm.cmd run build`, `check:arch`, `check:data-access-boundary`: PASS.
- `git diff --check`, 신규 파일 UTF-8/공백 검사: PASS.
- 두 PowerShell 스크립트 parser 검사: PASS. 실제 `schtasks` 호출 없음.
- 합성 요구 사례: 원천3/기존5 → 하향2·편입1·조건갱신1, 재실행 변화0, 불완전/UID누락/중복 시 누락 하향0, 비율 상한 중단, 키순서만 다른 가격 맵 되읽기 통과, 계약잠금 불변, 승인/백업/CAS/만료 방어, 성공 이후 실패와 실패3회 정지, source_synced 감지, F05 실제 기존 정제기·ONE full-facts 변환, 오프라인 CLI heartbeat.
- 외부 원천·Firestore·ERP/F01 실측 건수는 **UNKNOWN**. 메모리 적용과 오프라인 파일 heartbeat 시험을 persistence/deployment/cutover 검증으로 확대하지 않는다.

## 실행 경로

먼저 `npm.cmd run build`. 라이브 연결 없는 로컬 시험 실행:

```powershell
node dist/src/jobs/source-cycle.js --snapshot <비공개-capture.json> --state-dir <비공개-제어폴더>
```

snapshot 구조는 `{sources:[{definition,capture}], products:[CycleProduct], catalogComplete:boolean}`이며 타입은 plugins/ports에 정의돼 있다. snapshot의 상품 배열은 읽기 전용이고 백업/상품 write 메서드는 차단한다. 제어폴더에만 상태·알림·수치 heartbeat가 남는다. JSON 원문에는 민감정보가 있을 수 있으므로 저장소에 넣지 않는다. 고정 캡처가 TTL을 넘으면 정상적으로 HOLD다.

연결 담당이 검토한 로컬 ES 모듈은 `{plugins, commands, control}`을 export한다:

```powershell
node dist/src/jobs/source-cycle.js --runtime <검토된-runtime.mjs> --source <공급사코드> --only-when-synced
```

- `commands`: 기존 CatalogStore 경계의 전체 상품 조회·불변 백업·원자 CAS·되읽기 구현. `control`: `fileCycleControl(directory, sourceRunCycleHeartbeat(sourceStore))`. `sourceStore`는 기존 target/runtime에서 가져온다.
- F05는 `sharedSheetCyclePlugin`, ONE은 `iancarCyclePlugin`. 나머지는 `sourceCyclePlugin`에 기존 수집기 결과를 표준 `CycleCapture`로 연결한다. 가짜 UID·기존 상품 조건 보충·불완전 원천의 빈 전량 대체는 금지다.
- `--only-when-synced`는 ONE에만 적용한다. probe와 실제 capture의 synced_at이 다르면 중단한다. dry-run은 적용용 토큰을 소비하지 않는다. 성공한 적용에 한해 토큰이 저장되므로 승인된 적용 runtime이 연결되기 전에는 같은 토큰도 반복 dry-run한다.
- CLI와 예약은 항상 상품 쓰기0이다. 적용 코드는 `runSourceCycle`의 `approvedPlan + digest + approval` 또는 `applySourceCycle`로만 호출한다. 호출자는 별도 승인 경계에서 digest를 공급해야 한다. 계획이 오래되거나 원천/기존 상태가 달라지면 재계획이다.

등록/제거 스크립트의 기본 동작은 명령 출력뿐이다:

```powershell
powershell -NoProfile -File scripts/register-source-cycle.ps1 -Runtime <검토된-runtime.mjs> -OnlyWhenSynced
powershell -NoProfile -File scripts/unregister-source-cycle.ps1
```

등록 스크립트는 15분 간격을 만들며 기존 작업을 강제 덮어쓰지 않는다. 실제 등록 `-Register`/제거 `-Remove`는 이번에 실행하지 않았다.

## 남은 일 / next_start_here

1. 운영용 runtime 조합과 CatalogStore command adapter는 미연결이다. 기존 1단계의 UID live 열/binding 이행, 원본 전체 백업·명령 영수증/감사·작성자 fencing에 맞춰 연결해야 한다. 이번 코드만으로 운영 반복 반영이 시작되지 않는다.
2. F05 가시성 메타데이터를 같은 capture window로 연결하고 실제 UID 누락을 해결한다. 아이카·아이언·오토플러스·손오공은 설정형 표준 캡처 경계까지 구현했으며 각 native 수집 결과의 UID/기간별 조건 mapping과 비공개 실캡처 대사가 남는다. 참고 도구의 plate-only 결과로 UID를 발급하지 않는다. ONE의 동일 기간·서로 다른 주행조건 요금은 기존 표준 레코드의 기간 중복 validator가 HOLD하므로 임의 한 건 선택 없이 계약 확장이 필요하다.
3. tsx subprocess 환경 실패 2개를 허용된 환경에서 재검증하고 독립 검토를 받는다. 이후 최신 원천과 각 소비처를 대조한다. 현재 소비처 freshness·공개보류 실제 적용은 미검증이다.
4. 코드·문서 diff를 지휘통제실이 검토/커밋한다. 실제 예약 등록과 승인된 운영 적용은 별도 실행이다. 적용 불확실 시 실제 대상 상태/백업부터 읽고 재계획한다.
5. Cloud Scheduler → 원천별 Cloud Run Jobs는 후속 설계다. PC 파일 잠금을 그대로 클라우드에 쓰지 말고 기존 source-run/event claim과 조건부 문서 lease/fencing을 연결한다. source scope·writer ownership·target binding·서비스 계정 최소권한·비공개 백업/되읽기·영속 실패회수·중복 예약 멱등키를 고정한 뒤 IAM 승인을 받아 구성한다. 이번에는 cloud 리소스·IAM·예약을 만들지 않았다.

`next_start_here`: 이 문서 → SPEC2 → `tests/source-cycle.test.ts` → `src/jobs/source-cycle.ts`. 우선 source별 private capture mapping과 기존 CatalogStore 연결을 확정하고 dry-run digest/UID 집합을 검증한다. 운영 등록·적용 완료라고 보고하지 않는다.
