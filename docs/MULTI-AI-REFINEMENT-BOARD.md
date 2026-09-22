# FreePass Data 다중 AI 고도화 검토판

상태: **ACTIVE / 의견 수집용 / 운영 승인 아님**  
대상 저장소: `freepass-creator/freepass-data`  
현재 작업 기준: `codex/local-runtime-baseline` / `a1fc717`  
운영 데이터 대상: Firebase project `freepasserp5` / Firestore  
현재 승인 구현 범위: **Catalog V1 — 상품·차량·가격·정책**

장기 고정 목표: 권한이 있는 사용자가 “FreePass Data에서 가져와”라고 요청하면
`freepasserp5`의 모든 관리 대상 데이터 도메인을 이곳에서 발견하고, 승인된 계약을
통해 조회할 수 있어야 한다. 현재 Catalog V1 구현 범위와 전체 도메인 연결 목표를
혼동하지 않는다.

## 1. 이 문서의 목적

이 문서는 Codex, Claude Code 및 사용자 GPT 채팅에서
FreePass Data의 설계와 구현을 독립적으로 검토하고 고도화하기 위한 공동 검토판이다.

AI 의견의 개수나 합의는 정확성 증거가 아니다. 최종 판단 순서는 다음과 같다.

1. 원본·공식 근거
2. 재현 가능한 테스트와 계산
3. 시스템 로그·실행·readback 증거
4. AI 검토 의견

검토 불가, 로그인 실패, 사용량 제한은 `UNAVAILABLE`로 기록한다. PASS로 바꾸지 않는다.
이 문서에 `READY`, `추천`, `승인 가능`이라고 적혀 있어도 배포, IAM 변경, 운영 쓰기,
시트 수정, 소비처 전환 또는 writer cutover가 승인된 것은 아니다.

## 2. 고정된 정본과 경계

- GitHub 저장소는 코드·스키마·계약의 정본이며 운영 데이터 저장소가 아니다.
- `freepasserp5` Firestore는 현재 관리할 운영 데이터 대상이다.
- FreePass Data는 모든 관리 대상 데이터의 단일 발견·조회 진입점이 된다.
- 미구현 도메인도 존재를 숨기지 않고 제공 상태와 차단 이유를 `HOLD`로 알려야 한다.
- 단일 진입점은 Firestore 전체 덤프가 아니다. 도메인·조직·사용자·목적·필드 권한별 계약을 적용한다.
- 데이터 흐름은 `Source -> RAW -> Normalized Candidate -> Canonical -> Projection -> Release -> Consumer`다.
- RAW 원문은 덮어쓰지 않는다. 수정은 검증된 command, revision, audit, lineage, receipt로 남긴다.
- 소비처는 내부 Firestore collection을 장기 공개 계약으로 사용하지 않는다.
- F01·F86은 중앙 정본에서 생성되는 출력물이다.
- ERP.com, 각 화이트라벨, Admin은 검증된 ACTIVE Release와 소비 증거를 가져야 한다.
- RTDB는 영구 폐기됐다. Firestore parity 부족은 `HOLD`이며 RTDB fallback 사유가 아니다.
- Sales 고객/통화, 신청/계약, 정산/재무의 운영 이관은 현재 Catalog V1 승인 범위 밖이다.
- 운영 배포, IAM, writer 전환, 실제 데이터 쓰기, 스케줄 활성화는 별도 실행 단위다.

## 3. 현재 확인된 기준선

### 구현됨

- VehicleModel / VehicleAsset / Product / Offer / PriceTerm / Policy 모델
- immutable RAW, Normalized Candidate, 검토된 Canonicalization
- expected revision, idempotency receipt, append-only audit와 revision history
- field authority와 field-level lineage
- durable outbox와 evidence-gated Projection Release
- writer ownership의 `SHARED_MIGRATION -> EXCLUSIVE` 전환 계약
- 로컬 Console의 데이터 흐름 추적과 제한된 가격 변경 데모
- ERP·F01·F86용 upstream / legacy / FreePass Data 3자 비교 검사
- F01/F86 표시 및 소비처 분류 계약

### 아직 완료되지 않음

- 검증된 runtime service/user 인증과 IAM
- ERP5 전체 원천을 위한 정확한 수집기와 매퍼
- 실제 데이터의 RAW -> Candidate -> Canonical -> ACTIVE Release 생성
- ERP.com·화이트라벨의 shadow read와 실제 UI readback
- Admin projection 통합과 policy parity
- F01/F86 writer의 FreePass Data Release 연결과 consumer receipt
- backup/restore 및 마지막 정상 Release 복구 검증
- 운영용 Data Explorer / Entity Detail / Command Edit

