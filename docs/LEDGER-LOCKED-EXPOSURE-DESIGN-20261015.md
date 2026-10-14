# 정산 잠금 차량의 «계약중» 노출 — 수정 설계 한 장 + 1397 한 건 계획서 (2026-10-15)

상태: DESIGNED. 코드 변경 없음, 라이브 읽기·쓰기 없음. 결정 주체는 커맨드 센터·대표(Codex 독립 검토 결론 «B 우선, A 는 기존 문서 한정 백필» 채택).

## 0. 사실(코드 기준, 이 저장소)

| 사실 | 근거 |
| --- | --- |
| 잠금 값 허용표: `locked_by_contract` 가 undefined·null·false·'' 가 아니면 전부 잠금('LEDGER'·true·객체 포함) | `isContractLockValue` (`src/infra/source-cycle-firestore.ts`) |
| 엔진은 잠금 문서를 쓰지 않는다(CONTRACT_LOCKED 보류, 쓰기 단계 CAS 도 거절). 엔진이 «원천이 직접 계약중으로 읽은 값»을 쓴 문서만 잠금이 아니다 | `engineWroteContracted`, `src/application/source-cycle.ts:127` |
| 잠금 **해제** 경로만 이 저장소에 있다: `release-contract-locks` 잡 → `contract-lock-release`(증거) → `contract-lock-firestore`(조건부 해제, `_ledger_lock_at` 일치 CAS)·`contract-lock-release-update`(이전 값은 `_ledger_unlock_previous`·`_ledger_unlock_history` 로 보존) | `src/jobs/release-contract-locks.ts` 등 |
| 잠금 **설정**(locked_by_contract='LEDGER' + `_ledger_lock_at`)을 쓰는 코드는 이 저장소에 없다 → 정산 담당(DEV·OPS·정산) 소유 | 저장소 전체 검색: 설정 쓰기 없음 |
| ERP5 는 `vehicle_status='출고불가'`·`listable=false` 문서를 숨긴다 | 기존 참조 `isHiddenFromCatalog`, 공개 피드 `listable !== false` |

따라서 «잠긴 차량이 화면에서 사라진다»의 원인은, 잠금 설정 주체가 잠그면서 표시 칸(listable·status)을 계약중 노출 상태로 유지하지 않고, 엔진도 잠금 문서를 쓰지 않아 아무도 노출을 맞추지 않는 것이다.

## 1. 정상 경로 B — 잠금을 거는 정산 쓰기 주체가 표시 칸을 함께 유지

### 1.1 쓰기 규칙(정산 쪽이 확정해야 하는 항목 — 이 문서는 제안)
잠글 때 **한 번의 조건부 쓰기(CAS: 문서 updateTime)** 로 아래를 같이 쓴다. 이미 노출 중(listable=true)이던 문서만 해당한다.

| 칸 | 값 | 비고 |
| --- | --- | --- |
| `locked_by_contract` | `'LEDGER'` | 종전과 동일 |
| `_ledger_lock_at` | 잠금 시각(ms) | 해제 CAS 키 |
| `listable` | 변경 없음(true 유지) | 잠금이 노출을 끄지 않는다 |
| `status` / `vehicle_status` | `'계약중'` | 표시 상태 |
| `status_kind` | `'선점'` | ERP5 재고 계약표(계약중=선점) |

숨김(비노출) 문서는 잠금이 노출을 **켜지 않는다**(원래 안 보이던 것은 그대로).

### 1.2 잠금·해제·재잠금 경로
- 잠금: 위 한 번의 CAS 쓰기. 실패(CAS 충돌)는 재시도하지 않고 재계획한다.
- 해제: 기존 `release-contract-locks`(접수 시트 증거·`_ledger_lock_at` 일치). 해제는 `locked_by_contract=null` 만 쓰고 표시 칸은 엔진 다음 회차가 원천 값으로 갱신한다(엔진이 쓴 계약중이면 잠금 아님, 원천이 출고가능이면 출고가능).
- 재잠금: 새 `_ledger_lock_at` 으로 위 규칙 반복. 이전 해제 이력은 `_ledger_unlock_history` 에 보존된다(기존 코드).

### 1.3 최종 결정 주체
- 잠금 설정 코드 위치·필드 소유: **정산 담당(DEV·OPS·정산)** — 코드 위치 확인과 위 표의 확정이 필요하다(아래 §5 질문).
- 엔진(DATA)은 잠금 문서를 쓰지 않는다는 규칙을 바꾸지 않는다(장부 잠금 차량을 원천이 덮어쓰지 않는 안전선).

## 2. A — 기존 문서 한정 백필(상시 경로 아님)

B 가 적용되기 전에 이미 잠겨 숨겨진 문서의 «표시 칸»만 한 번 맞춘다. 엔진 규칙·잠금 값은 건드리지 않는다.

**범위 고정**: RP012 한정, 확인된 문서 ID 목록, 승인된 계획 건수로 고정(예시 건수 금지). 첫 범위 = 끝4 «1397» 한 건.

