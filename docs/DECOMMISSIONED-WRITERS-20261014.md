# 폐기 목록 — 원천별 작성자 하나로 (2026-10-14)

대표 2026-10-14: «옛날 구버전 거는 과감하게 폐기해 … 괜히 어설프게 양립하다가 다 망해.» / «지울 거는 그냥 지우는 걸로 폐기 딱지만 붙이고 모든 연동은 다 최신화로.»
원칙: 원천별 상품 문서 작성자는 **원천 엔진(`source-cycle-runtime`) 하나**. 옛 경로는 코드에서 지우고 여기에 딱지만 남긴다. Firestore 데이터는 지우지 않는다(옛 칸이 남아도 판정은 엔진 근거가 우선).

| 원천 | 폐기한 것 | 대체 | PR |
|---|---|---|---|
| 이안카 RP031 | `publishIancarPhaseOne`·`restoreIancarPhaseOne`·`withdrawIancarPublication`(옛 1차 발행·철회), `collect-iancar-one-api --sync` 계열, `scripts/iancar-sync-watch*`(감시기), `collect-iancar-direct`(옛 직접 수집기), `withdraw-iancar-publication`(일회성), `iancar-sync-gate`, `readIancarPublishedDeposit` | 엔진 IANCAR 플러그인 + 보증금 판정 `readIancarEngineDeposit`(엔진 근거 `source_cycle_record`) | #639 |
| 오토플러스 RP023 | 엔진 홈피 쓰기 모드(`SOURCE_CYCLE_AUTOPLUS_HOMEPAGE_WRITE`, `autoplusHomepageWritePlugin`) | 시트 모드(`SOURCE_CYCLE_AUTOPLUS_SHEET=1`) 하나. 홈피는 읽기 전용 대조 보고만 | #638 |

## 이 저장소 밖 — 커맨드 센터가 꺼야 끝난다
- **ERP4 이안카 단계**(`erp5-ssot-refresh` 가 이 저장소의 옛 `publishIancarPhaseOne` 을 pin 으로 부름) → 제거. 켜 두면 엔진과 이중 쓰기.
- **ERP4 오토플러스 시트 단계** → 제거 후 B3Q 에서 `SOURCE_CYCLE_AUTOPLUS_SHEET=1` 켜기.

## 남은 빈칸(담당 정할 것)
- 이안카 신규 차 사진: 옛 ERP4 단계가 하던 일 → 사진 전용 경로(`collect-iancar-one-api --photos/--apply-photos`)를 누가 돌릴지.
- 오토플러스 사진: 엔진 연결 경로 없음.
- 오토플러스 보증금: 시트 «보증금» 열이 없으면 계산 규칙(×2/×3) 대표 결정.
