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
- **성공은 구조화된 영수증으로만**: 종료 코드 0 이고 최종 보고 JSON 의 `status=IANCAR_ATOM_SYNC_VERIFIED_CONSUMERS_PENDING` 와 `publication.status=PHASE_ONE_ATOM_READBACK_VERIFIED` 가 모두 맞을 때만 적용 성공(시험 모드는 `OBSERVED_NOT_PUBLISHED` + 계획 있음 + 적용 없음). 사유 문장에 성공 문구가 들어 있어도 성공이 아니다.
- **감지 조회 실패도 무한 재시도 없음**: 연속 3번 실패(응답 없음·HTTP 오류·날짜로 해석되지 않거나 1분 넘게 미래인 값)하면 정지(종료 1).
- **배타 잠금**: 감시·단발 어떤 조합도 동시에 돌지 못한다. 잠금·상태 위치는 환경변수와 무관한 OS 계정 홈 고정 경로(`~/.freepass-data/`, `os.userInfo`)다(`--lock-root` 는 시스템 임시 폴더 아래만 허용되는 시험 전용). 잠금이 남아 있으면 **항상 종료 75** — 죽은 프로세스의 잠금도 자동으로 넘겨받지 않는다(인계 경쟁 자체를 없앰). 비정상 종료로 남은 잠금은 사람이 «수집기 자식이 남아 있지 않음»을 확인한 뒤 잠금 폴더를 직접 지운다. 종료·신호 때는 자식 수집기 트리를 끝내고 **종료를 확인한 뒤, 내 잠금일 때만** 지운다(확인 못 하면 잠금을 남긴다).
- 비밀: ONE 열쇠는 Secret Manager 에서 프로세스 메모리로만 읽고 **명령행 인자·출력·파일에 두지 않는다**(감지 조회도 프로세스 안 `fetch` 헤더). 기록(`history.jsonl`)에는 건수·상태·runId 만.

## 한계
- 이 PC 상시 프로세스 전제(절전·네트워크 단절에 약함). Data 소유 Actions/Cloud 실행기는 후속(IAM 은 대표 손 한 가지).
- 보증금 신선도 결정(대표 10-12 «안전장치 풀어·바꾸고»): ERP5 는 원천 갱신 후 15분이 지나도 «마지막 원천의 양수 보증금»을 표시한다(freepasserp5 #79 운영 반영, 되돌림 환경변수 `ERP5_IANCAR_STALE_DEPOSIT=off`). **Data 쪽 신선 기준 900초(`IANCAR_PUBLISHED_DEPOSIT_FRESHNESS_SECONDS`)는 그대로** — 재고·상태 신선도 기준이며 이 실행기의 «갱신 후 15분 안에만 실행» 규칙도 그대로다. 즉 ONE 이 15분보다 드물게 갱신해도 ERP5 보증금은 UNKNOWN 으로 비지 않는다(ERP5 표시 쪽 결정).
