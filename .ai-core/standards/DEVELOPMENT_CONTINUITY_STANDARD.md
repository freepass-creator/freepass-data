# Development Continuity Standard

Status: **CURRENT / CANONICAL DEVELOPMENT GOVERNANCE**

## 목적

AI 개발에서 가장 큰 낭비는 기능을 못 만드는 것이 아니라 **같은 목적의 개발을 여러 브랜치·여러 정본·여러 구현으로 갈라 놓고 서로 이어받지 못하는 것**이다.

이 표준의 목표는 하나다.

> **AI가 바뀌어도 같은 탑의 다음 층을 쌓는다.**

Claude, Codex, GPT 또는 다른 AI는 개발선의 소유자가 아니다. **Work가 개발선을 소유**하고 AI는 그 Work의 현재 writer일 뿐이다.

## 1. Branch ownership

신규 개발의 기본 branch는 다음 형식이다.

`work/<project-id>/<work-id>`

예:

`work/ai-core/DEV-CONTINUITY-AUDIT-20260926`

금지되는 기본 패턴:

- `gpt/...`
- `claude/...`
- `codex/...`
- AI 이름을 branch identity로 사용하는 `work/<actor>/...`

AI가 교체되어도 branch를 새로 만들지 않는다. checkpoint/handoff 뒤 같은 Work branch를 이어받는다.

## 2. RESUME BEFORE CREATE

개발 시작 순서는 항상 다음이다.

1. 대상 repository와 canonical scope를 resolve한다.
2. 같은 목적의 기존 Work, open PR, branch, handoff를 찾는다.
3. 기존 개발선이 있으면 **RESUME**한다.
4. 기존 개발선이 없다는 근거가 있을 때만 **CREATE ONCE**한다.

같은 canonical scope를 이미 고치는 open PR이 있으면(초안 포함) **먼저 연 그 PR이 개발선을 쥔다** — 늦게 연 PR은 canon-guard가 막는다(`scripts/check-branch-discipline.mjs` `winsOver`).

새 branch 생성은 안전한 기본값이 아니다. **기존 개발선 미발견이 증명된 뒤 사용하는 예외 동작**이다.

## 3. Branch budget

업계에서 의미 있는 기준은 “개발자 한 명당 branch 평균”이 아니라 저장소 전체의 **active development branches**다.

AI Core 내부 기본 budget:

| project profile | target active work branches | hard max |
|---|---:|---:|
| SIMPLE | 1 | 2 |
| STANDARD | 2 | 3 |
| COMPLEX | 2 | 3 |
| EXCEPTIONAL | 3 | 5 + waiver |

COMPLEX 프로젝트라고 branch가 많아도 되는 것이 아니다. 복잡할수록 work decomposition과 integration discipline이 더 강해야 한다.

EXCEPTIONAL은 다음을 모두 요구한다.

- 서로 독립적인 child work
- 겹치지 않는 canonical scope
- owner
- expiry
- merge order
- parent work

반복적으로 예외가 필요하면 branch 수를 늘리는 대신 repository/project boundary를 재검토한다.

## 4. Branch lifetime

목표는 24시간 이내 main 통합이다.

- 0–24h: 정상
- 24–48h: 관찰
- 48–72h: WARN
- 72h 초과: CRITICAL 또는 명시적 장기 작업 근거 필요

장기 기능은 장기 branch로 유지하지 않고 작은 통합 가능한 slice로 나눈다.

## 5. Branch count와 branch debt

`total branches`는 active branch 수와 다르므로 단독 성과지표로 쓰지 않는다. 그러나 AI 환경에서는 오래된 branch가 retrieval과 정본 판정에 노이즈를 만들기 때문에 **branch debt**로 감사한다.

다음은 debt다.

- main에 이미 흡수됐는데 남은 branch
- open PR 없이 main보다 ahead인 branch
- 72시간 이상 갱신되지 않은 unique-ahead branch
- AI 이름으로 생성된 신규 branch
- 같은 Work를 가리키는 branch 둘 이상
- 같은 canonical scope를 동시에 변경하는 active branch 둘 이상
- `final`, `v2`, `refresh`, `replay`, `current-main`처럼 실제 Work identity 대신 상태를 이름으로 복제한 branch

역사 보존은 branch가 아니라 commit, PR, tag, decision log를 사용한다.

## 6. Duty to Warn

AI는 사용자가 묻기 전이라도 아래 상황을 발견하면 기능 구현보다 먼저 보고한다.

- active branch가 profile hard max를 초과
- 같은 목적의 branch/PR이 둘 이상
- 같은 canonical scope를 두 개발선이 수정
- main에 없는 고유 코드가 여러 오래된 branch에 흩어짐
- 새 정본 후보가 기존 canonical line과 경쟁
- 작업을 이어갈 branch가 있는데 새 branch를 만들려는 상황

보고 형식:

`DEVELOPMENT_LINE_SPLIT / 원인 / 영향 / 현재 정본 / 이어갈 Work / 폐기·회수 후보`

경고 후에도 안전한 read-only 감사와 정리는 계속할 수 있지만, **세 번째 구현을 추가하지 않는다.**

## 7. 감사 지표

정기 감사는 최소 다음을 측정한다.

- remote branch total
- main에 고유 commit이 있는 branch 수
- 최근 72시간 unique-ahead branch 수(활성 proxy)
- main에 완전히 흡수된 branch 수
- 72시간 초과 stale unique branch 수
- actor-prefixed unique branch 수
- open PR head branch 수
- canonical scope overlap
- duplicate Work branch
- branch age p50 / p90 / max
- merged branch cleanup debt

숫자는 프로젝트 난이도와 profile을 같이 보고 판정한다.

## 8. AI Core의 역할

AI Core는 단순히 규칙을 가르치지 않는다.

