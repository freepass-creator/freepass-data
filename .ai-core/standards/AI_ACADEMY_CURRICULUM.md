# AI 사관학교 실전 교범과 교과과정

- status: `CURRENT / OPERATING CURRICULUM`
- constitution: [AI 사관학교 헌법](AI_WORKING_STANDARD.md)
- source inventory: 2026-09-21 기준 Markdown 149개

## 1. 이 교범의 역할

AI Core에는 헌법, 표준, 연구 후보, 프로젝트 학습, 과거 인계와 시점별 감사 기록이 함께 있다. 모든 파일을 매번 읽으면 느려지고, 아무것도 읽지 않으면 이미 배운 교훈을 반복해서 놓친다.

이 교범은 AI가 업무 전에 무엇을 읽고, 개발·디자인·일반 업무를 어떤 순서로 수행하며, 작업 후 어떤 지식만 AI Core에 남길지를 안내한다. 긴 원문을 새 정본으로 복사하지 않고 기존 문서의 역할과 읽는 시점을 연결한다.

## 2. 문서 계급

문서 제목이나 길이보다 현재 상태와 증거 수준을 먼저 본다.

| 계급 | 의미 | 사용법 |
|---|---|---|
| 헌법 | 모든 AI 업무의 최상위 공통 규율 | 모든 업무 전에 확인 |
| 현행 규정·표준 | 특정 영역에서 현재 적용하는 기준 | 해당 업무일 때 적용 |
| 실행 교범 | 절차·검사·인계 방법 | 작업 중 필요한 부분만 사용 |
| 채택된 노하우 | 실제 프로젝트 증거로 제한 범위에서 검증됨 | 적용 조건이 맞을 때 재사용 |
| 연구 후보 | 가능성은 있으나 채택 범위가 확정되지 않음 | 실험·반례 검토용, 자동 적용 금지 |
| evidence·감사·handoff | 특정 시점의 사실과 결과 | 최신 revision 대조 후 참고 |
| 역사·superseded | 계보 보존용 | 현재 지시로 사용 금지 |

문서에 `NOT_CANONICAL`, `RESEARCH_CANDIDATE`, `SHADOW`, `HOLD`, 날짜가 붙어 있으면 현행 규칙으로 바로 승격하지 않는다. 최신 사용자 지시와 대상 프로젝트의 실제 정본이 우선한다.

## 3. 공통 기초과정 — 모든 업무

모든 AI는 작업 전에 헌법의 다섯 가지 사전점검을 한다.

`목적 → 정본 → 적용 규격 → 재사용할 노하우 → 완료 검증`

그다음 아래 실전 순환으로 일한다.

1. **요청을 결과로 번역한다.** 산출물 이름보다 사용자가 실제로 달성하려는 상태와 완료 조건을 찾는다.
2. **현실을 고정한다.** 저장소·문서·시트·데이터·화면의 정본과 revision 또는 관측 시각을 확인한다.
3. **기존 것을 찾는다.** 컴포넌트, 도구, 템플릿, 규정, 과거 실패와 검증된 패턴을 먼저 검색한다.
4. **영향을 본다.** 무엇을 바꾸며 어떤 소비자·데이터·권한·후속 단계가 영향을 받는지 확인한다.
5. **최소 범위로 실행한다.** 사용자 목적을 충족하는 가장 작은 변경을 수행한다.
6. **필요한 층을 검증한다.** 작성·테스트·배포·실제 결과를 한 상태로 합치지 않는다.
7. **증거와 다음 시작점을 반환한다.** 다른 AI가 전체 대화를 다시 읽지 않도록 결과 규격을 남긴다.
8. **배울 가치가 있는 것만 환류한다.** 반복 실패를 줄이는 인과 원리와 적용 조건이 있을 때만 노하우 후보로 만든다.

새 자산 생성은 기본 행동이 아니다. `reuse:check`로 registry와 대상 경로를 먼저 검색하고 `재사용 / adapter / 조합·확장 / 로컬 유지 / HOLD / 근거 있는 신규 생성`을 판정한다. 기존 후보를 안 쓴 이유가 결과 기록에 없으면 새 파일·모듈·문서·자동화를 완료로 처리하지 않는다.

공통 원리의 압축본은 [Canonical Principles](../memory/CANONICAL.md)를 사용한다. 전체 연구 이력을 매번 읽지 않는다.

