# 이안카 «감지 후 자동 동기화» 실행기 — 폐기 (2026-10-14)

이 실행기(`scripts/iancar-sync-watch.mjs`·`scripts/iancar-sync-watch-lib.mjs`, 시험 `tests/iancar-sync-watch.node.mjs`)와 그것이 부르던 `collect-iancar-one-api --sync/--apply-sync`(옛 `publishIancarPhaseOne`)는 **삭제됐다**.

- 근거: 대표 2026-10-14 «옛날 구버전 거는 과감하게 폐기해, 겹쳐 쓴 거 덮어쓴 거 과감하게 폐기, 어설프게 양립하다가 다 망해».
- 지금: 이안카(RP031) 상품 문서의 **유일한 작성 주체는 원천 엔진(source-engine)**이다(`src/adapters/source-cycle-plugins.ts` `iancarCyclePlugin`, `docs/SOURCE-ENGINE-PR577-SUMMARY-20261014.md`). 보증금 표시는 엔진 근거(`readIancarEngineDeposit`)만 읽는다.
- **ERP4 이안카 단계도 꺼야 한다**: ERP4 쪽 이안카 단계는 이 저장소의 옛 `publishIancarPhaseOne`을 고정 pin 으로 부른다. 그 단계가 살아 있으면 엔진과 이중 쓰기가 된다. 이 저장소 밖 작업이라 여기서 끄지 못한다 — ERP4 담당이 먼저 제거한다.
- 사진은 사진 전용 경로(`npm run source:iancar:one -- --photos [--apply-photos]`, 복원 `--restore-photos=`)로만 반영한다.
- Firestore 데이터는 지우지 않았다. 옛 문서의 `iancar_phase_one` 등 칸은 남아 있지만 판정 근거가 아니다.
