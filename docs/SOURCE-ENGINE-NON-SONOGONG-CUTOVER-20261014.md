# 손오공 제외 원천 최신화 — 전환 절차·아이언 설계·잔여 격차 분류 (2026-10-14)

대표 지시: «손오공 빼고 나머지 최신화부터». 손오공 관련 작업은 잠금 해제 전까지 뒤로 둔다.
상태: DESIGNED/CODED. 운영 쓰기는 B3Q 실행·커맨드 센터 시각 지시.

## 1. 오토플러스(RP023) 쓰기 전환 — 한 줄 절차

**① #581 합침·체크아웃 교체(스위치 꺼짐) → ② 엔진 dry-run 으로 홈피 NEW/MISSING 목록(끝4) 확인(쓰기 0) → ③ ERP4 RP023 쓰기 제외 PR(`rp023-variable-write-stop-20261014` @db3dd9ae) 합침 → ④ 같은 회차 전후 `SOURCE_CYCLE_AUTOPLUS_HOMEPAGE_WRITE=1` → ⑤ 첫 적용 회차 결과(등록·노출·비노출·하향·되읽기) 보고, 이상 시 스위치 0 + ERP4 제외 revert.**

| 단계 | 담당 | 확인 기준 |
|---|---|---|
| ① | B3Q | 체크아웃 head, 첫 회차 정합 기록에 `registeredCount·exposedCount·infoIncompleteCount·duplicateDocCount` 출력 |
| ② | B3Q(읽기 전용) | 홈피 N·ERP 노출 N·NEW 끝4·MISSING 끝4·excluded(RESULT_1400)·failureCodes·`complete=true`; 사이트맵 하한(노출 95%·직전 80%) 통과 |
| ③ | 커맨드 센터 시각 지시 → ERP 개발 PR·B3Q 합침 | ERP4 풀 회차 로그에서 RP023 변동 쓰기 0 |
| ④ | B3Q 환경 변수 1줄 | 엔진 RP023 plan 의 ENROLL ≤ 상한, DOWNGRADE 비율 가드 통과 |
| ⑤ | B3Q → DATA | 다음 회차 NEW−newHasDoc = 0, MISSING = 잠금분만, 값 불일치 0 |

공백/이중 쓰기: ③~④ 사이 최대 한 회차(≤1시간) RP023 가격 변동을 아무도 쓰지 않는다(노출·대수 영향 없음). ③ 전에 ④ 를 켜지 않는다(이중 쓰기).

## 2. 아이언(RP006) — 엔진 편입 설계

현황
- 엔진 코드에 `IRON` 원천(`ironNativeCapture`, `SOURCE_CYCLE_IRON_LIST_URL`, 도메인 `https://ironrentcar.com` 고정)이 이미 있다. 운영 엔진 원천 목록(`SOURCE_CYCLE_SOURCES`)에는 빠져 있다(B3Q 회신).
- 현재 기대 입력: Next.js `__NEXT_DATA__` 의 `pageProps.vehicles[]`(번호·차명·`published`·기간별 요금), `total === vehicles.length && hasNextPage === false` 일 때만 «완전 목록». 모양이 다르면 `IRON_LIST_SCHEMA_HOLD`/`IRON_LIST_COVERAGE_HOLD` 로 fail-closed.
- 신규 편입은 지금까지 ERP4 «승인 해시 예외» 경로(아이언 등록). 상태 매핑: 게시 → 출고가능, 비게시 → 출고불가.

범위(구현 필요 vs 이미 있음)
| 항목 | 상태 |
|---|---|
| 어댑터(홈피 목록 → 엔진 레코드) | **있음**(코드). 실제 사이트 응답과 스키마 일치는 dry-run 으로 확인 필요 |
| 오토플러스식 완전성 검사(닫는 태그·직전 수 급감·상세 성공 판정) | **없음** → 같은 하한 함수(`autoplusSitemapFloor` 계열)와 «목록 건수 직전 대비 80% 미만 incomplete» 를 IRON 에도 적용 |
| 번호 없는 차량 | 어댑터는 plate=null 허용, 엔진 UID 키(번호 없으면 UID) 정책 따름 |
| 이중 쓰기 방지 | ERP4 의 RP006 변동 쓰기 중단 목록 PR(배치) 선행 → 그 뒤 엔진 `IRON` 을 SOURCES 에 추가. 둘 중 하나만 쓴다 |
| 편입 규칙 | 엔진 공통(승인 없음, 가격 없음 INFO_INCOMPLETE 비노출 편입, 회차 상한 max(100, 노출 50%)) |

절차: ① B3Q 에서 `SOURCE_CYCLE_IRON_LIST_URL` 설정 여부·현재 아이언 노출 대수·갱신 경로 확인(요청 보냄) → ② 엔진 dry-run(IRON 만 SOURCES 추가, 쓰기 스위치 없음 = 계획만) 으로 스키마·NEW/MISSING 확인 → ③ ERP4 RP006 쓰기 중단 PR(ERP 개발) → ④ 같은 회차 전후 엔진 쓰기 켜기. 오토플러스와 같은 순서·같은 롤백.

## 3. F05·아이카·이안카 잔여 격차 분류 틀 (실측 도착 시 채움)

| 원인 분류 | 징후(정합 보고 필드) | 실행 가능 조치 | 비고 |
|---|---|---|---|
| 계약 잠금 | `missingLockedCount` | 정산 원장 확인 → 대표 승인 해제 | 정책상 자동 하향 금지 |
| 보류 행이 부재 하향 차단 | `heldReasons` 의 UID_REQUIRED·충돌 계열, `ABSENCE_DOWNGRADE_SKIPPED` | 시트 번호 입력·중복 해소(공급사) | 값 계열 보류는 차단하지 않음(완화됨) |
| 가격 없음 | `infoIncompleteCount`, TERMS_HOLD | 공급사 시트 요금 입력 → 다음 회차 자동 노출 | 번호만 편입됨 |
| 가격 드리프트 보류 | DRIFT_HELD | `-AcceptDrift` 승인(차이 ±30% 이내) | 0.0% 4건은 가짜 불일치였음 |
| 같은 번호 중복 문서 | `duplicateDocCount` | 문서 정리(병합/철회) 사람 확인 | 결정적 선택은 노출 우선 |
| 상태 불명 | STATUS_UNKNOWN | 알려진 어휘 매핑 추가 또는 시트 수정 | fail-closed |
| 신규(순수 NEW) | `pureNewCount` | 엔진 편입(상한 이월) | 다음 회차 자동 |

실측 수신 즉시 원천별 행을 채워 B3Q 적용 대상(상한·백업·되읽기)을 정한다.

## 4. 보고 형식 (30분 간격, 바뀐 것만)

`[원천] 원천 N · ERP N · 일치 K · NEW a(문서 있음 b) · MISSING c(잠금 d) · 값불일치 e · 보류 사유 {…}`