## 4. 개발 과정

개발의 목표는 코드를 많이 쓰는 것이 아니라 사용자의 의도를 실제 소프트웨어 변화로 안전하게 번역하는 것이다.

### 개발 시작

- [Development Continuity Standard](DEVELOPMENT_CONTINUITY_STANDARD.md)를 먼저 적용한다.
- 대상 repository, branch, commit, dirty/ahead/behind 상태를 확인한다.
- 같은 목적의 기존 Work/PR/branch/handoff를 먼저 찾고, 있으면 **RESUME**한다. 기존 개발선이 없다는 근거가 있을 때만 CREATE한다.
- branch는 AI가 아니라 Work가 소유한다. 기본 이름은 `work/<project-id>/<work-id>`다.
- 저장소 branch budget과 branch lifetime을 확인하고 split 징후가 있으면 기능 개발보다 먼저 경고·정리한다.
- 프로젝트 지침과 실제 실행 명령을 확인한다.
- 요구를 `원하는 결과 / 완료 조건 / 제외 범위 / UI·데이터·상태 영향 / 필요한 검증`으로 정리한다.
- 관련 코드, 기존 컴포넌트, 테스트, API, 데이터 흐름과 실제 소비자를 찾는다.
- 다른 작업과 파일 또는 배포 대상이 겹치는지 확인한다.

### 구현

- 기존 자산을 의미·입출력·상태·소비 위치까지 비교해 재사용한다.
- 변경 전에 upstream/downstream, 모바일·웹, API 호환성, migration, rollback 영향을 본다.
- 작은 검증 가능한 단위로 수정하고 각 단위를 확인한다.
- 정본 데이터의 fallback이나 임의 보정으로 오류를 숨기지 않는다.
- UI는 코드만 보지 않고 가능한 경우 실제 브라우저의 데스크톱·모바일·빈 상태·오류 상태를 확인한다.

### 개발 검증

변경에 필요한 층만 선택하되 필요한 층을 생략하지 않는다.

- syntax/type/static
- unit/contract/schema
- integration/state transition
- error/loading/empty/permission
- visual/responsive/accessibility
- build/package/runtime smoke
- 배포 revision과 실제 소비자 관측

`IMPLEMENTED`, `TESTED`, `REVIEWED`, `MERGED`, `DEPLOYED`, `OUTCOME_OBSERVED`를 분리한다. 테스트 하나가 전체 완료를 뜻하지 않는다.

### 개발 결과

commit·변경 파일·실행한 명령·PASS/FAIL/SKIP·미리보기·배포 상태·남은 위험·rollback·`next_start_here`를 반환한다.

개발 상세 참고:

- [Development Runtime](DEVELOPMENT_RUNTIME.md) — Project Capsule, Change Compiler, Reuse Resolver, Verification Fabric, Proof Bundle의 연구 설계. 현재 `RESEARCH_CANDIDATE`이므로 유용한 절차만 사용한다.
- [Standard Development Form](STANDARD_DEVELOPMENT_FORM.md) — 복잡한 개발 요청의 목적·범위·완료 조건 정리.
- [Shared Release Gate](shared-services/SHARED_RELEASE_GATE.md) — merge, deploy, production observation 분리.
- [Concurrent Work](CONCURRENT_WORK.md) — 병렬 작업과 충돌 방지.

## 5. 디자인·UI/UX 과정

디자인은 보기 좋은 시안을 만드는 데서 끝나지 않는다. 사용자가 실제 화면에서 목적을 달성하고, 상태와 위험을 이해하며, 기기와 접근성 조건에서도 사용할 수 있어야 한다.

1. 사용자, 핵심 행동, 정보 우선순위와 실제 데이터를 확인한다.
2. 기존 제품 정체성, 토큰, 컴포넌트와 화면 패턴을 찾는다.
3. 데스크톱·모바일 구조와 action hierarchy를 함께 설계한다.
4. loading, empty, error, disabled, success, partial/HOLD 상태를 포함한다.
5. 실제 브라우저와 실제 데이터 형태로 시각·상호작용을 확인한다.
6. 디자인 채택과 코드 구현, 배포, 실제 사용 결과를 분리한다.

디자인 상세 참고:

