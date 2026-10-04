# 설계 한 장 — 공통 입력시트 → Canonical

**목적:** 공급사가 입력한 차량 한 대의 원문, 정리값, 제공 기간별 대여료·보증금·청구/지급 수수료를 기존 Firestore Canonical 경로에 저장한다. 이번 변경은 로컬 구현이다. 운영 캡처·실행·203대 대사·소비처 전환 증거는 아니다.

| 원천 | 같은 수집 틀 | 이번 범위 |
|---|---|---|
| ERP5 브리지 | 캡처 → `SourceIntakeBatch` → 고정 RAW → 후보·lineage → 검토 → Canonical | 기존 RAW 어댑터 유지. 차량 전체 Canonical 이관은 다음 단계 |
| 공통 입력시트 | 같은 틀, `shared-sheet-source` + `normalize-shared-sheet` | 74칸·15탭·18코드 검증부터 Canonical 저장·되읽기까지 구현. 캡처 수집기 `capture:shared-sheet`(Sheets values.batchGet 한 번 → capture v1, 74칸 채움·빈 행 보존, 비공개 파일만) |

**소유:** `SourceIngestionStore`는 RAW/run/head/후보/lineage, `CatalogStore`는 Canonical 트랜잭션만 맡는다. 물리 이름·문서 ID는 `firestore-layout`, Firebase 대상은 `firebase-target`, head 판정은 `decideSourceHead`를 그대로 쓴다. ERP5와 시트를 동시에 같은 차량의 writer로 켜지 않는다.

**입력·원문:** `SharedSheetCapture`는 schema `shared-sheet-capture/v1`, `spreadsheetId`, 현행 `layoutVersion`, `readTime`, `revision` 또는 검증 가능한 `digest`, `tabs[]`를 가진다. 각 탭은 `title/readTime/complete:true/rowCount/values`; `values[0]`은 정본 머리글, 이후 모든 행은 정확히 74개 JSON scalar/null이다. 캡처기가 뒤쪽 빈 셀을 명시적으로 채워야 한다. 등록 15탭 전체만 받고, top readTime은 탭 중 가장 이른 시각, 탭 간 차이는 최대 30분이다. 원본 내용 digest와 위치·시각·revision은 RAW에 보존한다. 탭+회사명으로 코드, 코드+정규화 번호의 opaque digest로 차량을 식별한다. 중복 identity는 캡처 전체 거부, 회사 불명은 RAW 보존 후 해당 행 HOLD다. RAW/run의 이전 head 연결로 최초 관측을 이어가며, Canonical 자산에도 최초 관측 시각을 보존한다. 사라진 행은 삭제/판매완료로 추정하지 않는다.

**정리값:** 각 값에 `value/state/evidence/ruleVersion/reasons`를 붙인다. 제조사→모델→세부모델→세부트림은 현재 시트 칸을 그대로 사용하고 앞 단계 미정이면 뒤를 비운다. 별칭 추정·F03 신규 생성은 하지 않는다. 차종 공백/확인 필요·순서 위반은 차량 HOLD. 연료 정규값, 배기량 cc, 인승, 구동 2WD/AWD/4WD, 배터리 kWh, 연식 숫자, 최초등록 `YYYY-MM` 또는 `YYYY-MM-DD`, 주행거리 숫자를 저장한다. 74칸에는 변속기 칸이 없으므로 옵션 원문의 명시적 `변속기: 값`만 받고 나머지는 MISSING. 연식과 등록연도 불일치·모호한 값은 확인 필요다. 날짜의 일자는 만들지 않는다. 정리 근거는 내부 `VehicleAsset.sourceVehicleFacts`와 lineage에만 있고 공개 projection에는 추가하지 않는다.

**가격·수수료:** 값이 있는 1/6/12/24/36/48/60개월만 생성한다. 앞 세 기간은 단기보증, 뒤 네 기간은 장기보증이다. 빈칸·`-`·`불가`는 미제공, `무보증`은 명시적 0, 보증 근거 부재는 UNKNOWN. 대여료·보증금 숫자는 공급사 값을 보존한다. 기존 `precomputeOfferEconomics`가 각 기간의 청구/지급을 저장하며 UNKNOWN은 `amount:null`이다. dry-run 대사는 선계산 미리보기이고 apply는 저장된 가격·수수료 전체를 되읽어 대사한다. HOLD 기간은 따로 센다.