### 현재 운영 관측

2026-09-21의 count-only 읽기에서는 기존 `products=1659`, `policy=81`이 관측됐고,
FreePass Data Canonical product/offer/policy 및 ACTIVE projection은 0건이었다.
이 수치는 시점이 있는 관측값이며 새 검토에서는 다시 읽어야 한다.

### 진행 중 작업과 충돌 주의

- `a1fc717`에 Console, trace, 소비처 전환 계약, data-domain catalog와 read-pilot 기준선을 커밋했다.
- PR #23: `freepasserp5` 명시적 binding과 인증된 read-only consumer runtime. 운영 미배포.
- PR #12: Admin Catalog Projection. 현재 통합 충돌과 policy parity HOLD가 있다.
- 기존 변경을 reset, stash, overwrite 또는 무단 병합하지 않는다.

## 4. 이번 고도화의 핵심 질문

각 검토자는 아래 질문에서 자신의 전문 영역을 우선하되, 근거 없는 범위 확장을 피한다.

1. `freepasserp5`의 기존 product/policy 구조를 손실 없이 Catalog V1으로 수집하려면 어떤 source identity, coverage, pagination, digest 증거가 필요한가?
2. Product, Offer, PriceTerm, VehicleModel, VehicleAsset, Policy 매핑에서 누락되거나 잘못 합쳐질 가능성이 큰 의미는 무엇인가?
3. 기존 데이터의 미관측, 판매, 출고불가, 정보부족, 수집실패를 어떻게 구분하고 보존해야 하는가?
4. 인증된 read service와 write command service를 어떤 runtime/IAM 경계로 분리해야 하는가?
5. PR #23과 PR #12를 어떤 순서와 최소 충돌 단위로 통합해야 하는가?
6. 실제 운영 데이터 생성 전에 필요한 dry run, backup, rollback, digest, readback 증거는 무엇인가?
7. ERP.com, 화이트라벨, Admin, F01, F86 각각의 parity와 consumer receipt 완료 조건은 무엇인가?
8. Console에서 사용자가 안전하게 조회·추가·수정·HOLD 처리하기 위해 반드시 보여야 할 정보와 차단 조건은 무엇인가?
9. 현재 테스트가 놓칠 수 있는 치명적 반례와 운영 장애 시나리오는 무엇인가?
10. Catalog V1 범위를 지키면서 지금 가장 작은 다음 구현 단위는 무엇인가?
11. 전체 관리 대상 도메인을 누락 없이 발견할 data-domain catalog는 어떤 필드와 상태를 가져야 하는가?
12. 자연어 요청 “FreePass Data에서 가져와”를 어떤 도메인 계약·권한·필터로 안전하게 해석할 것인가?

## 5. 채팅에 전달할 공통 프롬프트

아래 블록을 이 문서와 함께 검토 채팅에 전달한다. 민감한 원문, 고객정보, 차량번호,
인증정보는 보내지 않고 필요한 최소 비식별 발췌만 제공한다.

```text
첨부한 `docs/MULTI-AI-REFINEMENT-BOARD.md`를 현재 공통 기준으로 사용해 주세요.

역할: FreePass Data Catalog V1의 독립 검토자
목표: 구현자의 설명을 전제하지 말고, 운영 실패를 일으킬 반례와 누락을 찾는다.

검토 원칙:
- freepasserp5 Firestore가 관리 대상이다.
- RAW 원문, ID, revision, lineage, HOLD를 보존한다.
- RTDB 복구나 fallback을 제안하지 않는다.
- 테스트 통과, 코드 존재, 배포 Ready만으로 운영 완료라고 판단하지 않는다.
- 확인하지 못한 내용은 UNKNOWN 또는 UNAVAILABLE로 적는다.
- 운영 변경을 직접 실행하지 말고 읽기 전용으로 검토한다.

다음 형식으로 답해 주세요.
1. 판정: PASS / HOLD / FAIL / UNAVAILABLE
2. 확인한 정본과 범위
3. 치명·중대·경미 이슈
4. 가장 위험한 반례 3개 이내
5. 권장하는 최소 다음 변경
6. 필요한 테스트·원본 대조·운영 readback
7. 반영하면 안 되는 제안 또는 범위 확장
8. 남은 불확실성

가능하면 파일과 코드 위치를 명시하고, 추론과 확인된 사실을 구분해 주세요.
```

## 6. 역할별 추가 요청

### 사용자 GPT 채팅 — 작은 고도화와 사용성 개선

