# 원천 엔진 SPEC3B — 아이카 실제 시트 매핑 보정 결과

판정: **코드·오프라인 합성 시험 완료. 라이브 원천 대조·운영 적용은 HOLD.**

## 목적 / 대상 revision / 정본

- 정본: `docs/SOURCE-ENGINE-SPEC3B-20261012.md`. SPEC3/RESULT3와 저장소 진입 문서를 함께 확인했다. 이전 RESULT3의 아이카 기간별 보증금·차명·월렌트 설명은 이 보정으로 대체한다.
- 시작 HEAD: `679c779d18f601c8e2124d71ff7f8999194da3bd`. 커밋하지 않은 작업 트리 변경이다.
- 사용자 실행 규칙에 따라 SPEC 영수증으로 사전점검을 갈음했다. 네트워크·원격 main/Issue/PR 확인·Academy CLI·외부 AI 호출은 생략했다. Claude 검토는 미실행이며 PASS로 계산하지 않는다.
- 기존 native mapper, cycle plugin/planner, Firestore reader, runtime, 시험을 확장했다. 새 엔진·저장 경로 없음. 결과 문서만 사용자 지정 경로에 신규 생성했다.
- 시작 시 존재한 runtime gws 시트 읽기 및 Firestore 백틱 필드 경로/pageSize 수정은 보존했다. 제공 SPEC3B도 수정하지 않았다.

## 변경

| 파일 | 이번 변경 |
|---|---|
| `src/adapters/source-cycle-native.ts` | 실제 A–Y 헤더 매핑, 장기보증 공통 적용, 36/48/60개월 중 값 있는 기간만 생성, 쉼표 금액 해석, 차명 E+F, 원문 칸 보존, 가시성 확인, 월렌트 관측 집계 |
| `src/adapters/source-cycle-plugins.ts` | 아이카는 출고불가만 판매 불가, 상태 표시명 유지, 월렌트·숨김 제외, 가시성 완전성 및 관측 집계 전달 |
| `src/application/source-cycle.ts` | 아이카 월렌트 표시가 있는 기존 상품과 입력을 차량 수·UID 계획·하향 대상에서 제외 |
| `src/infra/source-cycle-firestore.ts` | legacy 문서의 source_tab/product_group을 읽고 RAW에 보존하여 월렌트 제외 근거 전달. 기존 백틱 수정 유지 |
| `src/runtime/source-cycle-runtime.ts` | 아이카 값 읽기 전후 숨김 메타데이터 일치 검사 및 mapper 전달. 기존 gws transport 유지 |
| `src/jobs/source-cycle.ts`, `src/ports/source-cycle.ts` | 월렌트 관측 수를 상태 및 회차 요약에 별도 표시 |
| `tests/source-cycle-runtime.test.ts` | 실제 형식의 합성 자료 및 계획·legacy reader·요약 회귀 |
| `docs/NEXT-START-HERE.md`, 이 문서 | 결과 및 후속 검증 인계 |

- 보증금: 무보증/명시 0은 ZERO, 양의 안전한 정수 및 쉼표 숫자는 KNOWN, 빈칸·해석 불명은 UNKNOWN/null. 임의 0원 보충 없음.
- 기간: M/N/O만 읽는다. 빈칸·공백 기간은 생성하지 않는다. U 연주행 문자열은 그대로 보존한다.
- 원문: E+F 차명, 원본 cells/headers와 헤더별 original 맵에 제조사·등록·가격·배기량·연료·Km·외장·내장 등을 그대로 보존한다. 신규 차종 4칸은 기존 writer대로 빈칸/확인 필요다.
- 상태: 배차문의→출고협의, 수리중→상품화중. 배차중/배차가능도 판매 가능이다. 원문 상태를 보존한다.
- UID: 아이카는 차량번호만 사용한다. 번호 없는 행은 UID_REQUIRED/번호미배정이며 임의 UID나 행 번호로 편입하지 않는다. 중복은 최초만 유지하고 HOLD를 남겨 누락 하향을 방어한다.
- 월렌트는 번호 없는 모델 상품 관측 수로만 집계한다. 원천 차량·번호미배정·편입·하향에 넣지 않는다. 기존 문서의 source_tab=월렌트 또는 product_group=MONTHLY도 제외한다. 식별 표식이 없는 과거 문서를 추정 분류하지 않는다.
- 숨김 행은 제외한다. 숨김 탭, 메타데이터 누락/불충분, 필수 헤더 불일치는 전체 캡처 불완전으로 처리하여 누락 하향을 허용하지 않는다.

## 다른 원천 확인

- **F05:** `f05NativeCapture`는 `sharedSheetEngine`과 현행 shared-sheet 변환을 재사용한다. 이번 아이카 오류처럼 별도 기간 보증금 헤더를 찾는 변경은 없다. F05 capture/job/retry/canonical/supplier/intake와 native 가시성 회귀 통과. F05 매퍼 코드는 변경하지 않았다. 라이브 적합성을 새로 입증한 것은 아니다.
- **아이언:** `__NEXT_DATA__.props.pageProps`의 vehicles 배열, total 일치, hasNextPage=false, published boolean인 명시 envelope만 허용한다. 알려지지 않은 HTML/불완전 목록은 HOLD다. 기존 합성 정상·거부 시험 통과. 실제 홈페이지 envelope 근거가 저장소에 확정되어 있지 않아 **라이브 형식 일치 HOLD**를 유지하며 매퍼는 변경하지 않았다.

## 시험 / 검증

- 관련 **9파일 281 PASS / 0 FAIL / 0 SKIP**. runtime 53, cycle 41, engine 24, shared-sheet capture 18, capture job 4, retry 3, canonical 111, supplier layer 10, source intake 17.
- runtime 내 SPEC3B 시험 **18개**: 이전 아이카 2개를 실제 형식 시험 18개로 교체/확장했다(전체 runtime 37→53).
- 무보증·숫자·미확정 보증금, 빈 기간 미생성, 원문 및 차명 보존, 신규 차종 빈칸, 상태 5종, 숨김·메타데이터 누락, 중복·번호미배정, 같은 UID의 UPDATE→무변경, 월렌트 legacy 문서 제외·관측 요약·상품 쓰기 0을 검증했다.
- 최초 시험은 PowerShell→Python 전달 인코딩으로 새 한글이 손상되어 transform 실패했다. UTF-8 전달을 명시하고 전부 복구한 뒤 위 시험을 통과했다. 최초 실패를 PASS로 계산하지 않는다.
- TypeScript build, architecture boundary, data-access boundary, `git diff --check` 통과. 전체 저장소 시험은 실행하지 않았다.
- 외부 네트워크 호출·라이브 읽기·운영 쓰기·커밋·push·배포·예약 등록 모두 0. 가짜 Firestore 주입 시험만 사용했다.

## 남음 / next_start_here

연결 담당은 이 작업 트리와 SPEC3B를 대조한 뒤 별도 허용된 환경에서 새 읽기 전용 dry-run으로 실제 헤더·숨김 메타데이터·UID 집합·기간 조건을 확인한다. 과거 오류 계획은 재사용하지 않는다. 기존 노출 15건과 새 원천의 UID를 실제로 대조하기 전 라이브 DOWNGRADE 0이나 편입 수를 주장하지 않는다. 아이언 실제 목록 envelope와 식별 표식 없는 과거 월렌트 문서는 확인 전 HOLD다.

`next_start_here`: SPEC3B → 이 문서 → runtime 시험 → 새 라이브 읽기 계획 검토. 운영 적용은 이번 범위 밖이다.