**자동 검토 `shared-sheet-auto-review/1`:** 출고가능/즉시출고, 네 차종 단계 확정, 정리 오류 없음, 공급사/상품구분 확정인 행만 CREATE한다. 같은 시트 binding이 있으면 검토 명령의 원천 변경을 사용하고 모든 entity expectedRevision·승인 change ID를 계획에 고정한다. 차종/상품구분/기간 구성 등 기존 검토기가 BLOCKED로 판정하는 변경은 HOLD. 다른 원천에서 같은 공급사+차량이 이미 존재하면 `EXISTING_IDENTITY_REQUIRES_SOURCE_LINK`로 보류하며 중복 CREATE하지 않는다. 동일 원문에 저장 수수료가 다르면 별도 재계산 job 대상이다. 기존에 알려졌던 제원이 원천에서 사라지거나 저장 정리값이 어긋나면 자동 보존/덮어쓰기하지 않고 HOLD한다.

**실행·주기:** 기본 dry-run은 제공한 store에 쓰기 0, 운영 로그도 쓰지 않는다. 선택한 로컬 계획 파일 저장만 별도다. `--apply`는 전체 계획 파일·planDigest·target·규격/정리/수수료 버전 일치, 저장된 EXCLUSIVE writer 소유권과 계획 digest가 필요하다. 소유권 변경은 Canonical 트랜잭션 안에서도 막는다. 동일 계획은 receipt로 멱등 재실행하며 부분 성공은 명시하고 충돌 후 revision을 자동 갱신하지 않는다. **15분 상시 엔진·워크플로는 다음 PR**이며 이 PR은 자동 실행을 추가하지 않는다.

**되돌리기·승인:** 실행 전 운영 정본 백업과 현재 release를 보존한다. 실패 시 job을 중단하고 성공/잔여 집계를 확인한다. RAW·receipt·revision을 삭제하지 않는다. 되돌림은 보존 revision을 검토한 별도 보상 명령으로 진행하고 현재 expectedRevision을 다시 확인한다. 자동 rollback·release 발행은 없다. 대표의 운영 쓰기 승인은 전달됐지만 이번 세션은 파일 수정/검사만 허용되어 실제 쓰기를 하지 않았다. writer 전환·실제 캡처·자격증명/워크플로 설치·향후 스케줄 활성화는 다음 운영 단계에서 대상과 범위를 고정한다.

## 운영 원칙 — 두 갈래 (대표 2026-10-04 최종, AI 상황실 승인)

- **빠른 길:** 대표·세션 지시가 오면 공통 시트에 바로 입력한다. 규칙을 지키고 백업 → 쓰기 → 되읽기 순서로 한다. Firestore를 기다리지 않는다.
- **느린 길(필수):** 하루 한 번(데일리) 공통 시트 전체를 이 job으로 Firestore에 박제한다.
  - 대상: 원문(RAW), 정리값(차종·제원·연식·최초등록일·주행거리, 근거·규칙 버전), 공급사가 값을 준 기간별 대여료·보증금, 청구·지급 수수료(근거 없으면 UNKNOWN, 0 아님)
  - 시트에 손으로 넣은 값도 다음 날 Firestore에 남는다.
  - 그날 바뀐 칸은 「누가(사람/AI 세션)·언제」 이력으로 남긴다. 시트 비고의 「지지오토 정정 MM-DD / 공급사 원문: …」 표기와 세션 정정 기록이 근거다.
- **15분 점검(선택):** 새 차·바뀐 차가 있는지 비교만 하고, 있을 때만 그 차를 적재한다. 매번 전체를 다시 계산하지 않는다.
- 첫 적재는 공통 시트 203대, 그다음이 ERP5 1,760대다.
- 완료 판정: 차량번호로 Firestore를 조회했을 때 「공급사가 준 기간 수 = 수수료가 붙은 기간 수」인지 실제로 확인한다(`query-canonical-by-plate`).
- 이 설계는 AI 상황실이 2026-10-04에 승인했다. 승인 지점 4개(RAW 쓰기·시트 3칸 되쓰기·스케줄·Canonical writer)는 단계마다 dry-run 숫자와 Codex OK를 AI 상황실에 올려 승인받는다.
- 한계 두 개: ① 주기 조회는 조회 시점의 상태만 보존한다. ② 사람 직접 편집과의 경합은 쓰기 직전 재조회·fingerprint 비교·사람 값 잠금으로 줄이고, 남는 충돌은 표시만 한다.

## 운영 apply 준비와 실행 입구

