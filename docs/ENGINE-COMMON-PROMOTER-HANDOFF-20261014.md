# 엔진 공통 승격기 — 클라우드 구현 인계 (2026-10-14~)

설계: `docs/ENGINE-COMMON-PROMOTER-DESIGN-20261014.md`(가지 `work/freepass-data/engine-promoter-design-20261014`).
이 문서는 클라우드 구현 담당이 PR 마다 갱신하는 한 장이다. 합침·배포·실행 스위치는 커맨드 센터 몫이다.
상태 표기는 AGENTS.md §3(DESIGNED / CODED / TESTED / … / DEPLOYMENT VERIFIED)를 따른다. 로컬 실행은 «완료» 근거가 아니다.

## 1. 진행 표

| 순서 | 단계 | 상태 | 가지 / PR |
|---|---|---|---|
| 0 | 열린 원천 엔진 가지 정리(#603 아이언 홈피, #604 손오공 교체 1회) | 둘 다 main 최신 기준, 서로 충돌 없음, 합친 상태에서 tsc·시험 통과 | 리베이스 불필요 |
| 2-1 | 정체성 승격 계획서 생성기(읽기 전용) + 세부트림 두 번째 계획 | CODED · TESTED | #607 |
| 2-2 | 확정 규칙 한정 자동 적용(repair:vehicle-name-parity 경로) | 다음 | — |
| 2-3 | 보증금 계산값(deposit_source=CALCULATED) | 대기 | — |
| 2-4 | 사진 연결 승격(photo_original_refs 등록) | 대기 | — |
| 3 | 엔진 온라인 실행 설계(Actions) + DRY_RUN 워크플로 | DESIGNED · CODED · TESTED(설계 `docs/SOURCE-CYCLE-ONLINE-MIGRATION-DESIGN-20261014.md`(#605) §5) — 실행은 읽기 SA·변수 등록 후 | #608 |
| 3-1 | 시트 읽기 ADC 전송(SHEETS_TRANSPORT=adc, gws 없이 F05·아이카·오토플러스 시트) | CODED · TESTED | #618 |
| 4 | 5칸 지표·dispatchGap heartbeat + gap 사유 코드 | 대기 | — |

## 2. 정체성 승격 계획서 생성기 (2-1)

- 코드: `src/application/identity-promotion-plan.ts`(순수 함수), `src/jobs/plan-identity-promotion.ts`(파일 입력, 쓰기·네트워크 0), 시험 `tests/identity-promotion-plan.test.ts`.
- 실행: `VEHICLE_MASTER_SNAPSHOT_JSON=<스냅샷> PRODUCTS_JSON=<[{id,data}]> [IDENTITY_PROMOTION_OUT=<결과>] npm run plan:identity-promotion`.
- 대상: `vehicle_review_required=true` 이고 maker·model 이 빈 문서(엔진이 원문 차명으로만 편입한 문서).
- 규칙(`identity-promotion-plan/1`): 원문 차명(`원문.차명`, 없으면 `car_name`)에 활성 마스터의 세부모델 이름 또는 등록 별칭이
  공백·괄호·하이픈·대소문자 차이만 빼고 그대로 들어 있고(3글자 이상), 그 후보가 마스터 하나일 때만 계획에 싣는다.
- 보류 사유 코드: `RAW_NAME_MISSING` / `NO_MASTER_MATCH` / `MULTIPLE_MASTER_MATCH` / `MAKER_CONFLICT`(원문에 다른 제조사) /
  `HYBRID_SOURCE_CONFLICT`·`ELECTRIC_SOURCE_CONFLICT`(원문 동력 표기와 반대쪽 세부모델).
- 세부트림: 정체성이 특정된 상품만, 그 마스터의 세부트림 이름·별칭이 (세부모델 이름을 뺀) 원문에 그대로 있고 하나뿐이면 `trimPlans`(두 번째 계획).
  둘 이상(«모던»·«모던 플러스»)이면 `MULTIPLE_TRIM_MATCH`, 없으면 `NO_TRIM_MATCH` 보류. 적용 순서: `plans` 전부 적용·되읽기 → `trimPlans`.
- 하지 않는 것: 부분 일치·최장 일치 우선·연식으로 세대 추정(«신형» 등), 한 계획에 정체성+세부트림 겹치기, 마스터 수정.
- ★중복 가지 정리(클라우드 담당 결정 2026-10-14): `work/freepass-data/identity-plan-generator-20261014 @aedd36f` 는 합치지 않는다(#607 이 대체).
  실측 결함 — ① application→infra import 로 check:arch 실패 ② 엔진 편입 문서는 sub_model 에 원문 차명이 있어 전부 NO_MASTER_MATCH
  ③ 정체성+세부트림을 한 계획에 넣어 적용기 «one product per plan» 거부. 장점(세부트림 후보)은 위 trimPlans 로 옮겼다.
- 출력 계획서 = `VehicleNameRepairPlan` 의 `productIdentityRepairs` 만(200건 단위로 나눔). from 은 현재 저장값 그대로라
  적용기의 전제 조건(값이 바뀌었으면 거부)과 트랜잭션 안 «활성 마스터 정확히 하나» 재확인이 그대로 걸린다.
- 남은 것: 적용 후에도 `vehicle_review_required` 표식은 적용기가 지우지 않는다(현행 그대로) — 표식 해제 여부는 2-2 에서 결정필요로 올린다.
- 운영 입력 만들기(스냅샷·products 내보내기)는 운영 PC/커맨드 센터 몫. 스냅샷 나이는 적용 단계에서 다시 막힌다.

## 3. 막힌 것 / 결정필요

- (2-1) 없음 — 읽기 전용이라 스위치 불필요.
- (3) 온라인 DRY_RUN 은 읽기 전용 SA·WIF 변수(`SOURCE_CYCLE_WIF_PROVIDER`·`SOURCE_CYCLE_READ_SERVICE_ACCOUNT`)와 원천 비밀 등록이 있어야 돈다 → 커맨드 센터.
- (3-1) 시트 원천은 #618 합침 + 실행기 SA 를 각 시트에 «보기» 공유하면 온라인 DRY_RUN 에 넣을 수 있다(워크플로 원천 목록 확장은 후속 PR).
