# AI Core Development Runtime v0.1

상태: RESEARCH_CANDIDATE / DESIGN

## 목적

개발을 '코드를 쓰는 일'이 아니라 사용자의 의도를 실제 소프트웨어 변화로 안전하게 번역하는 반복 가능한 런타임으로 만든다. 목표는 비개발자 사용자가 저장소·브랜치·테스트·배포 구조를 일일이 지시하지 않아도, AI가 필요한 개발 맥락을 스스로 해석·준비·검증하고 사용자는 중요한 결정과 결과 확인에 집중하게 하는 것이다.

## 현재 구조의 강점과 남은 마찰

현재 DevCenter는 SSOT 우선, 작업 목적/범위/완료조건, 기존 자산 재사용, 독립 검토, 실제 실행 검증, 권한/배포 경계 등 좋은 기본선을 이미 갖고 있다. 그러나 상당 부분은 사람이 작업 시작 양식을 채우고, 어떤 원본/자산/검사를 볼지 찾고, AI에게 반복 설명해야 한다. Registry도 포인터 중심이라 실제 코드 구조·의존성·런타임 상태를 계속 재탐색해야 한다.

개발을 실제로 편하게 만들려면 '규칙을 더 추가'하기보다 다음 반복비용을 제거해야 한다.

1. 매 세션 프로젝트 구조를 다시 설명하는 비용
2. 사용자의 자연어 요구를 개발 요구사항으로 번역하는 비용
3. 어느 파일/컴포넌트/데이터 흐름을 건드려야 하는지 찾는 비용
4. 빌드·테스트·미리보기·회귀 검증을 사람이 지시하는 비용
5. Chat ↔ Work ↔ Codex 간 맥락 손실
6. '코드는 됐다'와 '실제로 작동한다' 사이의 확인 비용
7. 배포 후 문제가 생겼을 때 원인과 롤백을 다시 찾는 비용

## 사용자 경험 목표 — Dev Mode

사용자는 원칙적으로 다음 정도만 말하면 된다.

> "이 화면에서 접수 흐름을 이렇게 바꾸고 싶어. 모바일에서도 자연스럽게."

AI는 내부적으로 다음을 수행한다.

INTENT → PROJECT RESOLVE → PROJECT CAPSULE → CHANGE COMPILE → IMPACT PLAN → EXECUTOR ROUTE → SANDBOX → BUILD/TEST → PREVIEW → PROOF → RELEASE GATE → OBSERVE → LEARN

사용자에게 노출하는 것은 모든 내부 단계가 아니라 중요한 결정, 미리보기, 남은 위험, 실제 결과다.

## 1. Project Capsule — 프로젝트를 매번 다시 읽지 않기

각 프로젝트에는 사람이 작성하는 긴 문서보다, AI가 읽을 수 있는 얇은 표준 진입점을 둔다.

권장 논리 필드:
- project_id
- mission
- repo/default_branch
- stack/runtime
- install/dev/build/test/lint commands
- source roots
- routes/pages
- design system pointers
- data/schema/state-machine pointers
- environment classes
- deploy targets
- required approvals
- known blockers
- authoritative docs
- generated_at / source revision

중요: Capsule은 코드의 새 SSOT가 아니다. 실제 코드/정본에서 자동 생성하거나 포인터만 유지하는 읽기 최적화 캐시다. source revision이 바뀌면 stale 처리한다.

## 2. Codebase Twin — AI용 코드 지도

단순 파일 목록이 아니라 현재 revision의 구조를 읽기 전용 그래프로 만든다.

노드 예시:
- route/page
- component
- function/module
- API endpoint
- DB table/field
- state transition
- external service
- test
- design token

엣지 예시:
- imports
- renders
- calls
- reads/writes
- depends_on
- tested_by
- deployed_with

목표는 AI가 매번 grep부터 시작하지 않게 하고, 변경 전에 영향 범위를 계산할 수 있게 하는 것이다.

Twin은 생성물이며 authoritative truth가 아니다. 코드 revision과 함께 묶고 stale이면 재생성한다.

## 3. Change Compiler — 사람의 말을 실행 가능한 개발 계약으로

자연어 요구를 다음 구조로 컴파일한다.

- user_intent
- desired_outcome
- acceptance criteria
- non-goals
- UX behavior
- data/state impact
- likely affected nodes
- required source revisions
- reuse candidates
- test obligations
- preview obligations
- rollback condition
- user decisions still needed

질문은 '개발자가 알고 싶은 것'이 아니라 답에 따라 구현이 달라지는 것만 묻는다.

## 4. Impact Planner — 수정 전에 어디가 깨질지 본다

Change Packet과 Codebase Twin을 결합해 최소 변경 계획을 만든다.

출력:
- expected files/modules
- upstream/downstream dependencies
- shared components affected
- data migration need
- API compatibility risk
- mobile/web surfaces
- regression tests required
- preview scenarios
- safe rollback path

목표는 '일단 고치고 깨진 곳을 찾는 개발'에서 '영향을 보고 최소 수정하는 개발'로 이동하는 것이다.

## 5. Reuse Resolver — 만들기 전에 이미 있는지 찾는다

DevCenter registry와 실제 repository search를 함께 사용해:
- 기존 컴포넌트
- 기존 hook/module
- 디자인 토큰
- 상태 엔진
- 유사 기능
- 테스트 fixture
- 문서/패턴
을 먼저 찾는다.

단순 이름 유사도가 아니라 입력/출력/의미/상태/소비 위치가 맞는지 확인한다. 재사용 불가면 이유를 Change Packet에 남긴다.

