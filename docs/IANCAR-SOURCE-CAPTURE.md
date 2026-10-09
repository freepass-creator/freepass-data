# Iancar source capture

## Direct ERP intake — 2026-09-30

User decision: Iancar supplier ERP is the vehicle source; the Google Sheet is not an inventory-source fallback.
`iancarErpReadTransport()` now implements the existing authenticated supplier login/inventory protocol in
FreePass Data. Credentials are supplied only by `IANKA_ACCOUNT_JSON`; response bodies, cookies and credentials
are never printed on authentication/HTTP failure. Redirects are rejected. No new writer or Firebase path exists.

The existing job supports:

```sh
node --import tsx src/jobs/ingest-erp5-source.ts --iancar-erp --dry-run
```

It requires the existing read-audit token/bucket plus the supplier credential. Without `--dry-run`, the existing
`ERP5_SOURCE_INGEST_APPROVED=true` gate is still required and the existing SourceIngestionStore owns RAW writes.
This mode does not read either Sheet, and does not filter out previously unregistered vehicles. It preserves
the full response as one RAW record and separate supplier-vehicle-ID records, including reserved stock.
The job emits only counts, observation time, checksums and coverage. Canonical review and consumer publication
are not bypassed by RAW intake.

**Coverage is PARTIAL even when every advertised row is captured.** The observed API exposes available/reserved
inventory, while `fleetTotal` can be much larger. Per-model counts, inventory/reservation totals and duplicate IDs
are checked. Stale, future or over-one-hour supplier observations remain INCOMPLETE. An absent vehicle cannot be
retired from this endpoint. Rental rates are not present: pricing remains UNKNOWN/HOLD, never 0 or a silent Sheet fallback.

(2026-09-30 기록) Operational cutover was **NOT VERIFIED** then: the production legacy bridge used its old Sheet source and pin. 2026-10-03 기준 ERP4 refresh는 RP031 옛 Sheet 수집을 제외하고(`RP031_API_CUTOVER_HOLD`) ONE API Data 실행기를 쓴다.
The supplier credential exists in the ERP bridge's GitHub secret but is not present in the local central job or
central runtime Secret Manager. Do not copy it into code, public workflow logs or artifacts. Actual secure runtime
binding, reviewed candidate mapping, exact writer/publisher cutover and every consumer readback remain required.

## 이안카 정본과 대체 순서 — 2026-10-04 사용자 결정

이안카(RP031) 재고 정본은 **이안카 시스템 하나**다.

1. 기본: ONE 공식 API([IANCAR-ONE-API.md](IANCAR-ONE-API.md)).
2. 대체: ONE API가 막히면(인증 실패·연속 오류) 이 문서의 로그인 `/api/inventory` 경로를 쓴다. 열쇠는 기존 `IANKA_ACCOUNT_JSON` 하나이며 새로 만들지 않는다. 두 경로는 같은 공급사 ERP 동기화(`syncedAt`/`stale`)에서 나오므로, ONE API가 정상이면 로그인 경로를 함께 돌리지 않는다. 대체로 바꿀 때도 같은 freshness/stale HOLD 규칙을 그대로 적용한다.

공급사 원본 Google Sheet(`이안카_프리패스`)와 F54는 **이안카 출처로 쓰지 않는다**(정본·대체·비교 기준 모두 아님). 이전의 ERP+Sheet 두 원천 묶음 캡처(`captureIancarSource`/`persistIancarCapture`)는 운영 호출처가 없어 2026-10-04 코드에서 제거했다. 아래 날짜 이력의 Sheet 수치는 당시 기록일 뿐이다.

The existing authenticated `/api/inventory` path contains inventory facts but does not establish complete
rental-rate coverage. Until the ERP rate source is captured and `rateCoverageComplete=true` is supported by
evidence, pricing remains `HOLD`. Google Sheet prices do not silently replace missing ERP rate evidence.

This module imports no Firebase client or canonical writer. No Firebase writes, Sheet writes, Canonical writes,
publication, or consumer cutover are authorized by this unit.
