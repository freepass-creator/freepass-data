# 손오공 옛 수집기 최신화 — 설계 한 장 (2026-10-12, 대표 결정: 새로 만들지 않고 옛 수집기를 현재 규칙으로)

상태: **설계만 — 코드·워크플로 변경 없음.** 실행 위치는 지금 자리(freepasserp4 «ERP5 SSOT 원천 최신화(매시간)») 그대로. 계정은 같은 저장소의 기존 비밀을 그대로 쓰며 값은 열지 않는다. 대표에게 계정 등록을 요청하지 않는다. 시트 ID·차량번호·비밀값은 싣지 않는다.

## 1. 지금 구조(실측 2026-10-12, 읽기만)
- 흐름: 워크플로가 고정 엔진 커밋(`ref:` 고정, 현재 `e6727ff0`)을 받아 `sonokong/scripts/손오공.mjs`(API 덤프) → `scripts/ingest-supplier-to-firestore.mts --code=RP012` 가 products 에 반영. 매시간 회차 인자는 `--apply --variable --retire`.
- `--variable` 은 «자주 바뀌는 칸(상태·주행·요금·사진 링크 등)»만 쓴다. 불변 칸 전체 반영(`--apply`)은 따로 돌 때만 — 판매 140대 중 132대의 마지막 전체 반영이 09-21인 이유.
- `원문` 칸은 처음 원문 백필(09-04~09-11)에 사진·옵션 증거만 덧붙는다. 덤프 전체는 실행기 임시 파일이고 회차 끝에 삭제된다 → 최신 원문이 어디에도 남지 않는다.
- 이미 있는 것: 원천에 없는 «출고가능·즉시출고» 차를 출고불가·listable=false 로 내림(`--retire`, 안전판 «수집 ≥ 세운 차의 50%»), 새 차 편입(merge), 차량 UID(`vehicle_uid`), 요금은 기간 맵 통째 교체.
- 없는 것: 회차 하트비트, 원천 관측 시각, 최신 원문, 부분 읽기 때 전체 반영 차단 규칙, 내림의 되돌리기 근거.

## 2. 바꿀 것 (요구 ①~④ 대응)
| 요구 | 변경 |
| --- | --- |
| ① 표준 레코드 | RP012 문서에 `원천_관측시각`(덤프 시작·종료, ms), `원천_run_id`(GitHub run id) 추가. 기존 칸(vehicle_uid·car_number·price{기간:{rent,deposit}}·deposit_note·status*)은 그대로. `원문_최신` = 이번 덤프의 해당 차 레코드 원본(문서 1MiB 한도 확인, 초과 시 사진 URL 목록만 요약). `원문`(처음)은 수정 금지. |
| ② 원천 기준 편입·하향 | 손오공(RP012)만 매시간 회차를 `--apply --retire`(전체 반영)로. 완전성 가드: 3버킷 모두 `declaredTotal == 읽은 행 수`, 상세 실패 0, 읽은 판매 가능 수 ≥ 세운 차의 50% — 하나라도 어기면 전체 반영·내림을 건너뛰고 변동 모드로 후퇴(+하트비트 PARTIAL). 내릴 때 `_retired_prev`{이전 vehicle_status·status·listable·시각} 저장. |
| ③ 하트비트 | `collector_heartbeats/RP012`(최신 1건 덮어쓰기)와 `collector_heartbeat_history/RP012_<run id>`(이력)에 `{runId, startedAt, sourceObservedAt, sourceRead:{전체·버킷별·판매가능}, applied, newCars, changedCars, retired, lockedKept, mode, status:OK/PARTIAL/FAIL, errorCode}`. 실패 회차도 FAIL+오류 코드만 기록(값·응답 본문 금지). «원천에서 읽은 판매 가능 N대 / 반영 N» 은 이 문서의 sourceRead.saleable / applied. |
| ④ 계정 | 변경 없음(`SONOGONG_ACCOUNT_JSON`, freepasserp4 비밀). |