## 6. Execution Fabric — 실행자는 교체 가능하게

Task 특성에 따라 GPT Direct / Work / Codex / Cursor / 기타 도구를 선택한다.

라우팅 기준 예시:
- 작은 단일 파일 수정 → direct
- repo-wide 탐색 / dependencies / runtime debug → Work/Codex
- 대량 정적 관계 수집 → code-search/static agent
- visual regression → browser/preview verifier

사용자는 실행자 이름을 선택하지 않아도 된다. 중요한 것은 역할/증거 계약이다.

## 7. Sandbox & Preview — 프로덕션보다 먼저 눈으로 확인

모든 의미 있는 UI/기능 변경은 가능하면 격리된 branch/worktree/preview에서 검증한다.

개발 시스템이 자동으로 준비해야 할 것:
- branch/worktree
- dependency install/cache
- safe fixtures/mock data
- env readiness check
- build
- local/preview URL
- before/after screenshot or interaction trace when applicable

운영 개인정보/실데이터를 복제하지 않는다. 필요한 경우 승인된 비식별 fixture를 사용한다.

## 8. Verification Fabric — '테스트 하나 통과'를 완료로 보지 않는다

개발 검증을 한 덩어리 점수가 아니라 필요한 층으로 나눈다.

- static/syntax
- unit
- contract/schema
- integration
- state-transition
- visual/layout
- responsive/mobile
- accessibility where applicable
- error/loading/empty states
- security/permission boundary
- regression
- build/package
- runtime smoke

Change Compiler가 acceptance criterion별 필요한 검증을 결정하고, Proof Bundle이 실제 실행 증거를 묶는다.

## 9. Proof Bundle — Work가 '됐다'고 말하는 대신 증거를 반환

표준 결과 묶음:
- subject revision / commit SHA
- changed files
- requirement IDs
- commands actually run
- pass/fail/skip counts
- screenshots/preview refs if applicable
- known failures/unknowns
- independent review state
- rollback instructions
- deployment state
- outcome state

이 Bundle이 Chat review와 Release Gate의 입력이 된다.

## 10. Release Gate — merge/deploy를 개발과 분리

IMPLEMENTED / TESTED / REVIEWED / MERGED / DEPLOYED / OBSERVED를 분리한다.

배포 전에는:
- current revision과 proof revision 일치
- required checks satisfied
- unresolved critical findings 없음
- environment/target 확인
- rollback path 확인
- 필요한 권한/승인 확인

을 본다.

배포 후에는 실제 target revision과 health/smoke 결과를 확인한다.

## 11. Failure Memory — 같은 버그를 새 버그처럼 다시 풀지 않기

실패를 일반 prose가 아니라 구조화한다.

- symptom
- root cause
- affected pattern
- reproduction
- fix
- regression guard
- applicable projects
- non-applicable conditions

새 Change Packet이 생성될 때 관련 failure memory를 자동 조회한다.

## 12. Development Portfolio — 여러 AI/프로젝트 충돌 방지

프로젝트별 active task만 보는 것이 아니라:
- active branches
- owner
- file/module locks or overlap warnings
- pending reviews
- blocked dependencies
- preview environments
- release queue
- stale branches
을 한눈에 본다.

목표는 Chat/Work/Codex가 같은 파일을 다른 의도로 동시에 고치는 사고를 줄이는 것이다.

## 13. Dev Control Room — 사용자가 보는 화면은 단순해야 한다

내부는 복잡해져도 사용자 화면은 다음만 보이면 된다.

### Project
- 현재 상태
- 최근 배포
- 중요한 blocker

### Change
- 내가 요청한 것
- AI가 이해한 결과
- 현재 단계
- 필요한 결정 0~N개

### Preview
- before / after
- 모바일/웹 확인

### Proof
- 무엇을 실제로 검사했는가
- 남은 위험

### Release
- 배포 여부
- 롤백 가능 여부

### Learn
- 이번에 새로 생긴 재사용 자산/실패 방지 규칙

## 우선순위 — 무엇부터 만들면 체감이 큰가

### P0 — 가장 먼저
1. Project Capsule
2. Change Compiler
3. Proof Bundle

이 세 개만 있어도 Chat↔Work handoff와 반복 설명 비용이 크게 줄 가능성이 있다.

### P1
4. Codebase Twin
5. Impact Planner
6. Reuse Resolver

이 단계부터 AI가 '코드를 다시 읽는 비용'과 과잉 수정이 줄어든다.

### P2
7. Sandbox/Preview automation
8. Verification Fabric
9. Release Gate

이 단계부터 사용자는 코드를 읽지 않고도 미리보기와 증거 중심으로 개발을 감독할 수 있다.

### P3
10. Failure Memory
11. Development Portfolio
12. Dev Control Room

이 단계부터 여러 프로젝트/AI를 장기간 병렬 운영하기 쉬워진다.

## 핵심 원칙

개발을 편하게 만드는 것은 규칙의 수를 늘리는 일이 아니다.

**사용자가 반복해서 설명하고, AI가 반복해서 탐색하고, 사람이 반복해서 확인해야 하는 부분을 기계가 지속 상태로 들고 있게 만드는 것**이 핵심이다.

최종 목표는 사용자가 개발 전문 용어를 잘 다루는 것이 아니라:

> 원하는 결과를 말한다 → AI가 정확한 개발 계약으로 바꾼다 → 격리된 환경에서 만든다 → 눈으로 보여준다 → 증거로 검증한다 → 안전하게 반영한다 → 다음에는 더 적게 설명해도 된다.
