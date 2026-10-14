# 손오공 공식 파트너 API → 엔진 쓰기 연결 (2026-10-14, CODED·TESTED, 운영 켜기는 B3Q)

대표 «손오공 연동해야지». 읽기 어댑터(#592 `src/adapters/sonogong-api.ts`)를 엔진 실행 경로(plan → 문서별 CAS 적용 → 백업 → 되읽기)에 연결한다.

## 켜는 조건 (모두 필요, 하나라도 없으면 호출 0·RP012 관측 전용 유지)

| 환경 변수 | 용도 |
|---|---|
| `SOURCE_CYCLE_SONOGONG_API=1` | 스위치(정확히 `1`) |
| `SONOGONG_API_KEY` | 파트너 키 — 비공개 env 파일에만. 코드·로그·시험·문서에 값을 두지 않는다 |
| `SONOGONG_API_BASE` | `https://sokrc.com/api/partner/v1` (호스트·경로 접두 고정, 다른 주소는 `SONOGONG_API_NOT_CONFIGURED`) |
| `SOURCE_CYCLE_SONOGONG_ENROLL_CAP_ONCE=<n>` | (선택) 최초 대량 편입용 «이번 한 회차 한정» 편입 상한(101~1000). 잠금 안에서 적용 전에 표식 `sonogong-enroll-cap-once.done` 을 원자적으로 기록해 소진(기록 실패 시 올리지 않음), 다음 회차부터 자동 원복 |

원천 목록(`SOURCE_CYCLE_SOURCES`)에 `SONOGONG` 이 있어야 하고, 켜지면 `RP012` 가 관측 전용에서 쓰기 허용으로 바뀐다(이중 쓰기 방지: ERP4 RP012 변동·등록 쓰기는 멈춘 상태여야 한다).

## 동작

- 읽기: 3탭(rent → sub → pick) 목록 + 상세, 직렬·간격 1.5초·재시도 0, 429/401/403 즉시 정지, 상세 최대 600건. 마지막 완전 읽기 후 55분 안에는 읽지 않는다(`SONOGONG_API_PASS_INTERVAL` 소프트 보류).
- 키: 차량번호(번호 우선). 같은 번호가 다른 탭에도 있으면 rent > sub > pick 우선순위로 하나만 채택하고 `CROSS_TAB_DUPLICATE:n`, 제조연월이 다르면 `CROSS_TAB_GENERATION_DIFFERENCE:n` 경고(불완전 아님). 같은 탭 안 중복은 불완전.
- 상태: `hasActiveContract` → «계약중»(문서 유지·선점 표시 노출, 출고가능 비교 제외), 그 밖 «출고가능». 계약중 판단은 보조 키로만(장부 잠금이 있으면 잠금이 이긴다).
- 요금: 탭별 반납형(rent=RENT_RETURN, sub·pick=SUBSCRIBE_RETURN) 개월별 월 대여료, 보증금은 상세에서만. 인수형(SUBSCRIBE_BUYOUT)은 raw 에 원문 보존. 사진 `images[].url`(https 만, 없으면 사진 없음), 원문 전 필드는 `raw.list`·`raw.detail`·`raw.prices`.
- 편입: 엔진 공통 규칙(번호만이라도 먼저·가격 없음 INFO_INCOMPLETE 비노출·판매 불가 비노출 편입, 회차 상한 max(100, 노출 50%)).
- 부재: 완전 읽기에서 사라진 노출 차(ERP 에만 있는 차)는 원천 부재 하향(상태 변경, 삭제 아님) — 하향 비율 가드·계약 잠금 보호·백업·되읽기 유지.
- 부분 읽기 방어: 목록 수 < max(잠금 제외 노출 80%, 직전 정상 회차 목록 수 80%) 이면 `API_SHRUNK` 불완전. 기준 파일 손상은 이번 회차만 불인정 후 복구.

## 켜기 순서(제안)

1. 체크아웃 교체(스위치·키 없음 = 변화 없음) → 2. 비공개 env 에 키·주소(대표 손) → 3. `SOURCE_CYCLE_SONOGONG_API=1` 없이 한 회차: 관측 전용 확인 → 4. 스위치 + `ENROLL_CAP_ONCE` 로 한 회차 plan 확인(DRY_RUN 으로 NEW/MISSING 목록, 쓰기 0) → 5. 적용 → 6. 다음 회차 reconciliation(5칸)·신선도 확인, 신선도 예외(`RP012=SONOGONG_LOCKED`) 설정 제거.

신선도 예외는 새 원천 코드 없이 같은 `RP012` 로 쓰므로 첫 정상 회차에서 RP012 heartbeat 가 FRESH 가 되어 예외 목록에서 자연히 빠진다(남아 있어도 FRESH 는 영향 없음).
