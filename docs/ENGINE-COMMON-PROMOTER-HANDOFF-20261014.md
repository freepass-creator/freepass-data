# 엔진 공통 승격기 — 클라우드 구현 인계 (2026-10-14~)

설계: `docs/ENGINE-COMMON-PROMOTER-DESIGN-20261014.md`(가지 `work/freepass-data/engine-promoter-design-20261014`).
이 문서는 클라우드 구현 담당이 PR 마다 갱신하는 한 장이다. 합침·배포·실행 스위치는 커맨드 센터 몫이다.
상태 표기는 AGENTS.md §3(DESIGNED / CODED / TESTED / … / DEPLOYMENT VERIFIED)를 따른다. 로컬 실행은 «완료» 근거가 아니다.

## 1. 진행 표

| 순서 | 단계 | 상태 | 가지 / PR |
|---|---|---|---|
| 0 | 열린 원천 엔진 가지 정리(#603 아이언 홈피, #604 손오공 교체 1회) | 둘 다 main 최신 기준, 서로 충돌 없음, 합친 상태에서 tsc·시험 통과 | 리베이스 불필요 |
| 2-1 | 정체성 승격 계획서 생성기(읽기 전용) — main #611·#612·#613 + 결함 2건 수정(엔진 편입 문서 검출, 세부트림 두 번째 계획) | CODED · TESTED | #620 (#607 은 대체·닫음) |
| 2-2 | 확정 규칙 한정 자동 적용(repair:vehicle-name-parity 경로) | 다음 | — |
| 2-3 | 보증금 계산값(deposit_source=CALCULATED) | 대기 | — |
| 2-4 | 사진 연결 승격(photo_original_refs 등록) | 대기 | — |
| 3 | 엔진 온라인 실행 설계(Actions) + DRY_RUN 워크플로 | DESIGNED · CODED · TESTED(설계 `docs/SOURCE-CYCLE-ONLINE-MIGRATION-DESIGN-20261014.md`(#605) §5) — 실행은 읽기 SA·변수 등록 후 | #608 |
| 3-1 | 시트 읽기 ADC 전송(SHEETS_TRANSPORT=adc, gws 없이 F05·아이카·오토플러스 시트) | CODED · TESTED | #618 |
| 3-2 | 회차 제어·실행기 상태(잠금 임대·상태·기준 건수·한 회차 표식·백업)를 Firestore 에(SOURCE_CYCLE_CONTROL=firestore) | CODED · TESTED | #621 |
| 3-3 | 온라인 무인 회차 APPLY 워크플로(원천 목록 스위치, 기본 꺼짐) | CODED · TESTED | #623 |
| 4 | 5칸 지표·dispatchGap heartbeat(이미 main) + gap 사유 코드 `dispatchGapReasons` | CODED · TESTED | #619 |

## 2. 정체성 승격 계획서 생성기 (2-1)

- 정본: main 의 `src/application/identity-promotion-plan.ts`(#611·#612) + CLI `src/jobs/build-identity-promotion-plan.ts`(#613).
- #620 수정: ① 엔진 편입 문서(제조사·모델 빈칸, sub_model 에 원문 차명)를 원문 대조로 읽는다(전에는 전부 NO_MASTER_MATCH)
  ② 정체성 정정 상품의 세부트림은 두 번째 계획(`trimPlan`, CLI `--trim-out`, 기본 `<out>.trim.json`) — 정정 경로 «one product per plan» 거부 해소.
- 적용 순서: 첫 계획 적용·되읽기 → 두 번째(세부트림) 계획. 정정 경로는 `repair:vehicle-name-parity`(검토 → DRY_RUN → digest 승인 → 적용 → 되읽기).
- 클라우드 #607 은 main 생성기와 중복이라 닫음.
- 남은 것: 적용 후에도 `vehicle_review_required` 표식은 적용기가 지우지 않는다(현행 그대로).

## 3. 막힌 것 / 결정필요

- (2-1) 없음 — 읽기 전용이라 스위치 불필요.
- (3) 온라인 DRY_RUN 은 읽기 전용 SA·WIF 변수(`SOURCE_CYCLE_WIF_PROVIDER`·`SOURCE_CYCLE_READ_SERVICE_ACCOUNT`)와 원천 비밀 등록이 있어야 돈다 → 커맨드 센터.
- (3-3) 온라인 쓰기 켜기 = 쓰기 SA·WIF(`SOURCE_CYCLE_WRITE_SERVICE_ACCOUNT`) + 원천 비밀값(시트 ID·이안카·손오공 키) 등록 → 원천 하나씩 B3Q 에서 빼고 `FREEPASS_SOURCE_CYCLE_ONLINE_SOURCES` 에 추가 → 커맨드 센터.
- (3-1) 시트 원천은 #618 합침 + 실행기 SA 를 각 시트에 «보기» 공유하면 온라인 DRY_RUN 에 넣을 수 있다(워크플로 원천 목록 확장은 후속 PR).
