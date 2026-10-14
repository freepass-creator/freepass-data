
## 5. 구현 현황 (클라우드 구현 담당, 2026-10-14)
- **DRY_RUN 워크플로(#608)**: `.github/workflows/source-cycle-dry-run.yml` + `scripts/ci/source-cycle-dry-run.mjs`. 수동 + 정기(:17, `vars.FREEPASS_SOURCE_CYCLE_DRY_RUN_SCHEDULE=on` 일 때만). `--apply`·`--unattended` 없음, 쓰기·승인·인계 스위치를 자식 환경에서 삭제, 적용 흔적이 보이면 실패. 읽기 SA 변수(`SOURCE_CYCLE_WIF_PROVIDER`·`SOURCE_CYCLE_READ_SERVICE_ACCOUNT`) 없으면 실패로 표시. 원천 키·주소 없으면 그 원천 SKIPPED. 지금 대상: IANCAR·IRON·AUTOPLUS(홈피).
- **시트 ADC 전송(#618)**: `SHEETS_TRANSPORT=adc` 면 F05·아이카·오토플러스 시트를 gws 없이 읽는다(§1 «data-owned-refresh 위임 읽기 패턴» = `GOOGLE_SHEETS_APPLICATION_CREDENTIALS`·`GOOGLE_SHEETS_SUBJECT` 또는 ADC). 기본값(gws, B3Q) 동작 불변. #618 합침 후 DRY_RUN 원천 목록에 F05·AICA 추가(후속 PR) → §3-1 순서대로.
- **남은 코드 작업**: 회차 상태(기준 건수·잠금·한 회차 표식·heartbeat·실행 기록)를 Firestore ops 컬렉션으로(§1, 쓰기 전환의 전제). 그 전까지 온라인은 DRY_RUN 만.