## 3. 바꿀 파일(모두 freepasserp4 저장소)
1. `sonokong/scripts/손오공.mjs` — 덤프 옆에 `손오공차량.meta.json`{시작·종료 시각, 버킷별 declaredTotal·읽은 행·상세 실패 수} 출력(기존 덤프 형식 불변).
2. `scripts/ingest-supplier-to-firestore.mts` — 위 칸 쓰기, 완전성 가드, `_retired_prev`, 하트비트 호출(RP012 분기에서만).
3. 하트비트 작성기(작은 모듈 1개) — 위 두 컬렉션 쓰기 한 곳.
4. `.github/workflows/erp5-ssot-refresh.yml` — 엔진 고정 `ref:` 를 새 커밋으로, RP012 에 한해 인자 `--apply --retire`(다른 22개 공급사 인자는 불변). 계정·단계 순서·동시성 그룹 불변.
5. 시험 — 가짜 덤프 고정 파일로: 정상(편입·변경·내림 수), 부분 읽기(가드 작동, 전체 반영 0), 상세 실패, 하트비트 필드, 비밀·차량번호 비출력.

## 4. 검증·롤백
- 배포 전: `workflow_dispatch` 미리보기(쓰기 0)로 «새 N·변경 N·내림 N» 숫자만 확인 → 승인 → 첫 실제 회차 후 products 에서 `원천_관측시각`·`원문_최신`·하트비트 되읽기, 판매 listable 수가 원천 판매 가능 수와 같은지 대조.
- 롤백: 워크플로 `ref:` 를 `e6727ff0` 로 되돌림(코드 원복). 새 칸·컬렉션은 가산 방식이라 남겨도 무해, 필요하면 삭제 스크립트. 내림은 `_retired_prev` 로 원복.

## 5. 위험·미정
- 손오공 전체 반영 매시간화의 Firestore 쓰기량: 손오공 문서 약 300 → 시간당 수백 건(허용 범위로 판단, 첫 주 관찰).
- `원문_최신` 문서 크기, 하트비트 컬렉션 쓰기 권한(github-inventory-writer 가 새 컬렉션 쓸 수 있는지) — 구현 첫 단계에서 읽기 전용으로 확인.
- 오공구독·픽업구독 분류 규칙·보증금 규칙은 옛 엔진 그대로(이번 변경 범위 아님). #508 정규화의 연료 표기 통일·0값 처리는 옛 엔진 쪽에 같은 규칙이 있는지 비교 후 필요한 것만 이식.
- 이안카/RP023 단계 실패가 같은 회차를 막는 문제는 별개(손오공 가드와 분리: 손오공 하트비트는 그 단계 앞에서 기록).

## 부록: Codex 지시서 초안
```
[실행 규칙] 네트워크 없음 — 필요하면 BLOCKED_NETWORK: <필요한 것> 한 줄로 멈춰라. 파일 UTF-8. 비밀·계정 값은 어디에도 쓰지 말고 열지 마라. 공개 저장소에 시트 ID·실제 차량번호 금지.
[오더] freepasserp4 에서 손오공(RP012) 옛 수집기를 최신화한다. 설계: freepass-data docs/SONOGONG-LEGACY-COLLECTOR-REFRESH-DESIGN.md (읽고 그대로 따른다).
대상: sonokong/scripts/손오공.mjs, scripts/ingest-supplier-to-firestore.mts(고정 엔진 e6727ff0 계보), .github/workflows/erp5-ssot-refresh.yml.
할 일: 설계 2절 표의 ①~③, 3절 1~5. 완전성 가드와 하트비트는 실패 때도 FAIL 로 기록. 다른 공급사 동작·인자는 바꾸지 마라. 새 파일은 하트비트 작성기 1개와 시험뿐.
검증: 가짜 덤프 시험 통과(정상·부분 읽기·상세 실패·하트비트 필드·비출력), tsc/기존 시험 통과. 운영 쓰기·push·워크플로 실행은 하지 마라(PR 초안까지).
보고: 변경 파일, 시험 결과, 미해결을 한국어로. 구현 모델/검토 모델 기록은 PR 본문에.
```