**포함 조건(전부 충족)** — Codex 필수 조건
1. 공급사 코드 RP012 (그 밖의 공급사 제외).
2. 유효한 계약 진행 잠금: `locked_by_contract === 'LEDGER'` 이고 `_ledger_lock_at` 이 유한한 양수 ms. 사유 불명·내부 보류·알 수 없는 객체 잠금은 제외.
3. `publication_withdrawal` 표식이 없다(철회 문서 제외).
4. 가격 유효 행이 하나 이상(`price` 에 rent 양의 정수 행). 가격 없는 문서 제외.
5. 정확한 문서 ID로 지정(끝4 번호는 표시용 — 선택 키로 쓰지 않는다).
6. `REPLACED_BY_API`·`INFO_INCOMPLETE` 같은 사유 문서를 일괄로 허용하지 않는다(개별 문서·개별 승인).

**쓰기 6칸**(문서당 하나의 CAS 쓰기)
`listable=true`, `status='계약중'`, `vehicle_status='계약중'`, `status_kind='선점'`, `publication_withdrawal=null`(철회 표식이 없음을 확인한 문서만), `publication_withdrawal_prior`(기존 값 그대로 보존 — 비어 있으면 null 유지, 쓰기 전후 동일).
`locked_by_contract`·`_ledger_lock_at` 은 쓰지 않는다(잠금 불변).

**안전 절차**
- 계획 파일(dry-run): 문서 ID·현재 updateTime·현재 6칸 값·digest. 승인 건수와 계획 건수가 다르면 중단.
- 쓰기 직전 문서를 다시 읽어 조건 재확인 + updateTime CAS. CAS 충돌·«예상 대상 증가» 시 즉시 중단하고 재계획(자동 재시도 없음).
- 쓰기 전 백업(문서 전체), 쓰기 후 되읽기(6칸 일치 + `locked_by_contract`·`_ledger_lock_at` 불변 확인).
- **롤백도 CAS**: 백업의 6칸을 되돌리되 현재 updateTime 이 «우리 쓰기 직후 값»일 때만. 달라졌으면 중단·보고.

## 3. 출고가능 비교 규칙(양쪽 공통)
원천(API) 대비 ERP5 출고가능 비교에서 «유효한 계약 잠금으로 확인된 대상»만 양쪽에서 제외한다(위 §2 조건 2 와 같은 자격). 제외 전 원래 수와 제외 수를 **따로** 남긴다(예: `listed=N, excludedLocked=M`). 숫자를 맞추려고 노출을 승인하지 않는다(334→337 맞추기 금지) — 숫자는 결과이지 승인 근거가 아니다.

## 4. 1397 한 건 계획서 (DESIGNED — 실행은 승인 후, 라이브 작업은 DEV·ERP5)

| 항목 | 값 |
| --- | --- |
| 공급사 | RP012 (손오공) |
| 대상 | 끝4 `1397` 한 건 — **정확한 문서 ID 는 DEV 가 읽기 전용 조회로 확인해 계획서에 기입**(이 문서에는 전체 번호·ID 를 적지 않는다) |
| 승인 건수 | 1 (계획 건수 ≠ 1 이면 중단) |
| 사전 확인(읽기 전용) | 문서 존재 1건, §2 포함 조건 1~6 충족, 현재 `listable`·`status`·`vehicle_status`·`status_kind`·`publication_withdrawal`·`publication_withdrawal_prior` 값과 updateTime 기록 |
| 쓰기 | §2 의 6칸 한 번의 CAS 쓰기 |
| 쓰기 후 확인 | 되읽기 6칸 일치, `locked_by_contract`·`_ledger_lock_at` 불변, 공개 피드에서 해당 차가 «계약중» 으로 1건 노출, 출고가능 집계 불변 |
| 중단 조건 | 조건 불충족·CAS 충돌·대상 건수 증가·백업 실패·되읽기 불일치 |
| 롤백 | 백업 6칸을 CAS 로 복원 후 되읽기 |
| 승인 | 커맨드 센터(대표) — 이 계획서 승인 전 쓰기 금지. 쓰기 주체는 DEV·ERP5(운영 쓰기 권한), DATA 는 계획 도구·시험만 |

## 5. 정산 담당에 묻는 것(B 확정에 필요)
1. 잠금 설정 코드(`locked_by_contract='LEDGER'`, `_ledger_lock_at`)의 저장소·파일 위치.
2. 잠금 시점에 현재 표시 칸(listable·status·vehicle_status·status_kind)을 어떻게 다루는지(그대로 두는지, 바꾸는지).
3. §1.1 표의 5칸 쓰기를 한 번의 CAS 로 같이 쓰는 것에 동의하는지, 다르면 대안.
4. 잠금이 걸리는데 노출 중이 아니던 문서(원래 숨김)의 처리 — 노출을 켜지 않는 것이 맞는지.

## 6. 하지 않는 것
- 엔진의 CONTRACT_LOCKED 보류 규칙 변경, 잠금 값 허용표 변경.
- 숫자 맞추기를 위한 일괄 노출, REPLACED_BY_API·INFO_INCOMPLETE 일괄 허용.
- 시험 데이터 외 실제 번호·문서 ID·키를 문서·커밋·보고에 적는 것(끝4 표시만).