1. 운영 `catalog` writer ownership을 읽어 확인한다. 이 job의 필수 상태는 **저장된 `mode: EXCLUSIVE`, `primaryWriterId: service:freepass-data`**이며 revision 포함 문서 전체 digest가 계획과 같아야 한다. 누락/기본 SHARED_MIGRATION은 불가. 필요하면 기존 `transferCatalogWriterOwnership` 명령에 현재 expectedRevision을 넣어 이전 writer 정지 후 전환한다. 이 job은 소유권을 바꾸지 않는다. 이번 작업은 운영 상태를 조회하지 않았다.
2. 중앙 대상 `FIREBASE_PROJECT_ID=freepasserp5`, 운영 `NODE_ENV=production`, emulator 없음. 기존 ADC 또는 워크플로 OIDC 서비스 계정에 대상 Firestore의 RAW/run/head/후보/lineage 및 Canonical/receipt/revision/audit/outbox를 읽고 쓸 권한이 필요하다. 조회 job은 읽기 권한만 필요하다. 키 파일·토큰은 저장소/출력에 넣지 않는다. 새로운 Firebase 앱·RTDB·시트 쓰기 권한은 필요 없다.
3. 외부 비공개 디렉터리에 캡처 JSON, 계획, 백업, 조회 입력/결과를 둔다. 계획에는 RAW/정리값이 있으므로 **공개 PR·Actions artifact·로그에 올리지 않는다.** Windows에서는 해당 디렉터리 ACL도 운영자 전용인지 확인한다. 출력 파일은 저장소 밖 절대 경로만 허용하고 기존 파일을 덮어쓰지 않는다.
4. 최초에는 명시적 수동 실행만 사용한다. 현 코드 revision과 15탭 캡처를 고정하고 전체 dry-run 집계/HOLD/기간 대사를 검토한 뒤 **그 계획**으로 apply한다. 원천 수집·워크플로 운용·15분 주기는 아직 연결하지 않았다.

```powershell
# 아래는 다음 운영 단계의 실행 예시이며 이번 세션에서는 실행하지 않았다.
npm run ingest:shared-sheet-canonical -- --memory --capture <비공개-캡처-절대경로>
npm run ingest:shared-sheet-canonical -- --firestore --capture <비공개-캡처-절대경로> --plan-out <비공개-계획-절대경로>
npm run ingest:shared-sheet-canonical -- --firestore --apply --plan <비공개-계획-절대경로> --expected-plan-digest <검토한-digest>
npm run query:canonical-by-plate -- --firestore --plate-file <운영자-번호파일-절대경로> --local-output <비공개-조회결과-절대경로>
```

`--memory` CLI는 빈 로컬 Catalog의 계획 전용이며 운영 기존 자료와 대조한 계획이 아니다. 운영 apply 계획은 `--firestore`로 새로 만든다. 조회 결과는 파일에만 쓰고 stdout에는 일치 대수만 출력한다. 수수료·원문·차량번호는 로그/시험/이 문서에 넣지 않는다. FAILED 상태로 중단된 RAW run은 임의 삭제/덮어쓰기로 재개하지 않고 새 캡처로 복구 여부를 검토한다.

## 검증·남음

- 기준: `work/freepass-data/sheet-to-canonical-20261004`, `515845dd4a8a113f1c1a908be73b928cd1003338`. 로컬 origin/main 이력에서 #296/#302/#303 포함 확인. 원격 조회·git 쓰기 없음.
- 신규 파일은 기존 `ingestRawSourceBatch`/Canonical 명령/recompute 계획 패턴에 대한 `COMPOSE_OR_EXTEND`; Academy READY 확인. 새로운 저장소·저장 경로 없음.
- 실제 203대/ERP5 전체 원문 미열람. 운영 저장·소비처 연결·배포·주기 실행은 미검증. Claude 독립 검토는 네트워크 금지로 UNAVAILABLE이며 PASS가 아니다.
- 검사 결과와 다음 시작점은 `NEXT-START-HERE.md`의 이번 기록을 따른다.

## 변경 파일과 주요 줄

