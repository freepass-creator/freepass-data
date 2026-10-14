# 원천 실행기 STOPPED 해제 절차 (한 장) — 2026-10-14, DATA

> 실행은 B3Q, 실행 전 커맨드 센터 확인. DATA 는 상태 파일을 직접 수정하지 않는다. 대상 예: 손오공 RP012(APPLY_UNCERTAIN 누적).

## 0. 먼저 STOPPED 가 맞는지, 풀어도 되는지 판정
| 확인 | 방법 | 풀기 전 필요한 결과 |
|---|---|---|
| 정지 여부 | heartbeats.jsonl 해당 원천 마지막 줄 `stopped:true`·`failures:3`, 또는 요약 «연속 실패 3회: 수동 원인 확인 필요» | 맞음 |
| 정지 사유 | 마지막 줄 `error`, alerts.jsonl `STOPPED:<코드>` | 코드를 안다(예: APPLY_UNCERTAIN) |
| 원인 수정 배포 | 엔진 체크아웃 커밋이 수정 포함(#622+#625 = 4adc2225 이상, 계약중 잠금 수정 3f3f639 합침 시 그 이후) | 확인됨 |
| 쓰인 문서 일관성 | 마지막 APPLY 의 plan/receipt 로 «쓴 건수» 와 카탈로그 노출 대수가 일치하는지, 불일치 문서가 계약중 1건뿐인지 | 사람이 판단(읽기 전용) |
| 자동 복구 가능성 | **APPLY_UNCERTAIN 정지는 자동 냉각 복구가 없다**(쓰기 결과를 사람이 확인하라는 설계). 그 밖의 연속 실패 정지는 60분 냉각 뒤 자동으로 한 번 더 시도한다 | APPLY_UNCERTAIN 이면 아래 수동 절차, 아니면 60분 대기 |

## 1. 실패 수 1~2 단계(아직 STOPPED 아님)
아무것도 하지 않는다. 다음 정시 회차가 새로 읽고 계획·적용하며 성공하면 `failures=0`·`error=null` 로 돌아온다(요약에서 확인).

## 2. STOPPED 수동 해제 (사람, 한 번)
상태 파일 위치: `<SOURCE_CYCLE_PRIVATE_DIR>/<sha256(JSON "RP012")>.state.json`
- RP012: `d5ff1c095de4ce4cbca364e4527ac7965b1f4e60b54845c6302b6e2193bc7be4.state.json` (같은 이름 규칙: 원천 코드 문자열의 JSON 직렬화 SHA-256). 잠금 파일은 같은 이름의 `.lock`.

절차(무인 회차가 돌지 않는 시각, 예약 회차 사이에):
1. **실행 중이 아님 확인**: 같은 이름 `.lock` 파일이 없고 FreePass-Source-Cycle 이 실행 중(Running)이 아님. `.lock` 이 있으면 해제하지 말고 중단(소유 pid 확인은 엔진이 한다).
2. **백업**: 상태 파일을 `<이름>.state.json.bak-<시각>` 으로 복사(비공개 디렉터리 안에서).
3. **수정 3개 필드만**: `stopped=false`, `failures=0`, `error=null`. 다른 필드(lastCompleteAt·lastSyncedAt·heldReasons·reconciliation)는 그대로 둔다. `failures>=3 && stopped=false` 조합은 엔진이 CYCLE_STATE_INVALID 로 거부하므로 둘을 함께 바꾼다.
4. **원자적 교체**: 임시 파일에 쓰고 이름 바꾸기(부분 쓰기 금지). JSON 이 유효한지 확인.
5. **알림 기록**: alerts.jsonl 에 사람 해제 사실을 남긴다(원천·사유·시각·누가). 증거 보존.
6. **한 회차만 단독 확인**: 해당 원천만 DRY_RUN(수동 --plan)으로 계획을 보고(간격 소비 없음 — 0f7c36d 이후), 변경 건수가 예상(남은 미적용분)과 같은지 확인한 뒤 다음 정시 회차를 기다린다.
7. **다음 회차 결과 확인**: 요약에 «되읽기 N/N (APPLIED)» 와 `failures 0`. 다시 APPLY_UNCERTAIN 이면 해제 반복 금지 — 진단 코드(`불확실 READBACK_MISMATCH:<종류>:<필드>` / `WRITE_FAILED`/`READ_FAILED`)를 DATA 에 전달.

## 3. 하지 않는 것
- 상태 파일 삭제로 «초기화»하지 않는다(lastCompleteAt·보류 사유·정합 보고가 사라져 신선도·정합 판단이 끊긴다).
- 쓰기 중 문서를 되돌리지 않는다(엔진은 되돌림 없음이 현행, 롤백은 별도 승인 경로).
- 잠금 파일(.lock)을 살아 있는 소유 pid 가 있는데 지우지 않는다.
- 수정 배포 확인 전에 해제하지 않는다(같은 지점에서 다시 멈춘다).

## 4. 해제 직후 기대 상태(손오공 예)
- 남은 미적용분이 편입 상한(100/회차 또는 CAP_ONCE 한 번)에 맞춰 1~2회차에 반영, 계약중 문서는 엔진 작성 표식(source_cycle_write)과 함께 쓰이고 되읽기 일치.
- 이미 잠긴 계약중 1건은 ERP 해제 전까지 CONTRACT_LOCKED 보류(결정 2026-10-14, 보정 안 함).