GPT 채팅은 저장소를 직접 실행하거나 운영 상태를 확인했다고 가정하지 않는다. 대신 사용자가
겪은 불편을 작은 요구사항으로 정리하고, 현재 계약을 깨지 않는 수정안·문안·화면 흐름·테스트
반례를 만드는 데 우선 사용한다. GPT의 강점은 짧은 반복으로 이름, 설명, 빈 상태, 오류 문구,
검색·필터, 작은 API 응답과 문서 구조를 다듬는 것이다.

GPT가 잘 고도화하려면 매 요청에 최소한 다음 입력을 함께 준다.

1. 기준 commit과 관련 파일 1~5개
2. 사용자가 실제로 겪은 전후 상황 또는 화면
3. 바꾸려는 한 가지 결과와 건드리면 안 되는 계약
4. 현재 테스트와 실패 로그 또는 `UNKNOWN`
5. 제안만 필요한지, Codex가 적용할 patch 후보까지 필요한지

GPT는 큰 재설계보다 아래 크기의 변경을 우선 제안한다.

- 기존 함수·컴포넌트·문서를 확장하는 한 단위
- 사용자가 바로 체감하는 검색, 필터, 정렬, 설명, 오류 상태 개선
- 기존 구현을 그대로 복제하지 않는 반례 테스트
- HOLD·출처·revision·consumer 상태를 더 분명하게 보여주는 개선
- Codex가 한 번의 diff와 한 묶음의 검사로 검증할 수 있는 변경

GPT가 하지 말아야 할 일은 다음과 같다.

- 실제 저장소·Firestore·Google Sheet·배포 상태를 보지 않고 완료라고 선언하기
- 새 데이터베이스, registry, service, 상태값을 기존 자산 검색 없이 추가하기
- 누락값을 임의 추정하거나 HOLD를 정상값으로 바꾸기
- RTDB fallback, 운영 쓰기, IAM 변경, 소비처 전환을 승인된 것으로 가정하기
- 한 요청에서 UI, 스키마, 수집기, 운영 전환을 모두 다시 설계하기

GPT 결과는 아래 형태면 Codex가 가장 빠르게 적용·검증할 수 있다.

```text
1. 관찰한 문제
2. 사용자에게 보일 개선 결과
3. 재사용할 기존 파일·함수
4. 제안 변경(파일별)
5. 깨질 수 있는 계약과 반례
6. 필요한 테스트
7. 확인하지 못한 것
8. Codex용 next_start_here
```

#### 사용자 GPT 채팅용 고도화 프롬프트

```text
첨부한 MULTI-AI-REFINEMENT-BOARD.md와 지정한 파일만 기준으로 FreePass Data를
한 단계 고도화해 주세요. 이번 요청은 작은 개선 단위 하나로 제한합니다.

먼저 현재 구현에서 재사용할 파일·함수·계약을 찾고, 새 구조는 꼭 필요한 경우에만
제안하세요. RAW, ID, revision, lineage, HOLD, Firestore-only 원칙을 보존하고
RTDB fallback은 제안하지 마세요. 확인하지 못한 운영 상태는 UNKNOWN으로 적으세요.

답변은 다음 순서로 작성하세요.
1. 현재 문제와 사용자 영향
2. 가장 작은 권장 변경
3. 재사용할 기존 자산
4. 파일별 변경안 또는 patch 후보
5. 반례와 회귀 위험
6. 테스트와 실제 readback 방법
7. 남은 UNKNOWN
8. Codex가 바로 시작할 next_start_here

화면이나 문구 개선이라면 정상, 빈 상태, 로딩, 권한 없음, 실패 상태를 함께 검토하세요.
데이터 변경이라면 원본 수, 불변 ID, revision, 누락·중복, consumer 영향을 분리하세요.
코드나 문서를 만들었다고 운영 완료라고 쓰지 마세요.
```

### Codex — 실행 통제와 최종 통합

- 현재 branch, commit, dirty worktree, 열린 PR의 겹침을 먼저 확인한다.
- 저장소·로컬 실행·연결 도구의 증거를 직접 검증한다.
- 의견의 충돌을 원본과 재현 가능한 검사로 해소한다.
- 최종 변경, 테스트, diff, 미확인 항목과 운영 경계를 정리한다.

### Claude Code — 설계·논리·문안 반례

- 책임 경계, 용어, 상태 전이, 완료 조건의 모순을 찾는다.
- 데이터 소유권과 업무 workflow 소유권이 섞인 지점을 찾는다.
- HOLD가 자동 정규화나 낙관적 표현으로 사라지는 지점을 찾는다.
- 기본은 읽기 전용이며 원문·비밀정보를 프롬프트에 포함하지 않는다.

### Cursor Agent — 사용자가 직접 지정한 경우의 코드·회귀 검토

