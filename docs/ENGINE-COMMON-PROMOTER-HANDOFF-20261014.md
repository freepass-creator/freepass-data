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
| 2-2 | 확정 규칙 한정 자동 적용 — 엔진 회차 안 정체성 정제(대표 10-15 «손오공 새로 API 연동해서 땡겨온 애들은 … 모델명도 정제되어 있지 않고»). 2-1 과 같은 대조 함수(`matchIdentity`), 마스터 하나로 특정될 때만 | CODED · TESTED(운영 적용·되읽기 미확인) | #655 |
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

## 2-2. 엔진 회차 정체성 정제 (2026-10-15)

- 규칙은 새로 만들지 않았다: 2-1 생성기의 대조를 순수 함수 `matchIdentity`(`src/application/identity-promotion-plan.ts`)로 꺼내 생성기와 엔진이 같이 쓴다.
  마스터 하나로 특정(후보 둘 이상이면 연식이 정확히 하나로 좁힐 때만) → 제조사·모델·세부모델(마스터 이름), 세부트림은 하나로 특정될 때만, 아니면 지금처럼 원문 차명·검토 필요.
- 마스터: 실행기(`src/runtime/source-cycle-runtime.ts`)가 회차마다 첫 목록 읽기 때 한 번 기존 경로(`captureVehicleMasterSnapshotReadOnly`)로 읽고 기존 검증기(`verifiedMasterRecords`: 최신 5분·digest·완전성·이름 일치)를 통과할 때만 대조기를 만든다.
  못 읽음·검증 실패·시간 초과(120초)·빈 마스터 → 정제 안 함(지금 동작). 상태는 실행 기록 `identityRefine`(`ENABLED:<digest12>`·`SKIPPED:<사유>`·`DISABLED`)에 남는다. 끄기: `SOURCE_CYCLE_IDENTITY_REFINE=0`.
- 쓰는 곳(`src/infra/source-cycle-firestore.ts` `nativeCycleFields`): 새 문서, 또는 엔진 편입 보류 문서(`source_cycle_record` 있음 + `vehicle_review_required:true` + 제조사·모델 빈칸)만.
  쓰는 칸: maker·model·sub_model·trim_name(하나로 특정 + 기존 빈칸일 때만)·year(기존 문서에 없고 원천 연식이 있을 때만)·`vehicle_review_required:false`·`vehicle_title_source:'MASTER_MATCH'`·`vehicle_master_id`. `원문.차명`은 그대로.
  제조사·모델이 하나라도 있는 문서(사람·ERP4)·검토가 끝난 문서는 건드리지 않는다.
- 기존 보류 문서: 다시 쓰기 사유 `VEHICLE_IDENTITY`(지금 마스터로 하나로 특정될 때만 → 쓰고 나면 조건 거짓, 되풀이 없음). 특정 안 되는 보류 문서는 사유가 없어 일괄 UPDATE 없음.
  계획 경고: `VEHICLE_IDENTITY_REFINE:<n>`, 쓰기가 있는 계획에는 `IDENTITY_MASTER:<digest12>` — 승인 계획을 다른 마스터로 적용하면 재계획이 달라져 `CYCLE_REPLAN_REQUIRED`.
- 시험: `tests/engine-identity-refine.test.ts`(유일 일치 채움·연식 못 가름 보류·모르는 모델 보류·사람/ERP4 정체성 불변·보류 문서 1회 다시 쓰기·마스터 못 읽음 → 정제 없음·반복 쓰기 없음·마스터 바뀐 승인 계획 거부).
- 모름: 운영 보류 문서 중 몇 대가 정제될지는 오프라인에서 알 수 없다(운영 products·마스터를 읽지 않음). 첫 회차 실행 기록의 `VEHICLE_IDENTITY_REFINE:<n>` 경고로 확인.
- 온라인 읽기 전용 SA 로 도는 DRY_RUN 에서 마스터 읽기(데이터 접근 기록 쓰기 포함)가 권한으로 실패하면 `SKIPPED:VEHICLE_MASTER_UNAVAILABLE` 로 정제 없이 돈다(회차는 막지 않음).

## 3. 막힌 것 / 결정필요

- (결정필요) 보증금 계산값(2-3): 작업지시는 «원천에 보증금 칸이 없는 경우(손오공 API·아이언 홈피)만 CALCULATED» 인데, 현행 `deposit-evidence.ts` 는 RP012·픽업구독 보증금 계산을 금지(규칙 보존)한다. 국산×2·수입×3 규칙 적용 범위를 대표가 정하기 전에는 만들지 않는다.
- (결정필요) 계약 계열 표기 «출고대기» 는 뜻이 갈려(계약 후 대기 vs 출고 준비) 보류 중 — 정해지면 `CONTRACTED_STATUS_SYNONYMS` 에 추가(#628).

- (2-1) 없음 — 읽기 전용이라 스위치 불필요.
- (3) 온라인 DRY_RUN 은 읽기 전용 SA·WIF 변수(`SOURCE_CYCLE_WIF_PROVIDER`·`SOURCE_CYCLE_READ_SERVICE_ACCOUNT`)와 원천 비밀 등록이 있어야 돈다 → 커맨드 센터.
- (3-3) 온라인 쓰기 켜기 = 쓰기 SA·WIF(`SOURCE_CYCLE_WRITE_SERVICE_ACCOUNT`) + 원천 비밀값(시트 ID·이안카·손오공 키) 등록 → 원천 하나씩 B3Q 에서 빼고 `FREEPASS_SOURCE_CYCLE_ONLINE_SOURCES` 에 추가 → 커맨드 센터.
- (3-1) 시트 원천은 #618 합침 + 실행기 SA 를 각 시트에 «보기» 공유하면 온라인 DRY_RUN 에 넣을 수 있다(워크플로 원천 목록 확장은 후속 PR).