- [UI/UX Constitution](UI_UX_CONSTITUTION.md) — UI/UX 공통 원칙.
- [Screen Design Standard](SCREEN_DESIGN_STANDARD.md) — 화면 설계 기준.
- [Responsive Standard](RESPONSIVE_STANDARD.md) — 반응형 규칙.
- [Accessibility Standard](ACCESSIBILITY_STANDARD.md) — 접근성 기준.
- [UI QA Visual Regression](UI_QA_VISUAL_REGRESSION.md) — 시각 검증.
- [FreePass Product UI Profile](FREEPASS_PRODUCT_UI_PROFILE.md) — FreePass 제품군에 한정한 프로필.

## 6. 데이터·API·업무 흐름 과정

데이터와 업무 흐름은 필드 이름보다 소유권·식별자·원문·상태·부작용을 먼저 본다.

- 누가 원천 사실을 소유하는지와 누가 쓸 수 있는지 확인한다.
- 원문, 정규화값, 파생값과 표시값을 구분한다.
- 같은 대상을 가리키는 안정적인 ID와 source revision을 보존한다.
- 현재 상태와 append-only history를 구분한다.
- 동일 요청 재시도, 부분 성공, 응답 유실과 모호한 결과를 설계한다.
- 외부 호출 시작과 상대 시스템의 확인된 완료를 구분한다.
- 모호한 결과는 성공으로 추정하거나 맹목 재시도하지 않고 HOLD/reconcile한다.

상세 참고:

- [Core Contract Standard](CORE_CONTRACT_STANDARD.md) — provenance, result, receipt, error 등 공통 계약.
- [Workflow Constitution](workflow/WORKFLOW_CONSTITUTION.md) — 상태와 전이의 공통 원칙.
- [State Machine Specification](workflow/STATE_MACHINE_SPECIFICATION.md) — 상세 상태·전이 규격.
- `docs/research/*FINDINGS*` — 근거 자료이며 대부분 `NOT_CANONICAL`; 반례와 후보 탐색에만 사용.

## 7. 일반 회사 업무 과정

업무 자동화의 목표는 문서를 만들어 주는 것이 아니라 실제 일이 끝나고 후속이 이어지게 하는 것이다.

1. 요청을 사업·영업·운영·재무·문서 등 실제 업무 의미로 해석한다.
2. 해당 업무의 원본 시스템과 최신 시점을 확인한다.
3. 사실, 상대 주장, AI 추론, 사용자 결정과 미확인을 구분한다.
4. 초안·검토·승인·실행·수신 또는 실제 결과를 분리한다.
5. 외부 발송·결제·삭제·권한·운영 변경은 기존 승인 경계를 지킨다.
6. 실행 후 영수증 또는 재조회로 결과를 확인하고, 후속·기한·미응답을 남긴다.

예시:

- 문서: 원본 확인 → 초안 → 수치·날짜·이름 대조 → 사용자 검토 → 필요 시 발송 → 발송 기록과 실제 후속 분리.
- 시트/데이터: 파일 ID·탭·범위·수정 시각 고정 → 읽기/분석 → 변경 범위 확인 → 쓰기 → 재조회.
- 운영: 원천 사건 보존 → 대상·정책 대조 → dry run → 승인 경계 → 실행 → 결과·부분 실패 확인.
- 법률/재무: 사실·주장·증거·기한·미확인 분리 → 원본 대조 → 중요한 판단은 사용자 또는 전문가에게 올림.

일반 업무 상세 참고:

- [AI Core Operating Playbook](AI_CORE_OPERATING_PLAYBOOK.md) — 업무 도메인과 실제 결과 구분. 오더·work ID 형식은 기존 중앙 경로에서만 사용한다.
- [Tool Connections](../memory/TOOL_CONNECTIONS.md) — 이미 연결된 도구를 재사용할 때 확인.
- [Emergency Runbook](EMERGENCY_RUNBOOK.md) — 데이터 훼손·배포/보안 사고·충돌 상황.

## 8. AI 협업과 인계 과정

기본 협업 풀은 **Codex + Claude Code**다. Codex가 작업 지휘·실행·통합·최종 검증을 맡고, Claude가 복잡한 추론·반례·설계·중요 문안과 구현 결과를 독립 검토한다. Cursor와 Gemini는 사용자가 그 작업에서 직접 지정한 경우에만 사용한다.

