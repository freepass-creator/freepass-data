# 아이카·빌린카 새 수집 파이프라인 편입 (1차, 2026-10-12)

상태: CODED(편입 현황 도구·차단 코드 노출) / 아이카 실제 적재는 HOLD. 차량번호·시트 ID·토큰 없음. 상위 계획은 `COLLECTION-HEALTH-PLAN.md`, 경로·신선도는 `SUPPLIER-COLLECTION-ROUTES.md`(PR #499).

## 1. 실측 (2026-10-12 06:20 KST, 프리패스 데이터 읽기만)
`npm run intake:coverage` — 판매 중 차량 중 «최신 완료 공통 시트 run 의 원문에 같은 차량번호가 있는» 비율.

| 공급사 | 경로 | 판매 중/전체 | 편입 | 판정 |
| --- | --- | --- | --- | --- |
| 빌린카 RP021 | 공통 시트(`shared-sheet` run) | 34/47 | 34 (100%) | FULL — 이미 새 파이프라인. 마지막 완료 run 은 점검 시각 기준 약 3시간 전(15분 준수율 이슈에 종속) |
| 아이카 RP004 | 직접 수집기(`collect-aica`) | 89/250 | 0 | NOT_INTAKEN — source_runs 에 아이카 sourceId run 이 한 번도 없다 |

빌린카는 별도 이식이 필요 없다. 남은 것은 (a) 15분 주기 복구, (b) 정책(F67)과 상품 갱신 시각 분리 관찰이다.

## 2. 아이카 편입 경로와 막힌 층
수집기(`src/jobs/collect-aica.ts` + `aicaSheetsGridReader`)는 이미 있다: 공급사 원본 시트 3탭의 원본 셀·차량번호 칸 링크를 읽어 RAW 로 남기고 `--apply-raw` + `AICA_RAW_INGEST_APPROVED=true` 일 때만 적재한다.

2026-10-12 읽기 전용 첫 실제 실행 결과: **DATA_GOOGLE_AUTH_UNAVAILABLE**. 이 PC 의 기본 인증(ADC)이 시트 읽기 범위(`spreadsheets.readonly`)를 발급하지 못한다 — 코드·바인딩 문제가 아니다. 이전에는 CLI 가 모든 실패를 `AICA_CAPTURE_HOLD` 한 코드로 삼켜 원인이 보이지 않았다. 이번 변경으로 고정 오류 코드가 함께 출력된다(알 수 없는 오류는 `UNEXPECTED`).

실행 순서(승인된 사람만):
1. 시트 읽기 범위가 있는 인증을 준비한다(ADC 재설정 또는 읽기 전용 서비스 계정의 시트 공유). 키·토큰을 저장소에 두지 않는다.
2. 바인딩은 환경변수 `AICA_GRID_BINDINGS_JSON`(시트 ID·탭 gid·`A1:` 시작 범위·차량번호 열 번호 0기준)으로 준다. 시트 ID 는 비공개 저장소 ai-ops `docs/지도/SHEET_MAP.md` 에서 가져온다 — 이 저장소에 쓰지 않는다. 탭: 장기특별이벤트·중고재렌트·신차선출고.
3. 읽기 전용 실행: `npm run source:aica:capture` → counts/digest/issues 확인(이슈 0 이면 `RAW_READY`).
4. 적재(쓰기): `AICA_RAW_INGEST_APPROVED=true npm run source:aica:capture -- --apply-raw` — 운영 쓰기이므로 지휘통제실 승인 뒤.
5. 적재 뒤 `npm run intake:coverage` 로 아이카 run 생성을 확인한다. 현재 도구는 아이카 run 의 존재·시각만 증거로 삼고 차량 단위 대조는 하지 않는다(아이카 raw 구조가 확정되면 같은 해시 대조를 추가).

사진 귀속 UNKNOWN(원본 링크 33대 미매칭)은 그대로 둔다 — 링크를 `image_urls` 로 승격하지 않는다.

## 3. 신선도 지표 연결
- 우리 수집 쪽: `intake:coverage` 의 «마지막 run 경과(분)» 와 편입률. 공급사 정체는 아님.
- 공급사 쪽: `scripts/supplier-freshness.mjs`(PR #499)의 «마지막 변경 후 경과»·`SUPPLIER_STALE`. 아이카·빌린카 판정은 변경 이력이 3회차 이상 쌓인 뒤부터 나온다.
- 두 지표는 섞지 않는다: 편입률 100% 이고 run 이 최신인데 변경이 없으면 공급사 정체, run 이 오래됐으면 우리 수집 문제.

## 4. 목표 대비 (이 담당 범위)
편입: 빌린카 34/34 · 아이카 0/89 → 123대 중 34대(28%). 아이카 적재가 되면 123/123. 보류 비율·15분 준수율은 `COLLECTION-HEALTH-PLAN.md` A·B절 담당(다른 세션).

검증: `npm run test:intake-coverage` 5건, `tests/supplier-native.test.ts` 42건 통과, 구조·데이터 접근 경계 검사 통과. 운영 쓰기·IAM·시트 쓰기 0.

독립 검토(Codex gpt-5.5 읽기 전용; Gemini 는 서버 오류 500 으로 불가): 차량번호 열 가정 검증(번호판 모양 90% 미만이면 경고)을 반영. 구현은 Claude Sonnet 5.5.