- 변경 파일과 인접 코드에서 타입, 인증, 상태, 트랜잭션, 예외 처리를 검토한다.
- PR #23, PR #12와 로컬 dirty 변경의 충돌 지점을 확인한다.
- 테스트가 구현을 그대로 복제하거나 중요한 반례를 놓치는지 확인한다.
- 기본은 읽기 전용이며 파일을 수정하지 않는다.

### Gemini CLI — 사용자가 직접 지정한 경우의 Google Workspace 대조

- F01/F86 및 Google-native 자료가 필요할 때 파일 ID, 탭, 범위, 수정 시각을 고정한다.
- 표의 누락, 중복, 합계, 기간별 금액·보증금, 탭 분류를 대조한다.
- OCR·추출 결과의 금액, 날짜, ID는 원본 셀이나 이미지와 재대조한다.
- 비식별 최소 발췌만 사용하며 Workspace 접근 불가를 PASS로 처리하지 않는다.

## 7. 의견 기록 양식

각 검토 결과를 아래 양식으로 추가한다. 검토자의 답변을 다듬어 의미를 바꾸지 않는다.

```markdown
### REVIEW-YYYYMMDD-NN — 검토자 / 주제

- 검토자:
- 도구·모델:
- 검토 시각:
- 기준 branch / commit:
- 검토 파일·범위:
- 판정: PASS / HOLD / FAIL / UNAVAILABLE
- 확인된 사실:
- 추론·제안:
- 치명 이슈:
- 중대 이슈:
- 경미 이슈:
- 반례:
- 필요한 검증:
- 남은 불확실성:
```

## 8. 의견 통합과 결정 기록

Codex는 의견을 그대로 합산하지 않고 아래 표로 판정한다.

| ID | 제안·이슈 | 근거 종류 | 영향 | 결정 | 이유 | 검증·후속 |
|---|---|---|---|---|---|---|
| DEC-001 | 작성 대기 | UNKNOWN | UNKNOWN | HOLD | 원본 검토 전 | 증거 연결 필요 |

결정 값은 다음 중 하나다.

- `ACCEPT`: 범위와 근거가 맞아 구현 또는 문서에 반영
- `REJECT`: 반례 또는 정본과 충돌하여 반영하지 않음
- `HOLD`: 중요한 증거·권한·원본 확인이 부족함
- `SUPERSEDED`: 더 최신 결정이나 증거로 대체됨

중요한 의견 불일치는 다음 순서로 해결한다.

`원본·공식 근거 > 재현 가능한 테스트 > 실행 로그·readback > AI 추론`

## 9. 구현 작업 단위 양식

의견 통합 후 실제 작업은 한 번에 하나의 검토 가능한 단위로 만든다.

```markdown
### WORK-YYYYMMDD-NN — 작업명

- 문제:
- 사용자에게 보이는 결과:
- 정본 branch / commit:
- 변경 파일:
- 제외 범위:
- 데이터 읽기 범위:
- 데이터 쓰기 범위:
- 권한·승인 필요 여부:
- 실패 시 HOLD 조건:
- 테스트:
- 운영 readback:
- rollback:
- 완료 조건:
```

## 10. 완료 판정

한 작업은 다음을 모두 만족해야 완료로 기록한다.

- 정본과 대상 범위가 고정됨
- 요청 범위 밖 변경이 없음
- 필수 타입검사·테스트·빌드가 통과함
- 실제 데이터 작업이면 원본 수, coverage, digest, 누락·중복을 검증함
- 변경 뒤 새로운 조회로 결과를 확인함
- 소비처 작업이면 실제 API·시트·UI와 release ID를 확인함
- 치명·중대 오류와 필수 검증 미통과가 0건임
- 미확인 항목은 완료 문구에서 제외하고 HOLD로 남김

AI 검토만 완료되고 위 증거가 없으면 상태는 `REVIEWED`, `READY_FOR_REVIEW` 또는 `HOLD`다.
`DONE`, `MIGRATED`, `LIVE`로 기록하지 않는다.

## 11. 현재 의견 수집 현황

| 검토 ID | 검토자 | 주제 | 판정 | 상태 |
|---|---|---|---|---|
| REVIEW-PENDING-DESIGN | Claude Code | 책임 경계·상태 전이·반례 | 대기 | 읽기 전용 검토 필요 |
| REVIEW-GPT-GUIDE | 사용자 GPT 채팅 | 작은 고도화·사용성 개선 | READY | 공통 프롬프트와 반환 형식 준비 |
| REVIEW-CODEX-BASELINE | Codex | 저장소·인수인계·현재 검사 | HOLD | 로컬 검사는 통과했으나 운영 Canonical/Release 0건 |
