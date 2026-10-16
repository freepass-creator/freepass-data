# SOURCE-ENGINE SPEC3C 결과

판정: **요청 코드 및 관련 오프라인 회귀 통과. 전체 시험 통과 조건은 HOLD.**

## 목적 / 대상 revision / 사전점검

- 정본: `docs/SOURCE-ENGINE-SPEC3C-20261012.md` 및 선행 SPEC3B/RESULT3B.
- 시작 HEAD: `679c779d18f601c8e2124d71ff7f8999194da3bd`. 기존 미커밋 변경 위 최소 수정이며 커밋하지 않았다.
- 사용자 실행 규칙에 따라 SPEC 영수증으로 Academy 사전점검을 갈음했다. 네트워크·원격 main/Issue/PR·외부 AI 검토는 생략했고 PASS로 계산하지 않는다.
- 기존 native mapper, 공통 planner/job/port, 기존 시험을 재사용했다. 신규 엔진·저장 경로 없음. 신규 문서는 사용자 지정 결과 파일뿐이다.

## 변경

- `src/adapters/source-cycle-native.ts`: 시작 작업 트리에 이미 있던 빈 기간 제외를 유지하고 의미를 명시했다. null/undefined/빈 문자열/공백은 기간을 만들지 않으며 값이 있는 미해석 대여료는 UNKNOWN으로 보존한다. F05의 대상 탭 누락·부분 행 범위는 완전한 읽기로 인정하지 않는다.
- `src/ports/source-cycle.ts`, `src/application/source-cycle.ts`: 계획에 `unassignedPlateCount`, 비차단 `warnings`를 추가했다. 번호미배정 등 신원 보류가 있으면 `ABSENCE_DOWNGRADE_SKIPPED`를 남기고 SOURCE_ABSENT 하향만 생략한다. 정상 UID의 ENROLL/UPDATE/REEXPOSE 및 명시적 SOURCE_NOT_SELLABLE 하향은 기존 검증·계약락·하향 비율 제한 아래 계속 계획한다.
- 실제 읽기 불완전은 `SOURCE_INCOMPLETE` blocker로 적용 전에 차단한다. 행 UID 보류를 읽기 complete=false로 바꾸지 않는다. 기존 숨김 메타데이터·범위·읽기 오류 보호는 유지한다.
- `src/jobs/source-cycle.ts`: 아이카와 F05 공통 경로에서 번호미배정 수를 evidence/plan/요약에 전달한다. 승인 계획 재대조에서도 번호미배정 수 변경을 검사한다. complete 읽기에 번호미배정만 있으면 실패 횟수를 올리지 않는다.
- `tests/source-cycle-runtime.test.ts`, `tests/source-cycle.test.ts`: 8개 회귀 추가. 48개월만 채운 4종 빈칸, 아이카/F05 각각 정상 동작 4종과 누락 하향 0, F05 범위 오류, 불완전 읽기 적용 전 차단을 검증한다.
- 기존 gws transport·Firestore 백틱 필드 경로·SPEC3B 매핑·월렌트 제외 및 다른 미커밋 변경은 보존했다.

## 검증

- 최종 관련 시험: **5파일 254 PASS / 0 FAIL / 0 SKIP**. runtime 60, cycle 42, engine 24, shared-sheet-canonical 111, source-intake 17.
- 최종 전체 Vitest: **3276 PASS / 18 FAIL / 18 SKIP**, 172파일 PASS / 8파일 FAIL / 4파일 SKIP. 전체 통과라고 선언하지 않는다.
- 실패 파일: daily-writer-guard, iancar-one-api, iancar-source-capture, projection-integrity, read-pilot, runtime-baseline-deployment, runtime-policy, vehicle-finder-route. 로그에는 하위 CLI의 `uv_os_homedir`, 디렉터리 생성 및 jq 실행 Permission denied, 로컬 서버 ECONNREFUSED가 확인된다. 실행 환경을 우회하거나 범위 밖 코드를 수정하지 않았다.
- 초기 전체 실행에는 신규 범위 시험의 `INVALID_SHARED_SHEET_CAPTURE`도 있었다. 기존 converter가 malformed capture를 예외로 거부하므로 시험을 실제 plugin.read 경계에서 complete=false를 확인하도록 고쳤다. 이후 전체 결과에서 해당 실패는 사라졌다. malformed fixture의 literal 타입 오류도 수정 후 build 통과했다.
- TypeScript build, architecture boundary, data-access boundary 통과. 최종 diff 공백 검사 통과.
- 시험의 Firestore·원천 자료는 합성/주입 자료다. 외부 네트워크·운영 쓰기·커밋·push·배포·예약 등록 없음. 전체 시험의 로컬 loopback 서버 검사는 위 환경 오류로 실패했다.

## 남음 / next_start_here

- 이 결과 → SPEC3C → 관련 두 cycle 시험을 시작점으로 삼는다. 계획 필드가 바뀌므로 과거 저장된 계획/digest를 재사용하지 말고 새 계획을 생성한다.
- 허용된 시험 환경에서 남은 전체 시험 18건과 조건부 SKIP을 재확인해야 한다. 현재 전체 시험 통과 조건은 HOLD다.
- 실제 아이카 12건 및 F05 번호 없는 4줄의 라이브 재조회는 하지 않았다. 합성 시험 통과를 해당 운영 레코드의 정상화 완료로 확대하지 않는다. 별도 허용 환경에서 새 읽기 전용 계획으로 확인한다.