| 파일 | 주요 줄 | 변경 |
|---|---:|---|
| `src/adapters/shared-sheet-source.ts` | 5, 22 | 캡처 형식·15탭/74칸·코드/identity·digest 검증 |
| `src/adapters/normalize-shared-sheet.ts` | 35 | 순수 정리·가격/보증·확인 필요·후보/lineage |
| `src/application/ingest-raw-source.ts` | 41, 54 | 공통 준비 함수·RAW 뒤 후보/lineage·최초 관측 이력 |
| `src/application/canonicalize-catalog-candidate.ts` | 35, 406, 584 | 소유권 digest·정리값/최초 시각 Canonical 저장 |
| `src/application/reviewed-source-change.ts` | 558, 850, 1001 | 정리값 원천 변경 검토·lineage·소유권 재확인 |
| `src/jobs/ingest-shared-sheet-canonical.ts` | 55, 158, 243 | 계획·집계·apply·멱등/되읽기·CLI |
| `src/jobs/query-canonical-by-plate.ts` | 9, 33 | 읽기 전용 실물 조회와 비공개 파일 출력 |
| `src/jobs/data-access-runtime.ts` | 63 | 기존 gateway 조립 경로·읽기 포트 쓰기 차단 |
| `src/domain/source-vehicle-facts.ts` | 1 | 정리값/근거/규칙 버전 타입 |
| `src/domain/catalog-candidate.ts` | 5 | 후보 정리값·최초 시각 |
| `src/domain/catalog.ts` | 19 | 자산 내부 정리값·최초 시각 |
| `src/domain/source.ts` | 40, 112 | run 이전 head·RAW 최초 관측 |
| `src/domain/source-change.ts` | 58 | 계획 소유권 digest 타입 |
| `src/domain/authority.ts` | 190 | 정리값 reviewed-source-change 권한 |
| `contracts/catalog-v1.schema.json` | 84, 107 | 내부 정리값·최초 관측 schema |
| `package.json` | 48 | 두 job 실행 명령 |
| `tests/shared-sheet-canonical.test.ts` | 58 | 가짜 값 시험 30개 |
| `docs/NEXT-START-HERE.md` | 378 | revision·검사·HOLD·다음 시작점 |
| `docs/SHARED-SHEET-CANONICAL-DESIGN.md` | 1 | PR 상단용 설계·운영 절차·변경 목록 |

## 캡처 수집기 (2026-10-04)

- `npm run capture:shared-sheet -- --spreadsheet <ID> --out <비공개-절대경로>` — Sheets 읽기 전용 토큰(`GOOGLE_SHEETS_APPLICATION_CREDENTIALS` 파일이 있으면 그것, 없으면 ADC). stdout 은 탭 수·레코드 수·digest 만.
- 로컬 확인용 `--from-batchget <gws batchGet JSON> --read-time <ISO>` 도 같은 검증을 거친다.
- 숫자 없는 차량번호(「신차」「미정」 등)는 차량 식별자로 쓰지 않는다. RAW 는 위치로 보존하고 정리 단계에서 `PLATE_NOT_ASSIGNED` HOLD.

## 차종 4칸: «Data 정리값 먼저 → F03 → 원문과 모순 없을 때만» (2026-10-04)

- 흐름(대표 확정): 공급사 원문 → FreePass Data 정리값(F03 이름) → 공통 시트 차종 칸은 Data 값을 되써 준다. 공통 시트를 손으로 먼저 고치는 것은 «바로 넣어» 지시 때만.
- 입력: `npm run build:vehicle-identity-inputs -- --erp5-capture <inspect-erp5-source 캡처> [--f03-batchget <F03 batchGet JSON> --f03-read-time <ISO>] --out <비공개 경로>` — F03 본표(「통합→」 행 제외)·별칭 탭 + 차량번호별 기존 Data 4칸(같은 번호에 값이 엇갈리면 Data 없음 처리).
- 적재: `ingest:shared-sheet-canonical -- --capture … --identity-inputs <위 파일>`. 계획에 입력이 통째로 들어가고(digest 검사) apply 는 같은 입력으로 다시 계산한다.
- 규칙(`src/domain/vehicle-identity-resolution.ts`): Data 4칸을 별칭·기본형 규칙으로 F03 이름으로 바꾼다 → F03 행이 아니면 시트. 다음이면 Data 를 쓰지 않는다: 최초등록(없으면 연식)이 F03 생산기간 밖(시작 1개월 전·종료 18개월 뒤까지 허용), 원문에 하이브리드/전기 표시가 있는데 이름에 없음(그 모델에 그런 행이 있을 때)·그 반대, 세부모델의 고유 낱말이 원문에 없음, 시트 값이 원문과 더 잘 맞음(「더 뉴」 등 생략은 감점 안 함). 원문은 Data 쪽이 더 맞는데 생산기간과 어긋나면 HOLD(`VEHICLE_IDENTITY_DATA_CONFLICT`). 둘 다 F03 행이 아니면 HOLD.
- 기록: `sourceVehicleFacts.vehicleIdentitySource` = FREEPASS_DATA / SHEET(근거: 시트 4칸·Data 4칸·판단 메모). 시트 칸 원문은 evidence 로 그대로 남는다.
- 검증: 10-04 시트↔Data 대조 99줄의 수동 판정과 99/99 일치(규칙을 이 판정에 맞춰 다듬었으므로 독립 검증은 아니다).
