# 정산 원장 잠금 문서의 «계약중 표시» 노출 설계 (한 장, 코드 없음) — 2026-10-15, DATA

> 대표 정정 10-15: «1397 은 우리 정산 시트에 있어서 우리가 내린 것 = 계약중으로 바꾼 것. **계약중은 출고불가가 아니다.** 판매가능 대수에 있어야 하고 대수에 맞춰야 한다.» → 계약 잠금(LEDGER) 문서도 «계약중 표시»로 노출한다. 손오공 노출 = ERP 저신용 337 전부(잠금 161허1397 포함).
> 이 문서는 읽기 전용 조사 절차와 설계만이다. **쓰기 경로이므로 코드 PR 은 확인 뒤, Codex 검토 대상.** DATA 세션은 라이브 문서를 읽지 못해 대수는 B3Q 조사로 채운다.

## 0. 코드로 확인된 사실
| 항목 | 내용 |
|---|---|
| 잠금 표식 | `locked_by_contract` 가 비어 있지 않은 값(`'LEDGER'`·계약 코드·true) — 엔진 envelope 의 `isContractLockValue`. 정산 잠금은 `locked_by_contract:'LEDGER'` + `_ledger_lock_at`(해제 도구 `contract-lock-release` 가 읽는 칸). **기록 주체는 이 저장소에 없다**(해제 도구만 있음) — 정산/ERP 쪽 쓰기 주체. |
| 엔진 | 잠금 문서는 계획에서 `CONTRACT_LOCKED` 보류로 건너뛰고(쓰기 0), 쓰기 경로(`compareAndApply`)도 `locked_by_contract` 문서는 `CAS_CONFLICT` 로 거부한다. 그래서 잠금 문서의 `listable`·`vehicle_status` 를 엔진이 바꿀 길이 없다. |
| 노출 정의(엔진 계열) | `nativeCycleFields`: 비노출 문서는 `listable:false`·`status:'출고불가'`·`vehicle_status:'출고불가'`·`status_kind:'불가'`. |
| ERP5 숨김 규칙(freepasserp5 코드) | 참조 구현 `isHiddenFromCatalog`: `_deleted===true` 또는 `vehicle_status==='출고불가'` 면 숨김, 그 밖에는 가격 행(`priceList`)이 ≥1 이면 노출. 공개 피드(`public-product-feed`)는 `listable !== false`. → **잠금 문서가 화면에서 빠지는 직접 원인은 `vehicle_status='출고불가'`(그리고 `listable=false`)** 이고, `vehicle_status='계약중'` + `listable=true` 로 바꾸면 노출된다(가격 행이 있어야 함). |
| 정합 지표 | `reconcileSource`: 원천 판매 가능 ∧ 문서 있음 ∧ 비노출 ∧ 잠금 문서는 `newHasDoc`·dispatchGap 사유 `SOURCE_ONLY_NOT_LISTABLE`/`…WITHDRAWN_OTHER` 로 섞여 세어지고 **«잠금이라서 비노출»로 따로 세지 않는다**. `missingLockedCount`(ERP 에만 노출·잠금)·`lockOverrideCount`(노출·잠금·값 다름)는 이 집합이 아니다. |

## 1. ① 조사(읽기 전용, B3Q) — 전 원천 «원천 판매 가능 ∧ 잠금 ∧ 비노출»
- 정의: 원천을 읽은 레코드 중 `saleAvailable===true` 인 차량 키 K 에 대해, 같은 번호의 문서 D 가 있고 `isContractLockValue(D.locked_by_contract)` ∧ (`D.listable!==true` ∨ `D.vehicle_status==='출고불가'`).
- 절차: 최신 plan evidence(원천 레코드)와 products 스냅샷을 키로 맞춰 원천별 건수 + 끝 4자리 목록 + 분포(`vehicle_status`·`status_kind`·`publication_withdrawal.reason`·가격 행 수 ≥1 여부·`_ledger_lock_at` 존재). 번호는 끝 4자리만.
- 알려진 값: 손오공 161허1397 1건(B3Q: «잠금 23건 중 하나» — 23건 전체의 원천·노출 여부는 이 조사로 확정).
- **코드 후보(읽기 전용, 별도 소 PR)**: `reconcileSource` 에 `lockedHiddenCount`(위 정의)와 gap 사유 `SOURCE_ONLY_LOCKED_HIDDEN` 추가 → 5칸 표/heartbeat 가 매 회차 원천별로 같은 수를 낸다.

