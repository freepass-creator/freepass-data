# FreePass Data 종료 계획과 무료 채팅 인계

상태: **READ-ONLY OPERATIONS v1.0 / COST-AWARE HANDOFF**
작성 기준 revision: `ff591ef835179439828f81aa5b4f605356964c84`
기준일: 2026-09-28

## 목적

FreePass Data를 끝없이 확장하지 않는다. 아래 종료 게이트를 닫으면 플랫폼 기반 구축을
완료하고, 이후 기능은 각 소비 프로젝트의 독립 업무로 넘긴다. 분석·문안·체크리스트처럼
로컬 실행이 필요 없는 일은 무료 ChatGPT에서 먼저 처리하여 Codex 사용량을 아낀다.

## 현재 정본

- GitHub/code 정본: `freepass-creator/freepass-data`의 `main`
- 운영 원천: `freepasserp5` Firestore
- 실제 현재 main은 작업 시작 때 `git fetch` 후 다시 확인한다. 이 문서의 작성 기준 SHA를 현재값으로 추정하지 않는다.
- 최신 ERP5 감사: products 1,659 / policy 81 / partner 64, `FULL_SAME_READ_ONLY_TRANSACTION`
- 최신 공개 판정: `HOLD`
- 금지: RTDB 복구, 빈 Canonical/Release를 성공으로 간주, 테스트 결과를 배포·전환으로 확대

숫자와 상태는 시점값이다. 다음 작업자는 GitHub Actions와 실제 소비처를 다시 읽고 사용한다.

`source.digest`는 `readTime`과 `capturedAt`을 포함한 capture 전체 digest라 관측마다 달라진다.
`change.status=NO_CHANGE`는 두 FULL capture의 상품별 `fields` fingerprint를 비교한 결과다. 따라서
capture digest가 달라도 ADDED/CHANGED/MISSING이 모두 0이면 모순이 아니다.

## 프로젝트 종료 게이트와 실행 순서

종료 순서는 `G3 + G4 병렬 -> G1 -> G2 -> G5`다. GCP 변경을 기다리는 동안 경계와 소비자
인계를 먼저 닫되, 운영 배포·전환 증거를 추정하지 않는다.

### G1. 중앙 read runtime 운영 기반

상태: **COMPLETE (2026-09-28)** — run `36327937895`, Ready revision
`freepass-data-read-00011-4sw`, immutable digest
`sha256:90d2b9da9361da3facd774eadf19a412ad6cc712f36f7575a566e4d226dd013c`,
미인증 403, 인증된 compatibility readback 200.

- 필요한 GCP API, Artifact Registry, deploy/runtime identity, Secret Manager와 GitHub WIF를 준비한다.
- private Cloud Run read runtime을 immutable main SHA로 배포한다.
- 서비스 Ready, 인증 거부, 정상 consumer readback을 모두 확인한다.

### G2. ERP.com 첫 실제 소비자 연결

- Preview에서 `LEGACY_DIRECT -> OBSERVE -> SHADOW_READ` 순서로 진행한다.
- 실제 상품/정책/상업 조건 projection을 legacy 결과와 비교한다.
- 사용자 GO 전에는 `FREEPASS_DATA_READ`로 전환하지 않는다.

### G3. Canonical publication 경계 확정

- ERP5 FULL 캡처가 Canonical write 승인을 뜻하지 않음을 코드와 계약으로 강제한다.
- 현재 판정이 `HOLD`면 정확한 사유를 기록하는 것으로 이 종료 게이트를 닫을 수 있다.
- ACTIVE 승격은 review evidence, non-empty validated Release, manifest/digest/readback을 모두 요구하는
  별도 승인 트랙이다. 1,659건 mapping HOLD 해소를 기반 구축 종료 조건으로 만들지 않는다.

### G4. 핵심 소비자 인계

- ERP/화이트라벨, Admin, Sales, Estimate, F01/F86 각각에 contract, switch key, 현재 단계,
  남은 HOLD와 `next_start_here`를 남긴다.
- FreePass Data가 각 제품의 UI·workflow·계산 엔진까지 소유하지 않는다.

현재 인계 정본은 [`CONSUMER-SWITCHBOARD.md`](./CONSUMER-SWITCHBOARD.md)다. 각 행은 실행 전
consumer 저장소의 실제 revision/runtime을 다시 읽으며, 표의 단계만으로 전환 완료를 주장하지 않는다.

열린 Issue의 종료 분류:

- `#209` ERP.com read runtime activation: **G1 COMPLETE**, 운영 증거 기록 후 종료 대상
- `#137` Vehicle Finder provider/E2E: **consumer integration handoff**, Data 기반 종료와 분리
- `#64` Estimate vehicle facts: **evidence-backed data extension HOLD**, 별도 승인 트랙
- `#55` Estimate issued quote: main에 Quote v2/Share Envelope 구현이 있으나 emulator/concurrency 및
  소비처 readback을 재검증하기 전에는 Issue 완료로 추정하지 않음
- `#24` North Star: G1~G5 종료 증거를 모으는 상위 handoff

### G5. 종료 증거

- `main`과 로컬 HEAD 동일
- Core CI/Canon Guard PASS
- read runtime service/revision/image digest, `Ready=True`, 미인증 403과 인증된 readback evidence
- 최신 `docs/NEXT-START-HERE.md`와 `docs/IMPLEMENTATION-STATUS.md`
- 열린 Issue를 `완료 / 소비 프로젝트 이관 / 명시적 HOLD`로 재분류
- 정의된 종료 범위에서 발견된 치명·중대 오류와 필수 검증 실패 0

G1~G5가 닫히면 FreePass Data 기반 구축을 **CLOSED / OPERATIONS MODE**로 바꾼다. 이는 ERP.com
cutover 완료, ACTIVE Release 존재 또는 mapping HOLD 해소를 뜻하지 않는다.

OPERATIONS MODE에서는 보안 패치, dependency/runtime 갱신, 인시던트 대응, 감사 관측, 승인된
release 운영과 문서 갱신만 기본 허용한다. 신규 collection/contract/projection/consumer,
Canonical write, ACTIVE 승격과 schema 변경은 새 사용자 승인 업무다.

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

1. 로컬 작업은 `gcloud config configurations activate freepass-data`로 공통 설정을 선택한다.
2. Issue #209의 최신 성공 evidence와 run `36327937895`를 기준으로 G1을 재검증한다.
3. FreePassERP 소비 프로젝트에서 별도 작업으로 Preview `OBSERVE`를 연결한다.
4. parity와 rollback을 확인한 뒤에만 사용자에게 G2 `SHADOW_READ` 진행 여부를 묻는다.
5. Canonical write, ACTIVE release, Sheet writer, `FREEPASS_DATA_READ` cutover는 계속 HOLD다.
