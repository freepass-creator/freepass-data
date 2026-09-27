# FreePass Data 종료 계획과 무료 채팅 인계

상태: **CURRENT / COST-AWARE HANDOFF**
기준 revision: `28d46e1f8d14a3a08d86586dae535838e4d123cd`
기준일: 2026-09-27

## 목적

FreePass Data를 끝없이 확장하지 않는다. 아래 종료 게이트를 닫으면 플랫폼 기반 구축을
완료하고, 이후 기능은 각 소비 프로젝트의 독립 업무로 넘긴다. 분석·문안·체크리스트처럼
로컬 실행이 필요 없는 일은 무료 ChatGPT에서 먼저 처리하여 Codex 사용량을 아낀다.

## 현재 정본

- GitHub/code 정본: `freepass-creator/freepass-data`의 `main`
- 운영 원천: `freepasserp5` Firestore
- 현재 main: `28d46e1`
- 최신 ERP5 감사: products 1,659 / policy 81 / partner 64, `FULL_SAME_READ_ONLY_TRANSACTION`
- 최신 공개 판정: `HOLD`
- 금지: RTDB 복구, 빈 Canonical/Release를 성공으로 간주, 테스트 결과를 배포·전환으로 확대

숫자와 상태는 시점값이다. 다음 작업자는 GitHub Actions와 실제 소비처를 다시 읽고 사용한다.

## 프로젝트 종료 게이트

### G1. 중앙 read runtime 운영 기반

- 필요한 GCP API, Artifact Registry, deploy/runtime identity, Secret Manager와 GitHub WIF를 준비한다.
- private Cloud Run read runtime을 immutable main SHA로 배포한다.
- 서비스 Ready, 인증 거부, 정상 consumer readback을 모두 확인한다.

### G2. ERP.com 첫 실제 소비자 연결

- Preview에서 `LEGACY_DIRECT -> OBSERVE -> SHADOW_READ` 순서로 진행한다.
- 실제 상품/정책/상업 조건 projection을 legacy 결과와 비교한다.
- 사용자 GO 전에는 `FREEPASS_DATA_READ`로 전환하지 않는다.

### G3. Canonical publication 경계 확정

- ERP5 FULL 캡처가 Canonical write 승인을 뜻하지 않음을 유지한다.
- review evidence, non-empty validated Release, manifest/digest/readback이 모두 있어야 ACTIVE다.
- 미확인 1건이라도 있으면 `HOLD`로 남긴다.

### G4. 핵심 소비자 인계

- ERP/화이트라벨, Admin, Sales, Estimate, F01/F86 각각에 contract, switch key, 현재 단계,
  남은 HOLD와 `next_start_here`를 남긴다.
- FreePass Data가 각 제품의 UI·workflow·계산 엔진까지 소유하지 않는다.

### G5. 종료 증거

- `main`과 로컬 HEAD 동일
- Core CI/Canon Guard PASS
- read runtime deployment/readback evidence
- 최신 `docs/NEXT-START-HERE.md`와 `docs/IMPLEMENTATION-STATUS.md`
- 열린 Issue를 `완료 / 소비 프로젝트 이관 / 명시적 HOLD`로 재분류
- 알려진 치명·중대 오류 0, 필수 검증 실패 0

G1~G5가 닫히면 FreePass Data 기반 구축을 **CLOSED / OPERATIONS MODE**로 바꾼다.

## 무료 ChatGPT에서 먼저 할 일

아래 작업은 저장소 수정·실행·비밀값 접근이 필요 없으면 무료 채팅에서 진행한다.

- 제공된 Markdown/Issue/PR 설명 요약 및 모순 찾기
- 요구사항, acceptance criteria, 테스트 케이스 초안
- API/스키마/상태 전이 설계의 반례 검토
- 운영 체크리스트, 인계문, 릴리스 노트와 사용자 안내문 초안
- 사용자가 붙여준 diff나 로그의 원인 후보 정리
- 완료/HOLD 항목 분류와 다음 작업 우선순위 제안
- Claude와 검토할 질문 정리

무료 채팅의 결과는 **초안/검토 의견**이다. 저장소·GitHub·GCP·실제 소비처를 읽지 않았다면
현재 사실, 테스트 PASS, 배포 완료 또는 운영 전환을 주장할 수 없다.

## Codex를 써야 하는 일

- 로컬 저장소와 실제 branch/worktree/dirty 상태 확인
- 코드·테스트·workflow·Markdown 수정과 commit
- GitHub PR/Issue/Actions의 현재 상태 확인
- GCP/Firebase/Cloud Run/IAM/Secret/WIF 실측 및 실행
- 비밀값을 노출하지 않는 인증·배포·readback
- 브라우저 E2E와 실제 소비자 parity 검증
- Sheets/Firestore/운영 데이터 쓰기와 수정 후 재조회
- 여러 저장소의 exact revision을 묶는 최종 통합 검증

권한·IAM·Secret·운영 배포·외부 쓰기는 사용자의 직전 승인 후 Codex가 실행한다.

## 무료 채팅에 붙여넣을 시작 프롬프트

```text
FreePass Data 작업을 검토해 줘. 너는 파일 수정, Git/GitHub/GCP 실행, 배포 완료 판정을 하지 말고
내가 아래에 붙이는 자료만 기준으로 분석해. 사실/추론/제안을 구분하고, 오래됐거나 실제 원본을
재조회해야 하는 항목은 CURRENT라고 추정하지 말고 VERIFY/HOLD로 표시해.

프로젝트 경계:
- FreePass Data는 공유 데이터 사실/계약/projection/release를 소유한다.
- Admin/Sales/Estimate의 UI·workflow·계산 엔진은 소유하지 않는다.
- RTDB는 영구 폐기됐고 fallback으로 쓰지 않는다.
- FULL 원천 캡처, 테스트 PASS, PR merge, 배포, consumer cutover는 서로 다른 상태다.

응답 형식:
1. 목적
2. 확인된 사실
3. 모순/누락/반례
4. 무료 채팅에서 완성할 초안
5. Codex에서 실행해야 할 정확한 검증
6. HOLD

[여기에 Issue, 문서, diff 또는 로그를 붙여넣기]
```

## Codex 재진입 프롬프트

```text
C:\dev\freepass-data에서 작업해. 먼저 AGENTS.md와
docs/PROJECT-CLOSURE-AND-FREE-CHAT-HANDOFF.md를 읽고, origin/main을 fetch한 뒤 local/main/remote,
dirty worktree, 열린 PR/Issue/Actions를 실측해. 무료 채팅 초안은 정본으로 간주하지 말고 검증해.
이번 작업이 G1~G5 중 무엇을 닫는지 선언하고, 범위를 벗어난 확장은 하지 마.
결과는 목적 / 대상 revision / 변경 / 검증 / 남음 / next_start_here로 남겨.
```

## 현재 next_start_here

1. 브라우저 OAuth로 `pyh@teamjpk.com`의 `gcloud` 재인증을 완료한다.
2. `freepasserp5` API/IAM/Artifact Registry/Secret/WIF/Cloud Run 상태를 읽기 전용으로 재조회한다.
3. G1 bootstrap 변경안과 rollback을 제시하고 사용자 직전 승인을 받는다.
4. 승인 후 G1을 실행·readback하고 G2 Preview로 넘어간다.
