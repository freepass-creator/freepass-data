# F01/F86 온라인 연결 상태 (2026-09-21)

표시 정본은 `contracts/f01-f86-sheet-spec.v1.json`, 실행기는 `scripts/sheet-presentation.mjs`와 `scripts/sheet-presentation-online.mjs`다. upstream GitHub commit `7f6db2ed1c0bf231300854656744a045551b684d`가 게시됐다.

ERP 엔진 구현: `freepass-creator/freepasserp4` PR #461, `6d9375a0d7fcf8e00d41712a3a154c6b1163f032`. 기존 운영 엔진0e0bfb3 위에서만 변경했다. main 앱의 동시 작업은 포함하지 않는다. vendor manifest는 upstream SHA와 파일별 해시를 고정하며, 양쪽 발행기의 결과를 이 저장소 planner로 대조한다.

운영 전환안: PR #462. 기존 `erp5-ssot-refresh.yml`의 pin과 Core receipt revision, 허용 엔진 목록, 예약 지도를 함께 바꾼다. 새 writer나 스케줄은 없다. **PR 미병합 상태에서는 예약 자동화가 새 규격을 유지한다고 말하면 안 된다.**

온라인 실측: GitHub Actions run35576634024와 최신 엔진 run35577132973 둘 다 성공. F01 4탭, F86 20탭에 대해 이름/대수/색/너비/숨김/필터/고정행 차이0. 기본 대수385/59/223/53. 두 실행은 GET 전용이며 원천 최신화나 운영 재발행 성공 증거가 아니다.

검증: data 검사20+기존58, ERP typecheck/check:sync/source registry, publisher-to-planner parity, pin의 source contract/schedules PASS. Cursor 검토에서 F01 필터의 명시적 끝행과 정규화 키 중복 사전 차단을 보완했다. Claude weekly limit/Gemini 계정403은 UNAVAILABLE이다. 사용자 지정 고위험 보조AI2개 조건에 대한 이번 실행 예외 허용을 질문했으며, 응답 전 운영 전환은 하지 않는다.

PR454는 이전 축약 이름/180·320px 규격이므로 최신 정본과 충돌한다. 병합하지 않는다. 검증 전용 `codex/f01-f86-online-readonly-20260921`의 workflow 파일은 단발 GET용으로 운영 main에 병합하지 않는다.


## 2026-09-25 FreePass Data bridge evidence

Current architecture direction supersedes the old ownership assumption above:

- FreePass Data is the SSOT/data-authority owner.
- FreePassERP.com, F01 and F86 are consumers/transports.
- The production writer is **not switched yet**. Existing production remains the last-known-good path until shadow/readback evidence is complete.

Implementation under review:

- FreePass Data PR #48: release binding, Data-owned sheet bridge, manifest/handoff and delivery receipt contracts.
- FreePassERP.com PR #495: consumer adapter that verifies a Data handoff and reuses the existing writer input shape without owning pricing/deposit meaning.

Read-only evidence from successful production publication run `36096321596` / snapshot artifact:

- products: **1,659**
- policy: **81**
- partner: **64**
- inventory: registered **1,659**, unavailable **967**, open **692**
- listable/status-kind/source identity/delete/blank plate/invalid plate/duplicate plate drift: **0**
- Data bridge inventory calculation matches all common production inventory counters.
- products carrying the Sonokong deposit-rule text: **726**
- recomputed `depositRuleViolations`: **0**, matching the production artifact.
- the captured JSON shape showed no DocumentReference/GeoPoint/bytes-like objects. The only special SDK object shape observed was Firestore Timestamp serialization on product metadata:
  - `policy_reference_checked_at`: 887
  - `updated_at`: 143
- the pinned F01/F86 writer source does not reference either timestamp metadata field, so the Data REST bridge's ISO-string representation is treated as a metadata representation difference, not a rendered-output semantic difference.

Current HOLD:

1. run the Data read-only bridge preparation against live Firestore and retain the private evidence,
2. consume that exact handoff through ERP4 shadow mode,
3. prove F01/F86 rendered-output parity,
4. produce valid release-bound delivery/readback receipts,
5. only then consider switching the production writer input source.

Do not interpret `LEGACY_VERIFIED_BRIDGE` as `CANONICAL_ACTIVE`.
