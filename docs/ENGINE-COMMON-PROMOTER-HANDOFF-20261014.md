# 엔진 공통 승격기 — 클라우드 구현 인계 (2026-10-14~)

설계: `docs/ENGINE-COMMON-PROMOTER-DESIGN-20261014.md`(가지 `work/freepass-data/engine-promoter-design-20261014`).
이 문서는 클라우드 구현 담당이 PR 마다 갱신하는 한 장이다. 역할: 커맨드 센터 = 기획 PC(GHD, PR 합침·지시·온라인 확인), B3Q = 운영 PC(엔진 실행·스위치), 클라우드 = 코드·시험·PR.
상태 표기는 AGENTS.md §3(DESIGNED / CODED / TESTED / … / DEPLOYMENT VERIFIED)를 따른다. 로컬 실행은 «완료» 근거가 아니다.

## 1. 진행 표

| 순서 | 단계 | 상태 | 가지 / PR |
|---|---|---|---|
| 0 | 열린 원천 엔진 가지 정리(#603 아이언 홈피, #604 손오공 교체 1회) | 둘 다 main 최신 기준, 서로 충돌 없음, 합친 상태에서 tsc·시험 통과 | 리베이스 불필요 |
| 2-1 | 정체성 승격 계획서 생성기(읽기 전용) — main #611·#612·#613 + 결함 2건 수정(엔진 편입 문서 검출, 세부트림 두 번째 계획) | 합침 | #620 (#607 대체·닫음) |
| 2-1b | 계획서 입력 내보내기(ERP5 캡처 + 마스터 → 스냅샷 JSON, 읽기 전용) | CODED · TESTED | #636 |
| 2-2 | 확정 규칙 한정 자동 적용(repair:vehicle-name-parity 경로) | 다음 | — |
| 2-3 | 보증금 계산값(deposit_source=CALCULATED) | 대기 | — |
| 2-4 | 사진 연결 승격(photo_original_refs 등록) | 대기 | — |
| 3 | 엔진 온라인 실행 설계(Actions) + DRY_RUN 워크플로 | 합침(실행은 읽기 SA·변수 등록 후) | #608 |
| 3-1 | 시트 읽기 ADC 전송(SHEETS_TRANSPORT=adc, gws 없이 F05·아이카·오토플러스 시트) | 합침 | #618 |
| 3-2 | 회차 제어·실행기 상태 Firestore + Codex P1 3건·P2 2건(쓰기 소유권·fencing·넘김 도구·급변 정지) | CODED · TESTED · 재검토 대기 | #621 |
| 3-3 | 온라인 무인 회차 APPLY 워크플로(원천 목록 스위치, 기본 꺼짐, 손오공 제외) + 요약에 한 줄 판정 | CODED · TESTED · 재검토 대기(켜지 않음) | #623 |
| 4 | 5칸 지표·dispatchGap heartbeat + gap 사유 코드 `dispatchGapReasons` | 합침 | #619 |
| 4b | 원천별 한 줄 판정 `--verdict`(✅/⚠ 이유/❌ 정지·3회 연속) | CODED · TESTED | #629 |
| 5 | 계약중 계열은 모든 원천에서 «계약중» 노출(이안카 RESERVED·오토플러스 상담중 등), 아이언 홈피 판정 결함 수정 | CODED · TESTED · 검토 대기 | #628 |
| 6 | ERP5 대여료 표시: 만원 소수 한 자리(픽업구독 35.4167만원 → 35.4만원) | CODED · TESTED(ERP5 755) · 프리뷰 확인 대기 | freepasserp5 #120 |

## 2. 정체성 승격 계획서 생성기 (2-1)

- 정본: main 의 `src/application/identity-promotion-plan.ts`(#611·#612) + CLI `src/jobs/build-identity-promotion-plan.ts`(#613).
- #620 수정: ① 엔진 편입 문서(제조사·모델 빈칸, sub_model 에 원문 차명)를 원문 대조로 읽는다(전에는 전부 NO_MASTER_MATCH)
  ② 정체성 정정 상품의 세부트림은 두 번째 계획(`trimPlan`, CLI `--trim-out`, 기본 `<out>.trim.json`) — 정정 경로 «one product per plan» 거부 해소.
- 적용 순서: 첫 계획 적용·되읽기 → 두 번째(세부트림) 계획. 정정 경로는 `repair:vehicle-name-parity`(검토 → DRY_RUN → digest 승인 → 적용 → 되읽기).
- 클라우드 #607 은 main 생성기와 중복이라 닫음.
- 남은 것: 적용 후에도 `vehicle_review_required` 표식은 적용기가 지우지 않는다(현행 그대로).

## 3. 막힌 것 / 결정필요

- (결정필요) 보증금 계산값(2-3): 작업지시는 «원천에 보증금 칸이 없는 경우(손오공 API·아이언 홈피)만 CALCULATED» 인데, 현행 `deposit-evidence.ts` 는 RP012·픽업구독 보증금 계산을 금지(규칙 보존)한다. 국산×2·수입×3 규칙 적용 범위를 대표가 정하기 전에는 만들지 않는다.
- (결정필요) 계약 계열 표기 «출고대기» 는 뜻이 갈려(계약 후 대기 vs 출고 준비) 보류 중 — 정해지면 `CONTRACTED_STATUS_SYNONYMS` 에 추가(#628).

- (2-1) 없음 — 읽기 전용이라 스위치 불필요.
- (3) 온라인 DRY_RUN 은 읽기 전용 SA·WIF 변수(`SOURCE_CYCLE_WIF_PROVIDER`·`SOURCE_CYCLE_READ_SERVICE_ACCOUNT`)와 원천 비밀 등록이 있어야 돈다 → 커맨드 센터.
- (3-3) 온라인 쓰기 켜기 = 쓰기 SA·WIF(`SOURCE_CYCLE_WRITE_SERVICE_ACCOUNT`) + 원천 비밀값(시트 ID·이안카·손오공 키) 등록 → 원천 하나씩 B3Q 에서 빼고 `FREEPASS_SOURCE_CYCLE_ONLINE_SOURCES` 에 추가 → 커맨드 센터.
- (3-1) 시트 원천은 #618 합침 + 실행기 SA 를 각 시트에 «보기» 공유하면 온라인 DRY_RUN 에 넣을 수 있다(워크플로 원천 목록 확장은 후속 PR).
