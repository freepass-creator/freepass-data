# 이안카 «감지 후 자동 동기화» 실행기 (2026-10-12)

목적: ONE 갱신(synced_at 변화)마다 계획→건수 관문→적용을 돌려, 이안카 상태·보증금이 15분 신선 창을 넘기지 않고 따라가게 한다. 재개 조건과 되돌리기는 `IANCAR-COLLECTION-RECOVERY.md` 4-2절.

## 구성 (구현은 한 곳)
- `scripts/iancar-sync-watch.mjs` — 감시 루프/단발(`--once`). 20초 간격 목록 1건 조회(분당 3회), 새 갱신 한 번당 `collect-iancar-one-api --sync --photos-pending --keep-withdrawn [--apply-sync]` 한 번.
- `scripts/iancar-sync-watch-lib.mjs` — 판단 로직(순수 함수). 시험 `tests/iancar-sync-watch.node.mjs`(판단·분류·종료 코드·승인 거부·잠금 8건).

## 규칙
- **기본은 시험(적용 없음)**. 적용은 `--apply` 를 명시하고, 승인(`EANCAR_ONE_SYNC_APPROVED=true`)·건수 범위(`IANCAR_SYNC_EXPECT`, 필수 8키)·백업 버킷(`EANCAR_ONE_PRIVATE_EVIDENCE_BUCKET`)을 **외부(운영자)에서 환경변수로만** 받는다. 실행기는 이 값을 설정하지 않으며 없으면 시작을 거부(종료 코드 64).
- 새 갱신이 «갱신 후 15분 안»일 때만 실행. 이미 15분 지난 갱신은 읽지 않는다.
- **자동 재시도 없음**: 정상(적용 증거 `READBACK_VERIFIED` 또는 시험 계획 확인) 외 모든 결과(건수 관문 중단·시간 초과·429·신선도 초과·적용 증거 없는 종료)는 기록·알림 후 **정지**하고, 사람이 확인한 뒤 `--reset-halt` 로만 다시 시작한다. 정지 상태로 다시 켜면 종료 코드 2.
- 종료 코드: 정상 0 / 건수 관문 중단 3 / 그 밖의 실패 1 / 다른 실행 중(잠금) 75 / 설정 오류 64·65.
- **배타 잠금**: 감시·단발 어떤 조합도 동시에 돌지 못한다(프로세스가 살아 있는 잠금은 넘겨받지 않음, 죽은 프로세스의 잠금만 정리).
- 비밀: ONE 열쇠는 Secret Manager 에서 프로세스 메모리로만 읽고 **명령행 인자·출력·파일에 두지 않는다**(감지 조회도 프로세스 안 `fetch` 헤더). 기록(`history.jsonl`)에는 건수·상태·runId 만.

## 한계
- 이 PC 상시 프로세스 전제(절전·네트워크 단절에 약함). Data 소유 Actions/Cloud 실행기는 후속(IAM 은 대표 손 한 가지).
- ONE 이 15분보다 드물게 갱신하면 그 사이 공개 보증금은 UNKNOWN(신선 기준 900초는 완화하지 않음 — 정책 결정 필요).