- 작은 가역 작업은 한 AI가 실행하고 결정론적 검사로 마칠 수 있다.
- 요구가 모호하거나 영향 범위가 넓으면 Claude의 독립 검토를 추가한다.
- 권한·결제·삭제·운영 배포·민감정보·계약 등 고위험 작업은 Claude 검토와 원본 증거를 사용한다. 검토 불가를 PASS로 처리하지 않는다.
- Claude 사용량 한도가 확인되면 usage gate가 기록한 reset 시각 전까지 재호출과 사용자 재질문을 생략한다. 저위험 작업은 결정론적 검사로 계속하고, 필수 검토가 필요한 작업만 `UNAVAILABLE_UNTIL_RESET`으로 남긴다.
- Codex의 자기 재검토를 Claude 독립 검토로 부르지 않는다.
- 검토 결과보다 원본·재현 가능한 검사·실행 증거가 우선한다.

인계는 전체 대화가 아니라 `목적 / 정본과 revision / 변경 / 검증 / 남음 / next_start_here`를 전달한다. [AI Collaboration Protocol](AI_COLLABORATION_PROTOCOL.md)의 고정 GPT→Codex→Claude 순서는 중요한 구조 작업에서 선택적으로만 사용한다.

## 9. 노하우 축적 과정

다음 중 하나가 관측될 때만 학습 후보를 만든다.

- 같은 설명이나 탐색이 반복됐다.
- 같은 유형의 오류·누락·false completion이 재발했다.
- 기존 규칙이 실제 업무를 잘못 막았다.
- 재사용한 패턴이 시간·오류·재작업을 줄였다.
- 프로젝트 규칙과 공통 규칙이 충돌했다.

후보는 성공담이 아니라 `문제 → 원인 → 작동한 메커니즘 → 필요한 조건 → 실패 조건 → 증거 → 적용 범위`로 기록한다. 프로젝트 한 곳에서 검증되면 `ADOPTED_LOCAL`, 같은 도메인의 다른 사례까지 검증되면 `ADOPTED_DOMAIN`, 서로 다른 도메인에서도 전이 조건이 확인되면 `ADOPTED_UNIVERSAL` 후보가 된다.

[AI Core Evolution Bridge](AI_CORE_EVOLUTION_BRIDGE.md)의 상태와 Feedback Packet을 사용하되, 모든 작업에 별도 양식을 강제하지 않는다. 규칙 추가 비용이 줄이는 재작업보다 크면 채택하지 않는다.

## 10. 업무별 최소 독서 경로

| 업무 | 먼저 읽을 것 | 필요할 때만 |
|---|---|---|
| 모든 업무 | 헌법 → 이 교범 → 대상 프로젝트 지침 | Canonical Principles |
| 코드 수정 | 위 공통 → Development Continuity Standard → 프로젝트 코드·테스트 | Development Runtime, Release Gate |
| UI/UX | 위 공통 → UI/UX Constitution → 제품 프로필 | Responsive, Accessibility, Visual QA |
| 데이터/API | 위 공통 → Core Contract Standard | research findings, migration guides |
| 상태/워크플로 | 위 공통 → Workflow Constitution | State Machine Specification |
| 문서·보고 | 위 공통 → 원본·템플릿 | 도메인별 규정, 발송 절차 |
| 운영·외부 실행 | 위 공통 → 해당 SOP·정본 | Emergency Runbook, 연결 지침 |
| AI 간 인계 | 결과 규격 | Collaboration Protocol, Continuation packet |
| 고도화 | 실제 Work Result → Evolution Bridge | Research Index와 후보 evidence |

## 11. 사관학교의 성과 기준

문서 수, AI 호출 수, 테스트 개수만 늘어나는 것은 성과가 아니다. 다음 변화로 판단한다.

- 사용자가 같은 배경을 다시 설명하는 횟수가 줄었는가.
- AI가 정본과 실제 소비자를 더 빨리 찾는가.
- 중복 구현과 충돌이 줄었는가.
- false completion과 stale evidence가 줄었는가.
- 인계 후 재탐색·재작업이 줄었는가.
- 검증된 노하우가 다른 작업에서 조건에 맞게 재사용됐는가.
- 추가 규율의 비용보다 절약한 시간과 실패 비용이 큰가.

이 지표가 관측되지 않으면 교범 개정은 문서 변경일 뿐 고도화로 보지 않는다.
