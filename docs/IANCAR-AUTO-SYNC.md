# 이안카 «감지 후 자동 동기화» 실행기 (2026-10-12)

목적: ONE 갱신(synced_at 변화)마다 계획→건수 관문→적용을 자동으로 돌려, 이안카 상태·보증금이 15분 신선 창을 넘기지 않고 따라가게 한다. 재개 조건과 되돌리기는 `IANCAR-COLLECTION-RECOVERY.md` 4-2절.

## 구성
- `scripts/iancar-sync-watch.mjs` — 감시 루프(20초 간격 목록 1건 조회, 분당 3회 이하). 변화 감지 시 `collect-iancar-one-api --sync --photos-pending --keep-withdrawn --apply-sync` 실행.
- `scripts/iancar-sync-watch-lib.mjs` — 판단 로직(순수 함수, `tests/iancar-sync-watch.node.mjs` 8건).
- `scripts/iancar-apply-once.sh` — 한 번만 돌리는 단발판.

## 규칙(판단 로직)
- 새 갱신이 «갱신 후 15분 안»일 때만 실행. 이미 15분 지난 갱신은 읽지 않는다(신선도 중단 방지).
- 같은 갱신에서 일시 오류(시간 초과·502/503/504·쓰기 직전 문서 변경)는 갱신 후 5분 안에 한해 최대 2회.
- 건수 승인 범위 밖(종료 코드 3)은 **정지**하고 알림(`alerts.log`) — 사람이 범위를 재승인할 때까지 자동 재시도 없음.
- 429 는 10분 물러남. 연속 실패 3번이면 정지. 신선도 초과는 실패로 세지 않고 다음 갱신을 기다림.
- «적용 증거(READBACK_VERIFIED)» 없는 정상 종료는 성공이 아니다.

## 승인·비밀
- 적용 모드는 운영자가 시작 시 `EANCAR_ONE_SYNC_APPROVED=true`, `IANCAR_SYNC_EXPECT`(필수 8키), `EANCAR_ONE_PRIVATE_EVIDENCE_BUCKET` 를 직접 설정해야 시작한다(없으면 거부). `--dry` 는 계획만.
- ONE 열쇠는 Secret Manager 에서 프로세스 메모리로만 읽고 출력·저장하지 않는다. 기록(`history.jsonl`)에는 건수·상태·runId 만 남는다.

## 실행 위치와 남은 것
- 이 PC 에서 상시 프로세스(예: 작업 스케줄러가 로그온 시 시작)로 돌리는 것이 지금 가능한 길이다. 절전·네트워크 단절에 약하므로 Data 소유 Actions/Cloud 실행기는 후속(WIF·IAM 은 대표 손 한 가지).
- 한계: ONE 이 15분보다 드물게 갱신하면 그 사이 공개 보증금은 UNKNOWN(신선 기준 900초는 완화하지 않음 — 정책 결정 필요).