- 시작 시 기존 개발선을 찾는다.
- 개발선이 있으면 resume 위치를 돌려준다.
- branch budget을 감사한다.
- split을 감지하면 Duty to Warn을 발동한다.
- completed/merged branch는 retire 대상으로 만든다.
- 지식은 branch에 묻어두지 않고 canonical registry/PR/history로 회수한다.

즉 AI Academy가 **어떻게 개발하는가**를 가르친다면 Development Continuity는 **지금 어디까지 쌓았고 다음 층이 어디인가**를 보존한다.

## 9. DEV-01~DEV-10 개발 진행번호

개발 상태를 “거의 됨”, “작업 중”처럼 모호하게 말하지 않는다. 공통 진행표의 machine-readable 정본은 `registry/development-lifecycle.json`이다.

| 번호 | 코드 | 뜻 | 쉬운 비유 |
|---:|---|---|---|
| 1 | `DEV-01 MAIN` | 메인 확인 | 본 요리·공식 레시피 확인 |
| 2 | `DEV-02 BRANCH` | 브랜치 | 시험용 조리대 |
| 3 | `DEV-03 CODE` | 코딩 | 실제 조리 |
| 4 | `DEV-04 TEST` | 테스트 | 내가 먼저 맛보기 |
| 5 | `DEV-05 COMMIT` | 커밋 | 여기까지 상태 저장 |
| 6 | `DEV-06 PR` | PR 제출 | 본점 반영 요청 |
| 7 | `DEV-07 CI` | CI 자동검사 | 정식 검사기 규격검사 |
| 8 | `DEV-08 MERGE` | 머지 | 공식 레시피에 합침 |
| 9 | `DEV-09 BUILD` | 빌드 | 배포 가능한 완제품 만들기 |
| 10 | `DEV-10 RELEASE` | 배포·운영확인·정리 | 매장 배포 → 실제 확인 → 문제면 롤백, 정상이면 브랜치 정리 |

AI는 의미 있는 개발 진행 보고에서 최소한 다음 두 줄을 제공한다.

```text
현재 단계: DEV-07/10 CI — 자동 규격검사 중
다음 단계: DEV-08/10 MERGE — 통과한 변경을 main에 병합
```

이 번호는 진행상태를 쉽게 공유하기 위한 **계기판**이지, 실제 개발을 무조건 한 번씩만 통과시키는 직선 공정이 아니다. `CODE → TEST → COMMIT`은 여러 번 반복할 수 있고 CI 실패 시 다시 그 구간으로 돌아간다. `RELEASE`에서 운영 문제가 확인되면 rollback 또는 수정 후 적절한 단계로 되돌아간다.

`Production`은 별도 번호가 아니라 DEV-10에서 확인하는 **실제 운영 상태**다. 브랜치 삭제는 merge 직후 무조건 하지 않고, 필요한 운영 검증과 회수 여부를 확인한 뒤 cleanup한다.

문서·규칙·정적 자료처럼 **빌드나 배포 대상이 실제로 없는 작업**은 DEV-09 또는 DEV-10을 억지로 통과했다고 쓰지 않는다. `N/A — 배포 대상 없음`처럼 이유와 함께 표시한다. 단계 상태는 `DONE / IN_PROGRESS / N/A / HOLD` 중 하나로 보고하며, `N/A`는 성공을 뜻하는 PASS가 아니라 **그 단계가 적용되지 않음**을 뜻한다.

## 10. AI Core 작업 레인 — 부서가 아니라 작업 분류

AI Core의 반복 업무는 다음 네 레인으로 분류한다. **레인은 상시 브랜치 이름이 아니다.** 실제 Work가 있을 때만 `work/<project-id>/<work-id>` 브랜치를 하나 만들고, 검증 후 main에 병합한 뒤 retire한다.

| 레인 | 담당 | 하지 않는 것 |
|---|---|---|
| `core` | Core Contract, Workflow, Capability Runtime, 공통 표준과 플랫폼 본체 고도화 | 개별 사업 도메인 기능 소유 |
| `integration` | 프로젝트 간 통합, 역수입, 공통 계약·Adapter·공용 기능 승격 | 원 프로젝트를 AI Core 안에 복제 |
| `audit` | 다른 프로젝트의 브랜치 분열, 복수 정본, UI/데이터/엔진/Adapter 중복, 릴리스·정합성 감사 | 감사 결과를 이유로 도메인 코드를 AI Core가 장기 소유 |
| `hardening` | 오류 수정, 회귀 테스트, CI, 보안, 관측성, 성능, 중복·dead code 제거, release gate | 새 사업 기능 개발 |

### 도메인 소유권 경계

과태료, 카카오 자동화, 보험, 미수, ERP 같은 도메인 구현은 **소유 프로젝트의 repository가 정본**이다. AI Core는 그 구현을 장기 브랜치로 보유하지 않는다.

- 과태료 구현은 Rental Manager가 소유한다. AI Core는 공통 Receipt/Evidence, Workflow, Idempotency, Error/Result, Adapter 같은 재사용 규격만 회수한다.
- Kakao Ops 구현은 Kakao Ops가 소유한다. AI Core는 공통 Adapter, 승인/권한, retry, audit, integration 규격만 회수한다.
- 다른 프로젝트 감사에서 수정 필요가 발견되면 기본적으로 **그 프로젝트의 Work branch로 수정 요청을 라우팅**한다. AI Core에 남길 수 있는 것은 전사 공통 규격·검증기·통합 primitive뿐이다.

따라서 `work/core`, `work/integration`, `work/audit`, `work/hardening` 같은 고정 장기 브랜치를 네 개 유지하는 방식도 금지한다. **개념 레인은 네 개지만 실제 branch는 Work 수만큼만 잠깐 존재**한다.