## 2. ② 노출 방법 — 어디를 바꾸나
**권고 A(백필·상시): 엔진에 «잠금 노출» 좁은 쓰기 경로를 둔다.** 정산/ERP 쓰기 주체가 잠글 때 계약중 표시로 두게 하는 B 는 앞으로의 방지책이고, 이미 비노출인 문서(23건 내)의 백필은 엔진이 가장 안전하다(백업·CAS·되읽기·감사가 이미 있음).
- **대상**: 원천 판매 가능(레코드 존재 ∧ `saleAvailable===true`) ∧ 문서 잠금 ∧ 비노출 ∧ 가격 행 ≥1 ∧ `_deleted` 아님 ∧ 비노출 사유가 «잠금 노출로 되돌려도 되는 것»(철회 표식 없음 또는 엔진 자신의 `SOURCE_NOT_SELLABLE`/`REPLACED_BY_API`/`NOT_IN_API`/`INFO_INCOMPLETE`; 대표 지시 철회 `DECISION_WITHDRAWN` 은 제외).
- **쓰는 칸(updateMask 로 고정)**: `listable=true`, `vehicle_status='계약중'`, `status='계약중'`, `status_kind='선점'`, `publication_withdrawal=null`(이전 값은 `publication_withdrawal_prior` 에 보존). **절대 쓰지 않는 칸**: `locked_by_contract`·`_ledger_*`·가격(`price`)·계약/정산/날짜/보증금·원천 기록. 표시 상태는 원천 상태와 무관하게 항상 «계약중»(잠금이 이긴다 — 기존 «잠금 우선» 정책).
- **안전장치**: 별도 계획 항목 종류(`LOCK_EXPOSE`)로 ENROLL/UPDATE 와 섞지 않는다 → 계획 digest·감사에서 구분. `updateTime` CAS + 쓰기 전 잠금 값·`_ledger_lock_at`·가격 digest 가 계획 시점과 같음을 확인 + **되읽기에서 잠금·가격 칸이 쓰기 전과 한 글자도 다르지 않음**을 검증(다르면 APPLY_UNCERTAIN). 회차 상한(예: 30건), DRY_RUN 우선, 출처 코드 허용 목록(처음엔 RP012 한정 가능).
- **되돌림 경로**: 잠금이 풀리면(`locked_by_contract` null) 다음 일반 회차가 원천 상태로 갱신한다(현행). 잠금 노출 문서가 원천에서 사라지면 현행 «잠금 문서는 부재 하향 제외»가 그대로라 노출이 남는다 — 잠금 해제(정산 시트 근거) 뒤 일반 하향. 롤백은 `publication_withdrawal_prior` 와 백업으로.
- **하지 않는 것**: 원천에 없는 잠금 문서 노출(원천 판매 가능일 때만), 잠금 값·계약 필드 변경, 잠금 해제(해제는 `contract-lock-release` 의 시트 증거 절차).

**대안 B(정산 쓰기 주체)**: 잠글 때 `vehicle_status='계약중'`·`listable` 유지로 쓰게 변경 — 새 잠금부터 «숨겨지지 않음». 쓰기 주체가 이 저장소 밖이라 ERP/정산 담당 확인 필요. A 와 함께 요청하되 A 없이 백필은 안 된다.

## 3. ③ 5칸·dispatchableGap 영향
- 노출되면 해당 차는 «계약중·잠금 표시 노출»(`contractMarkedExposedCount`) 칸으로 간다 — `dispatchableExposedCount`(출고가능 노출)는 늘지 않는다.
- **주의(정직하게)**: 지금 정의로는 영향이 «없음»이 아니다. 원천이 그 차를 `출고가능`으로 읽으면 `sourceDispatchableCount`(원천 출고가능)에는 들어가고 `dispatchableExposedCount` 에는 안 들어가 **gap +1 이 «잠금 노출» 사유(`SOURCE_ONLY_LOCKED_EXPOSED`)로 남는다.** 대표 정의(«계약중은 판매가능 대수에 포함, 출고가능 비교만 제외»)에 맞추려면 **원천 출고가능 집계에서 «잠금 문서와 맞닿은 원천 레코드»를 뺀다**(잠금이 계약중으로 이기므로 원천도 계약중과 같이 취급). 이 변경은 읽기 전용 지표 변경이며 위 `lockedHiddenCount` 소 PR 에 함께 넣을 수 있다.
- 손오공 기대: 노출 337 = 334(현재) + 잠금 161허1397 등 노출 가능한 잠금 문서(+가격 행 있음 조건), 계약중 표시 칸 +해당 건수. 반납형 보유·인수형 규칙과 무관.

## 4. 구현 범위(확인 뒤)
1. (읽기 전용 소 PR) `lockedHiddenCount`·`SOURCE_ONLY_LOCKED_HIDDEN`·원천 출고가능 집계 보정 + 시험.
2. (쓰기 PR, Codex) `LOCK_EXPOSE` 계획 항목·`compareAndApply` 의 좁은 허용·되읽기 불변 검증·상한·허용 목록 + 시험: 잠금·가격 칸 불변, 비잠금 문서에 영향 없음, 원천에 없으면 노출 안 함, 철회 사유 허용 목록, 되읽기 불일치 시 UNCERTAIN, 잠금 해제 후 일반 경로 복귀.
3. 적용: DRY_RUN → plan 의 LOCK_EXPOSE 건수·번호 끝4 확인 → 정시 회차.

## 5. 결정이 필요한 것
1. 권고 A(엔진 «잠금 노출» 쓰기 경로) 승인 — 잠금 문서에 대한 엔진 쓰기를 «표시 칸 5개만, 잠금·가격 불변»으로 좁게 허용하는 것이므로 대표/커맨드 센터 확인 필요.
2. 대안 B(정산 쓰기 주체 변경)를 정산/ERP 담당에 요청할지.
3. 노출 대상 철회 사유 허용 목록(대표 지시 철회 `DECISION_WITHDRAWN` 제외)과 첫 적용 범위(RP012 한정 여부).
