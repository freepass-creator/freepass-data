# SOURCE-ENGINE SPEC3D + 3E 결과

판정: 요청 구현 및 관련 오프라인 검증 PASS. 운영 적용은 미실행.

## 목적 / 대상 revision / 사전점검

- 정본: `docs/SOURCE-ENGINE-SPEC3D-20261012.md`의 3D 월렌트 및 3E 신규 편입 필수 칸.
- 시작 HEAD: `a044f43f60bc9172ef343154ab9fc93f2324d955`. 시작 작업 트리는 clean이며 기존 보정은 이 WIP 커밋에 포함되어 있었다. 이번 변경은 미커밋 상태다.
- 사용자 실행 규칙에 따라 SPEC 영수증으로 사전점검을 갈음했다. 네트워크, 외부 검토, 원격 main/Issue/PR 확인은 생략했으며 PASS로 계산하지 않는다.
- 기존 native mapper, plugin, cycle planner/job, Firestore command port, 시험을 확장했다. 공급사 이름 설정은 기존 `contracts/supplier-input-sheet-spec.v1.json`의 supplierChannels를 재사용한다. 새 엔진/저장 경로 없음. CREATE_NEW_JUSTIFIED: 신규 파일은 사용자가 지정한 이번 결과 문서이며 기존 RESULT3C는 과거 검증 이력으로 보존한다.

## 변경

- `src/adapters/source-cycle-native.ts`: 월렌트 A=차종/B=1개월 머리글과 기존 숨김·읽기 완전성 검사 유지. 숫자/숫자 문자열 요금만 편입하고 x/빈칸/비숫자는 제외한다. UID는 `RP004:MONTHLY:` + NFKC/공백 제거/대문자 차종이며 행 번호를 사용하지 않는다. 중복은 첫 줄만 유지하고 `DUPLICATE_UID_SUSPECT`로 남긴다.
- 월렌트는 `MONTHLY_RENT`, plate=null, 원문 차명, 판매 가능, 1개월만 저장한다. 비고의 무보증은 ZERO, 그 외는 UNKNOWN/null과 `보증금 확인 필요` 근거를 보존한다. 차종 4칸은 기존 신규 편입 규칙으로 빈칸+확인 필요다. 차명이 없는 숫자 행은 `MONTHLY_MODEL_REQUIRED`이며 번호미배정으로 집계하지 않는다.
- `src/adapters/source-cycle-plugins.ts`, `src/application/source-cycle.ts`: 새 MONTHLY_RENT를 변환/계획에 포함한다. 구형 MONTHLY/월렌트 관측 문서는 기존 보호대로 자동 하향하지 않는다.
- `src/jobs/source-cycle.ts`: 요약에 `장기 N · 월렌트 N`을 별도 표시한다. 월렌트는 번호미배정에서 제외한다.
- `src/infra/source-cycle-firestore.ts`, `src/ports/source-cycle.ts`, planner: 같은 provider_company_code의 모든 기존 문서에서 provider_name과 policy_code를 각각 최빈값으로 선정한다(listable 무관). 빈 문자열은 제외하고 동률은 문자열 순서로 고정한다. 이름이 없으면 기존 공급사 코드→이름 설정을 사용하며, 그래도 없으면 신규 편입만 `SUPPLIER_NAME_REQUIRED`로 보류한다.
- 두 필드는 신규 계획/digest에 포함되고 적용 전 새 목록으로 재검증된다. 신규 문서 PATCH와 실제 필드 되읽기 검증에 포함하며 UPDATE/REEXPOSE/DOWNGRADE의 updateMask에는 추가하지 않는다. 기존 값은 보존한다. 이름 설정만 있고 정책코드 근거가 없으면 policy_code=null로 명시하며 임의 코드를 추정하지 않는다.
- 기존 gws 읽기, Firestore 필드 경로 인용, 빈 기간 규칙, 보증금 UNKNOWN 허용을 유지했다. 이에 뒤처진 시험의 옛 월렌트 머리글과 UNKNOWN 보증금 차단 기대만 현행 규칙에 맞췄다.

## 검증

- `npm.cmd test -- tests/source-cycle-runtime.test.ts tests/source-cycle.test.ts tests/source-engine.test.ts tests/shared-sheet-canonical.test.ts tests/source-intake.test.ts`: **5파일 260 PASS / 0 FAIL / 0 SKIP**.
- 신규 회귀 6개: 월렌트 숫자/x/빈칸/무보증 비고/중복·UID 충돌 없음/UNKNOWN 편입/원문·차종 빈칸/실제 fake REST 필드/2회 멱등/그룹별 요약, 기존 3문서 독립 최빈값, 이름 없는 미등록 공급사 보류, 기존 이름 설정 fallback, UPDATE 두 필드 보존, 승인 후 최빈값 변경 시 재계획 차단.
- TypeScript build, architecture boundary, data-access boundary 및 diff 공백 검사 PASS.
- 합성 캡처와 주입 fake fetch만 사용했다. 운영 Firestore/시트 쓰기, 외부 네트워크, 커밋/push/배포/예약 등록 없음.
- 전체 Vitest는 이번에 실행하지 않았다. 이전 RESULT3C의 전체 시험 실패/조건부 SKIP을 해소했다고 주장하지 않는다. 초기 관련 시험의 옛 기대 실패 및 편집 중 문법 오류는 수정 후 위 최종 묶음에서 통과했다.

## 남음 / next_start_here

- 이 문서 → SPEC3D → 변경 diff와 관련 시험을 읽는다. 계획 구조에 supplierFields가 추가되므로 옛 승인 digest를 재사용하지 말고 새 계획을 만든다.
- 라이브 담당은 허용 환경에서 원천·기존 문서 최빈값·정책코드 null 여부 및 장기/월렌트 수를 새 읽기 전용 계획으로 확인한다. 구형 월렌트 문서 정리/이전은 이번 구현 범위 밖이다.
- 운영 연결·라이브 되읽기·ERP5 실제 출력·전체 시험 통과는 미검증 상태다. 이번 결과를 운영 완료나 소비처 전환으로 확대하지 않는다.
