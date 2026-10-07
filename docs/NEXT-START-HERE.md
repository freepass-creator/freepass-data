# FreePass Data — NEXT START HERE

## 2026-10-05 공통 시트 빈 칸 채우기 읽기 어댑터

- 목적: 기존 빈 칸 채우기 계획기의 입력 JSON을 공통 시트 + FreePass Data products/policy에서 읽기 전용으로 만든다. 시트·Firestore 쓰기 0, 커밋·push 없음.
- 대상 revision: `work/freepass-data/sheet-blank-fill-adapter-20261005` `106d565c788e8ef39cf8b136951eb8e55f069913` 기반.
- 변경: `src/application/sheet-blank-fill-input.ts`, `src/jobs/export-sheet-blank-fill-input.ts`, reader FORMULA 옵션, `export:sheet-blank-fill-input`, 가상 데이터 테스트 8개, `docs/SHEET-BLANK-FILL.md`.
- 검증: `npm.cmd run build` PASS, `npx.cmd vitest run tests/sheet-blank-fill-input.test.ts` PASS. 네트워크 금지로 실제 Sheets/Firestore 읽기와 push는 실행하지 않음(BLOCKED_NETWORK).
- next_start_here: 비공개 환경에서 export → plan → 줄확인 지원 시트고치기(ai-ops#62 이상)로 dry-run, 처음 2주는 사람이 `report.json`/줄확인을 확인. products 확정 기준은 `확정 === true` 그리고 `검수상태 === "확정"` 둘 다(하나라도 아니면 confirmed false).

## 2026-10-05 Iancar policy sync transaction hardening

- RP031 policy sync intentionally refuses missing policy documents: `RP031_S01`~`RP031_S04` must already exist, and the sync updates those documents instead of recreating the old `set(merge)` implicit-create path.

## 2026-10-04 Vehicle Master 직접 정본 전환

- 대표 결정: 차종마스터는 FreePass Data 안에서 직접 관리한다. 새 수집·정규화 경로는 F03을 읽거나 갱신하지 않는다.
- 신규 경로: `freepass-vehicle-reference/v1` → immutable RAW archive → `VEHICLE_REFERENCE_MODEL` normalized evidence → 기존 Vehicle Master canonical 승격 규칙.
- 내부 명칭은 `vehicle-reference` / `FreePass Vehicle Reference`로 통일하고 외부 사업자명은 브랜치·폴더·job·스키마 명칭에 넣지 않는다.
- 외부 원천 식별은 감사에 필요한 최소 정보만 opaque reference digest로 보존한다. 실제 원천의 이용권한·라이선스 확인 전 공개 웹사이트 전수 복제는 하지 않는다.
- 실행: **막힘(2026-10-04)** — `npm run ingest:vehicle-reference` 는 어떤 환경 변수로도 쓰지 않고 `VEHICLE_REFERENCE_IMPORT_BLOCKED` 로 끝난다(아래 «차종 레퍼런스 적재 실행기 막음»). 이 경로로 적재하지 않는다.
- next_start_here: 레퍼런스 데이터셋을 기존 차종 마스터 적재 경로(시험 실행 → 계획 digest 승인 → 쓰기 주인 검사·access.write → 되읽기)의 한 원천으로 합친 뒤에만 전량 적재·승격을 이어간다.


## 2026-10-04 F03 차종마스터 운영 규칙 고정

- 목적: 10-03~04 대표 결정(엔카 기준 4단계, 기아만 개발명, 제조사 엔카 표기, 별칭 탭, 불변 ID, 신규 행 추가 절차, 직접 쓰기 금지 예외)을 휘발되지 않게 정본 문서에 고정한다.
- 정본: `docs/ERP-COM-GOOGLE-SHEETS-SSOT.md` F03 절 「F03 차종마스터 운영 규칙」.
- F03 현재(되읽기): 1,678행, 제조사 17(엔카 표기), 세부모델 263, 원자ID 1,678/1,678·중복 0, `별칭` 탭 52행(조건 27, 확인 필요 1).
- 남음: 「확인 필요」 — 벤츠 「200」(확인 동선 C1004-0a2f64f8), 봉고 세부모델, 셀토스 2세대 개발명, 더 뉴 아반떼 CN8.
- next_start_here: F03에 없는 차가 공급사·공동 시트에 나오면 위 절의 「신규 행 추가 절차」대로.

## 2026-10-03 F03 엔카 정합 1회 정정 / 제조사 별칭

- 목적: 대표 오더 「차종 마스터를 엔카와 똑같이(제조사→모델→세부모델→세부트림, 기아만 개발명)」. 범위는 우리 취급 차종 + 공급사·공동 시트에 새 차가 나오면 그 차만 엔카 공개 화면으로 확인해 추가(엔카 API는 robots 전체 Disallow라 통째 수집 안 함).
- F03 반영(되읽기 확인, 의도 밖 칸 변경 0): 1,668→1,676행, 제조사 16→17·모델 114→118·세부모델 256→261. 상세와 기록 위치는 `docs/ERP-COM-GOOGLE-SHEETS-SSOT.md` F03 절.
- 이 PR: `canonicalVehicleMakerName`(옛 F03 제조사 이름 → 엔카 표기 별칭)을 차종 이름 대조(`vehicle-master-reference-parity`) 키에 적용. F03 제조사 이름을 엔카 표기로 바꿔도 옛 이름의 마스터·상품이 대조 범위 밖으로 빠지지 않는다. `포터 Ⅱ`는 기존 NFKC 정규화로 `포터 II`와 같다.
- 남음: 이 PR 머지 뒤 F03 제조사 이름 변경(공동 시트 드롭다운은 급한 작업 세션과 같은 날). 벤츠 「200」(공동 시트 원문으로 차종 특정 불가)·봉고(F03 생산기간 보류로 엔카 화물 세부모델 특정 불가)는 공급사·사람 확인. 셀토스 2세대 기아 개발명은 공식 보도자료에 없어 F03에 「개발명 확인 필요」 표시.

## 2026-10-03 고도화 전 정리 — 묶음 PR 안내

- 아래 네 항목(PR1a·PR1b·②·④)은 모두 이 문서와 일부 같은 소스 경로를 고쳐 따로 올리면 경로 경합으로 막히므로 main `7dbee2f` 위 한 PR(`claude/data-cleanup-bundle`)로 묶었다. 각 항목의 "대상 revision"은 처음 작업한 기준이며, 묶을 때 main의 새 아이카·아이언 어댑터(`supplier-source-capture.ts`)와 import 충돌만 해소했다. 묶은 뒤 `npm run check` PASS.
- F01 공급사 기준 개편 설계(`claude/f01-supplier-layout`)는 대표가 구성을 다시 정하는 중(구독사만 별도 탭, 이안카와 공동 시트 공급사는 합본 탭, 탭 이름 미정)이라 이 묶음에 넣지 않았다. F86은 공급사 공동 입력 시트이므로 Data 발행 대상이 아니다.

## 2026-10-03 고도화 전 정리 — 정책 연결·주행거리 해석(④, ERP5 매퍼 v5)

- 목적: 2026-09-30 감사에서 원인 후보로 남긴 정책 연결·주행거리 해석 한계를 매퍼/리더에서 고친다. 운영 쓰기 없음 — ERP5 매핑은 dry-run·감사 전용(HOLD)이며, 기록된 435/208/116/1,421은 오류 대수로 확정하지 않는다.
- 대상 revision: main `e49dfb9`(독립 브랜치 `claude/policy-link-mileage`).
- 변경(Codex 설계 상의 반영):
  - 정책 문서 디코드가 최상위 `updated_at` timestamp를 상품과 같은 metadata 문자열로 무손실 허용한다(`POLICY_METADATA_TIMESTAMP_FIELDS`). 허용 목록 밖(`created_at` 등 — 증거 없음, HOLD)이나 중첩 map 안 timestamp는 기존처럼 문서 skip·사유 집계.
  - `annual_mileage` 문자열 해석 `parseAnnualMileageText`: `30000`·`30,000km`·`연 30,000km`·`연간 3만km`·`3만키로` 허용(만 단위는 km 계열 단위 필수, 앞자리 0 불가), `3만`·`월`·`무제한`·범위/복수·0/음수·소수·`원`/`회` 등 기타는 미해석으로 남기고 사유를 `uninterpretedAnnualMileageReasons`에, 해석 건수를 `factsWithAnnualMileageParsedFromText`에 센다. B-2(가격 키에 주행거리가 없을 때의 의미)와는 별개 결정이다.
  - 정책 선택을 `selectErp5Policy` 하나로 모아 연결 판정과 주행거리 해석(`resolveErp5Mileage`)이 같이 쓴다. 같은 code 안에서 자기 회사 정책이 먼저이고, 회사 미기재 정책은 자기 회사 정책이 없을 때만 후보다(문서 순서와 무관). 같은 code가 모두 다른 회사면 `POLICY_LINK_COMPANY_MISMATCH`, 후보가 둘 이상이면 신설 `POLICY_LINK_AMBIGUOUS`이며 이때 정책 주행거리를 고르지 않는다(이전에는 첫 문서를 썼다).
  - `ERP5_PRODUCT_MAPPER_VERSION` `erp5-product-mapping/4` → `/5`(issue code 표면 변경).
- 의도된 기대값 변화: `updated_at`만 있는 정책은 이제 fact가 되고(skip 0), `연 30,000km`는 30000으로 읽힌다. 다음 감사 실행에서 `POLICY_LINK_NOT_FOUND`·`MILEAGE_FROM_COMPANY_DEFAULT`·정책 skip 수가 줄 수 있으며 이는 해석기 변경 효과다 — 이전 수치와 단순 비교하지 않는다.
- 검증: ERP5 테스트 165 PASS(신규: metadata 허용·허용 밖/중첩 skip, 텍스트 해석 허용 8·거부 15종, 동일 code 다회사 자기 회사 연결, 회사 미기재보다 자기 회사 우선(순서 무관), 모호 시 정책 주행거리 미사용, 동일 회사 중복 AMBIGUOUS). 선택 우선순위를 옛 방식으로 되돌리면 테스트가 실패함을 확인 후 원복. Codex 구현 검토 지적(회사 미기재 우선순위, 단위 없는 만, 문서 ID 대체 설명) 반영, `npm run check` PASS.
- 남음: 실제 캡처로 재감사해 새 수치를 기록(읽기 전용 Actions, 별도 실행). `policy_code`가 없는 정책 문서의 문서 ID 대체(`factsUsingDocumentIdAsPolicyCode`)와 `companyId`/`provider_company_code` 이중 필드는 그대로다.
- next_start_here: 다음 ERP5 continuous audit 결과에서 `policyFactCoverage`의 새 카운터와 issue 분포를 읽고 BUSINESS-DATA-CONNECTION-MAP 감사 절을 갱신한다.

## 2026-10-03 고도화 전 정리 — 차량번호 키·ERP5 재고 상태 사전 공통화(②, iancar 제외)

- 목적: 같은 차·같은 상태를 어댑터마다 다르게 판정하던 중복을 한 곳으로 모은다. 대표 결정으로 Codex worktree가 미커밋 수정 중인 iancar 파일은 이번에 건드리지 않는다.
- 대상 revision: main `e49dfb9`(PR1a/PR1b와 독립 브랜치 `claude/plate-status-dictionary`).
- 변경: `src/domain/vehicle-plate.ts` — `plateIdentityKey`(trim·공백 제거·대문자, 비문자열은 ''), `isStrictKoreanPlate`(매퍼 기존 정규식), `firestoreSafePlateKey`(시트 키 전용, `. $ # [ ] / -` 제거 — 동일 차량 판정에 쓰지 않는다). `src/domain/erp5-inventory-status.ts` — ERP5 `vehicle_status`→`status_kind`·`listable` 사전과 `resolveErp5InventoryStatus`. 사용처: `erp5-product-mapping`(사전·형식), `erp5-source-capture`(중복 차량번호), `supplier-source-capture`(sonogong/welrix identity), `sheet-publication-bridge`(사전·안전 키). bridge의 drift 계산은 기존 운영 증거와 비교 가능하도록 빈 상태=준비, 미검토 상태=불가 fallback을 `legacyExpectedStatusKindForDrift`로 명시 보존했다.
- Codex 설계 상의(read-only): 하이픈 제거를 identity에 넣으면 `12가-3456`과 `12가3456`이 합쳐지는 반례 → 안전 키와 분리. 매퍼 strict 형식과 consumer 렌트번호 판정(공백 허용, `consumer-output-contract.ts:43-47`)은 정책이 달라 렌트번호 판정은 그대로 둔다. Canonical `VehicleAssetStatus`에 `UNAVAILABLE`/`WITHDRAWN` 추가는 공개 스키마 3종(`catalog-v1`·`erp-public-view-v1`·`admin-catalog-view-v1`)과 `read-pilot` 허용 목록을 바꾸는 계약 변경이라 HOLD — 내부 우선 도입은 source/display 전용 필드로 두고 projection에서 기존 enum으로 매핑하는 길만 열어 둔다.
- 의도된 동작 변경 1건: ERP5 원문 감사의 중복 차량번호 수는 이제 대문자를 같게 본다(`ab12`·`AB12`가 중복 1). 유효 한글 차량번호에는 영향이 없고 영문이 섞인 비정상 번호에서만 수치가 달라질 수 있다(Codex 구현 검토 지적, identity 설계상 수용).
- 검증: 신규 테스트(사전 전체 값·미검토/상속 키, identity·strict·안전 키, bridge drift fallback 불변)와 기존 ERP5·bridge·sheet 테스트 PASS, `npm run check` PASS. 운영 변경 없음.
- 남음: iancar 쪽 plate 정규화 5곳과 하드코딩 상태(`iancar-one-api.ts:373·432·488-490·518·545·681`, `iancar-direct-source.ts:15·168`, `iancar-policy-sync-firestore.ts:10`, `iancar-publication-withdrawal-firestore.ts:151·222`)는 Codex worktree 정리 후 같은 모듈로 옮긴다. Kakao `점검중→MAINTENANCE` 등 소비처 상태 매핑은 별도.
- next_start_here: iancar 이관은 `commission-audience`·`period-economics-main` 미커밋 변경이 main에 들어간 뒤 시작한다.

## 2026-10-03 고도화 전 정리 — Admin workflow 교체쓰기 필드 보존(PR1b)

- 목적: PR1a에서 HOLD로 남긴 Data gateway `admin-workflow/commit`의 merge 없는 `set`(문서 전체 교체)이 저장된 계약·정산·전자서명 필드를 지우지 못하게 한다.
- 대상 revision: PR1a 브랜치 `claude/data-preservation-guard-pr1a` `c76fc73` 위(main `e49dfb9` 기준).
- 설계 근거: freepass-admin origin/main의 Data gateway shim(`src/adapters/freepass-data/admin-workflow-firestore.ts:143-146`)이 `docRef.set`을 gateway set으로 보내며, 런타임 merge:false set은 5곳 — `esign-repository.ts:257`(revoked)·`:304`(cancel repair)·`:362`(contract_cancelled)·`:442`(approved, `clean()`으로 undefined 제거) 결정적 ID 이벤트와 `settlement-repository.ts:454`(청구서 재발행, `{...existing, …, history}`). 같은 명령 안에서 교체 set과 같은 문서의 다른 mutation이 함께 오는 흐름은 Codex 대조에서 없었다. 그래서 교체 차단이나 "부재 기대 필수"는 청구서 재발행을 깨므로 채택하지 않았다. Codex 설계 상의(read-only)로 최소안을 확정했다.
- 변경: 교체 set 대상 문서를 트랜잭션 쓰기 전에 모두 읽고, 문서가 있으면 저장된 최상위 필드가 새 data에 모두 있어야 한다(값 변경 허용, 필드 제거 거부 → `ADMIN_WORKFLOW_REPLACEMENT_DROPS_FIELDS` 409, `resource`·`droppedFields` 포함, 명령 전체 미기록). 교체 set은 같은 명령에서 그 문서의 유일한 mutation이어야 한다(`INVALID_ADMIN_WORKFLOW_REPLACEMENT_NOT_EXCLUSIVE` 400). receipt 스키마는 바꾸지 않았다.
- 검증: 단위·gateway 테스트 7건 — 청구서 재발행 spread+history 통과, 이벤트 재실행·신규 문서 통과, JSON 전송에서 `undefined`로 빠진 필드 거부, 비배타 교체 400, 409 응답 형태. 거부 분기를 제거하면 테스트가 실패하는 것을 확인 후 원복. `npm run check` PASS. 운영 배포·쓰기 없음.
- 운영 영향(HOLD, 배포 승인 필요): Admin runtime write는 `FREEPASS_DATA_ADMIN_WORKFLOW_WRITE=on` 경로라 배포 즉시 적용된다. 기존 이벤트·청구서에 구버전/수동 추가 최상위 필드가 있거나 Admin이 값을 `undefined`로 보내면 재실행·재발행이 409가 된다 — 배포 전 Admin 담당과 대조한다.
- 남음: 중첩 map 키 제거(`detail`·`snapshot` 통째 교체)와 `update`로 map 통째 교체는 검사하지 않는다(HOLD). 교체 전 값의 보존(revision)은 별도 설계다.
- next_start_here: PR1c(iancar restore `FieldValue.delete` 축소)는 Codex `period-economics-main` worktree 정리 후, 그다음 상태 사전·plate key 통일.

## 2026-10-03 고도화 전 정리 — 삭제 금지 원칙 정적 검사(PR1a)

- 목적/결정: 대표 지시 "원본은 보존하고 삭제하지 않는다. 출고불가 같은 상태 전환으로 처리한다"를 코드로 강제한다. Claude 3갈래 읽기 전용 감사(어댑터·삭제 경로·꼬인 데이터) 후 Codex(`gpt-5.5`, read-only) 2회 상의로 순서를 합의했다: ① 쓰기 보존 guard(PR1a 정적 검사+autoplus retire, PR1b admin-workflow 교체쓰기 정책, PR1c iancar restore field delete 축소) → ② 상태 사전·plate key 통일(`UNAVAILABLE`/`WITHDRAWN`) → ③ RP031 sourceId 단일화 → 소비처 발행 경로·ACTIVE release → 공급사 어댑터 순차 확장. 2026-10-03 대표 결정: F86은 이제 공급사 공통 입력 시트이므로 Data가 발행 대상으로 쓰지 않는다. 시트 관리 틀을 바꾸는 중이라(공급사 입력 PR #281→#282→#283) 시트 쪽 발행 설계는 그 틀이 확정된 뒤 다시 잡는다.
- 대상 revision: main `e49dfb9afa6d8203ed3bf388525179f122aed007`.
- 변경: `scripts/check-data-access-boundary.mjs`가 `src/`의 `FieldValue.delete()`와 firebase-admin 파일의 merge 없는 `set()`을 호출 단위 allowlist로 막는다. set은 `receiver.set(대상 문서)`, field delete는 해당 줄이 식별자이며 미등록·대상 변경·사라진 항목은 실패한다. `tx/batch.set(ref, …)`과 `db.collection(…).doc(…).set(…)` 직접 쓰기를 모두 본다. 주석·문자열과 휴리스틱으로 판정한 정규식 리터럴은 무시하고, `{ merge: true }`는 마지막 인자일 때만 인정하며, `FieldValue`를 `.메서드` 외 형태(별칭 import, 변수 대입, 구조분해)나 `deleteField`로 쓰면 실패한다. autoplus 정책 보정은 run `2026-09-29T04-44-30-502Z-42019aec-...` 적용 완료로 retire — npm job 입구에서 runtime 생성(Firebase 대상 해석·gateway STARTED audit) 전에, 직접 호출 시에도 Firebase 접근 전에 `AUTOPLUS_POLICY_REPAIR_RETIRED`로 거부한다.
- 검증: `npm run check` PASS. 반례 11종(같은 파일 내 대상 바꿔치기, 주석·문자열 언급, 데이터 객체 안 `merge:true`, 정상 merge 옵션, 별칭 import, 변수 대입 별칭, 비 Firestore 파일의 field delete, 직접 DocumentReference set과 그 merge, `return /["]/` 뒤 set, 따옴표 포함 정규식 뒤 set)을 주입해 기대 판정 확인 후 원복. Codex 구현 검토 2회의 수정 지적(job 입구 순서, 파일별 개수 우회, firestore-store 사유 과신, 직접 ref set 미탐, 대입 별칭, 키워드 뒤 정규식)을 반영했다. 운영 DB·시트·배포·IAM 변경 없음.
- 합의된 판정(Claude·Codex): 공급사 어댑터는 등록 4 / `SupplierSourceAdapter` 규격 구현 2(sonogong·welrix); `data-owned-refresh` hourly는 frozen ERP4 엔진 래퍼이며 Data-native 어댑터 스케줄은 0, execute 성공 run 증거는 미확인; iancar publication은 hosted/production에서 GCS 백업 강제. 정책 435/208/116, 주행거리 1,421, 정산 472 미연결은 오류 대수로 확정하지 않는다.
- 남음: PR1b — admin-workflow merge=false set은 원문 before-image 복제 대신 digest·exists·updateTime receipt와 "exists=false 기대 또는 명시적 교체 권한" 조건(`esign_private` 개인정보 이중 보존 금지, 새 컬렉션은 운영 승인). freepass-admin 런타임은 merge:true만 확인됨. PR1c — iancar restore `FieldValue.delete`는 Codex `period-economics-main` worktree가 같은 파일을 미커밋 수정 중이라 대기. `firestore-store`의 vehicleAsset·offer·sourceBinding 교체 set은 revision/audit를 호출자가 붙일 뿐 store가 강제하지 않는다. 정적 검사는 정규식 기반이라 동적 호출(`obj['set']`)·update()로 전체 필드 덮어쓰기·Sheets clear는 잡지 않는다.
- next_start_here: PR1b 설계를 `src/domain/admin-workflow.ts`·`src/infra/admin-workflow-firestore.ts`·`contracts/admin-workflow-receipt-v2.schema.json`에서 시작하고 allowlist 항목을 하나씩 줄인다.

## 2026-10-03 공동 시트 영업자 보기 순서 정리 — 현재 정본 75칸

- 목적(대표): 대여료 앞 = 어떤 차인지 아는 최소 필수 정보, 대여료 뒤 = 부가 정보 중요한 순. 배차상태(차량상태와 같음)·사진링크·기타기간 제거, 입고일자는 차량상태 앞, 차종크기는 차종구분 앞.
- 변경: 규격 `2026-10-03-sales`(75칸, 80칸 legacy), `layoutChange`, `planLayoutChange`/CLI `--change-layout`(차량번호 사진 링크 → 오른쪽부터 삭제 → 이동 → 헤더 → 종합 수식 후 남는 칸 삭제, 셀 값 재작성 없음, 이미 같은 주소 HYPERLINK인 번호는 건너뜀). 테스트27 PASS, Codex 코드 GO(적용 순서 보장 요구 → 적용 절차 반영).
- 적용(이 세션 gws 직접): 첫 시도는 마음카 차량번호 HYPERLINK 수식에서 계획기 HOLD(쓰기0, 백업 사본 1개만 생김). 규칙 보완 후 백업 사본 → 공급사 19탭 원자 batchUpdate → 헤더 재조회 일치 → 종합. 요청 661, 차량번호 링크 107(+마음카 기존 HYPERLINK 3).
- 확인(gws 읽기 전용): `LAYOUT_VERIFIED`(75칸), 남은 52,200칸 백업과 불일치0, 사진 링크 110/110 원래 주소, 종합 206/210행·오류0·75칸.
- 다음: 차종 마스터(F03 1oMB9e…, 제조사16→모델114→세부모델256→세부트림936) 연동 드롭다운. 대표 새 규칙(10-03)에 따라 구현은 Codex에 오더하고 Claude는 확인·취합.

## 2026-10-03 공동 시트 제원 6칸 추가 — 인승·차종구분·차종크기·구동방식·배터리용량·원산지

- 목적(대표): 차량가격 뒤에 나머지 제원 칸. 값은 예전 값 복원(대표 선택).
- 변경: 규격 `2026-10-03-spec`(80칸, 74칸 legacy), `columnAdd`, 드롭다운 5칸, `planColumnAdd`/CLI `--add-columns`(새 칸만 쓰기, 중복 행·범위 밖·다른 칸 HOLD, 목록 값은 목록 문자열, 숫자/문자 서식 분리). 테스트26 PASS, Codex NO-GO 3건 반영 후 GO.
- 적용(이 세션 gws 직접): 백업 사본 `[복구용 원본] … — 2026-10-03 제원 칸 추가 전`(ID는 private evidence) → 첫 백업(10-02 양식)과 공급사 탭·차량번호 1:1 매칭 202/206(렌트존 4대는 예전 번호 중복으로 비움), 값 있는 200행 → 탭별 원자 batchUpdate 20회(요청 581).
- 확인(gws 읽기 전용): `LAYOUT_VERIFIED`(80칸), 기존 51,504칸 불일치0, 새 칸 962칸 기대값 일치, 종합 206행·오류0·80칸, 드롭다운 규격 일치.
- 남음: 렌트존 4대 제원 공급사 입력, 인승 `5인승` 1건 확인, 배차상태 목록 대표 확정 대기.

## 2026-10-03 공동 시트 칸 순서 재배치 — 배차상태·모델·세부트림

- 목적(대표): 공동 시트 칸 순서를 회사명→차량상태→배차상태→상품구분→차량번호→제조사→모델→세부모델→세부트림→(색상·등록일·입고일·사진·기타기간)→연식→주행거리→배기량→연료→대여료→차명 원문→옵션 원문→차량가격→예외사항→정책으로. F86 이관은 대표 지시로 보류(공동 시트를 대표가 더 본다).
- 변경: 규격 `2026-10-03-order`(74칸, 71칸은 legacy), `layoutReorder`(세부모델→모델·옵션→옵션 원문 이름 변경, 새 칸 3개), `planLayoutReorder`/CLI `--reorder`, `planPolicySplit`은 자기 목표 양식 기준. 테스트25 PASS, Codex 검토 GO.
- 실제 적용(이 세션이 gws로 직접): 백업 사본 `[복구용 원본] … — 2026-10-03 칸 순서 변경 전`(같은 폴더, 공유 변경 없음, ID는 private evidence). 다시 읽은 계획이 검토한 계획과 동일(610건) 확인 후, 명령줄 길이 한도 때문에 탭별 원자 batchUpdate 20회(공급사 19 → 종합). gws `auth export`로 토큰을 꺼내는 길은 쓰지 않음.
- 확인(gws 읽기 전용): 계획기 검증 `LAYOUT_VERIFIED`(74칸, drift 0), 백업 대비 49,416칸 값 불일치 0, 새 칸 3개 비어 있음, 종합 206/210행·오류0·74칸, 드롭다운 74칸 규격 일치.
- 남음/HOLD: 배차상태 드롭다운 목록(대표 확정 대기). F86 이관 보류.

## 2026-10-03 공동 시트 한 번 세팅 — 정책 칸 분리(한 칸에 정보 하나) + 드롭다운

- 목적(대표): 공동 시트는 한 번만 세팅하고 앞으로 공급사가 직접 입력한다. 정책은 타이핑 대신 미리 만든 드롭다운에서 고른다. 한 칸에는 정보 하나만(대인한도/대인면책 식), 자차면책은 범위 그대로 한 칸.
- 근거: 공동 시트 19개 탭의 정책·분류 칸 실제 값(차량 206대)을 Codex 커넥터 읽기 전용으로 칸별 집계. 26가지 결합 값 모양이 모두 분리 규칙에 맞음을 확인.
- 변경: 규격 `layoutVersion:"2026-10-03-split"`(정책 41칸·전체 71칸, 62칸 양식은 legacy), `policySplit`, `dropdowns` 37칸, `dropdownPolicy`. 실행기 `splitPolicyValue`/`planPolicySplit`(정해진 모양만 분리, 하나라도 다르면 전체 HOLD, 수식 칸 HOLD, 전체 높이 읽기 필수, 종합 71칸·수식 재생성), `planSupplierDropdowns`(목록 칸만, 자유 입력 칸 규칙 유지). CLI `--split`, `--dropdowns`.
- 검증: 테스트24 PASS. 후속으로 정책 드롭다운 전부 `협의` 포함·자차면책 범위 확장(대표 결정, 커밋 ff2635f).
- **실제 적용(2026-10-03, 대표 직접 지시로 총괄 세션이 gws·Sheets API로 실행, 절차는 runbook `한 번 세팅 적용 절차`):** 백업 사본 `[복구용 원본] 프리패스 구글시트 상품리스트 — 2026-10-03 정책 칸 분리 전`(같은 폴더, 공유 변경 없음, ID는 private evidence). 칸 나누기 batchUpdate 1회 요청 999건(열 삽입 153·셀 200·폭 323·검증 323), 드롭다운 batchUpdate 1회 setDataValidation 779건(19탭×41칸) 성공.
- **이 세션 독립 재조회(gws 읽기 전용):** 보이는 20탭 71칸·고정1행. 백업 원본 결합 값과 새 분리 칸 210행·3,570칸 대조 불일치0, 나누지 않은 칸 변경0. 종합 차량번호 행 206 = 공급사 탭 합계 206(번호 없는 행 포함 210, 총괄이 처음 본 81행은 부분 읽기). 마음카 2행 기준 71칸 드롭다운/자유 입력이 규격과 일치. 에코·스위치플랜·렌트존·마음카는 분리 전 원본에서도 정책 칸이 비어 있었음(정책 확인 필요 37행 소속) — 분리로 사라진 값 없음.
- 후속 결정(2026-10-03 대표 총괄 창 직접 결정): 보험료 드롭다운은 `포함·불포함` 두 개만(`협의` 제외). 규격·시험 반영, 시트 드롭다운은 총괄이 gws로 변경.
- 남음/HOLD: 정책 확인 필요 37행과 목록 밖 기존 값(연료 HEV 1, 대여료카드 `인도일 기준` 10)은 공급사 확인. 공급사 담당 계정 편집 권한(전환 3단계)과 운영 원천 전환은 미착수.
- next_start_here: runbook `현재 기준` → 2단계 대조 실측(`--compare`, 이제 gws로 직접 읽기 가능) → 공급사별 입력 창구 전환.

## 2026-10-03 공급사 연동 방식 구분 — 공동 시트 19곳 / 직접 연동 5곳

- 목적(사용자): ERP·홈페이지로 연동하는 공급사와 구글 시트로 입력하는 공급사를 프리패스 데이터 안에서 명확히 나눈다. 만들어 둔 공동 시트를 실제로 확인한다.
- 실측: Codex 구글 커넥터 읽기 전용(쓰기·복사·공유 0). 공동 시트 공급사 탭 19개가 ERP4 고정 엔진 `fe3eccc` 수집 목록의 generic-sheet 공급사 19곳과 1:1. 이안카·손오공·아이언·오토플러스·아이카는 시트에 없음. 62칸 헤더·고정 1행/0열 일치, 차량 207+번호없음 4=종합 211, 오류0, 정책 확인 필요 37, 자차 관련 표시 68(처음 보고 45와 기준 차이 — 확정 필요), 연식 형식 `0`.
- 변경: 규격 `supplierChannels`(공동 시트 19곳 코드↔탭, 시트 밖 5곳 연동 방식, 같은 파일 공유 3쌍, 웰릭스 전용 어댑터 충돌 메모). 실행기가 등록 안 된 탭·코드-탭 불일치를 HOLD, 확인은 19곳 전부 필수, 대조는 빠진 곳 `notCompared` 보고. runbook에 구분 표와 실측.
- 후속 대표 결정(같은 날): 공동 시트에는 제공 시트를 쓰던 공급사만 둔다 — ERP·API·홈페이지 연동 공급사와 아이카 제외. 실측으로 5곳의 탭·행·정책 원문 0건 확인(시트 변경 없음). 규격 `membershipRule`과 실행기의 제외 공급사 HOLD로 고정.
- 남음/HOLD: 웰릭스 전용 어댑터(`src/domain/source-intake.ts`)는 정리 대상이나 이번에 코드 변경 안 함. 운영 수집 원천 전환은 대조 일치 후.
- next_start_here: runbook `현재 기준`의 공급사 구분 표 → 2단계 대조 실측.

## 2026-10-03 공급사 공동 입력 시트 2단계 — 기존 제공시트 대조 전용

- 목적: 원천을 공동 시트로 옮기기 전, 공동 시트와 기존 공급사별 제공시트가 같은지 공급사·차량번호 단위로 확인할 수단. 쓰기·발행·원천 전환 없음.
- 대상: 1단계 PR #281(`work/freepass-data/supplier-input-layout-20261003`) 위에 쌓음.
- 변경: `compareSharedToLegacy`와 CLI `--compare`, 규격 `legacyCompare`(fieldMap 29열, 키 차량번호 공백 제거, 30분 신선도, 값 비교 규칙, 정책 비교 HOLD). runbook 전환 2단계 갱신.
- 검증: 공급사 시트 테스트20 PASS, check:sheets45 PASS(이름 바뀐 열, 공백 번호, 쉼표 숫자, `90만원` 불일치, 한쪽만/중복/번호없음, 기존 시트 열 누락 시 IN_SYNC 불가, 기존 헤더 중복·캡처 중복 HOLD, binding 밖 캡처 보고, 오래된 읽기·양식 다름·탭 없음 HOLD). Codex 1차 NO-GO(거짓 IN_SYNC 경로 4건·문서) 반영.
- 남음/HOLD: 실제 Google 읽기 연결과 19공급사 실측 대조 미실행(공동 시트와 16개 제공시트 읽기 권한·binding 필요). 정책 열 대조 규칙 미정. 3단계(입력 창구 전환)는 실측 IN_SYNC 공급사부터.
- next_start_here: 권한 있는 읽기로 두 쪽을 같은 30분 안에 캡처해 private evidence에 두고 `--compare` 실행 → 공급사별 결과를 접수로 보고.

## 2026-10-03 공급사 공동 입력 시트 양식 고정 / 덮어쓰기 차단

- 목적/결정: 공급사 입력은 공동 시트 `프리패스 구글시트 상품리스트`로 통일하고, 전환 기간에는 기존 공급사별 제공시트를 유지한다(운영 수집은 계속 기존 시트). 같은 날 Codex가 사용자와 확정한 62칸 양식(차량·요금30+정책32, 정제코드/정책코드/점검사항 제거, 헤더1행만 고정)을 실제 시트에 일회성 스크립트로 적용했는데 저장소 규격·실행기는 10-02 양식이어서 다시 돌리면 HOLD 또는 옛 서식(고정열6/2·기울임)으로 되돌릴 위험이 있었다.
- 대상 revision: main `732cf2c` 기반. 실제 시트·운영 F01/F86·스케줄 변경0. Codex 미커밋 전환 계획(`~/.codex/worktrees/f86-supplier-input`)의 runbook·F86 spec 블록을 이 양식에 맞춰 흡수했다(원 worktree는 손대지 않음).
- 변경: `contracts/supplier-input-sheet-spec.v1.json` version2/layoutVersion `2026-10-03`, 62헤더·폭·숫자열·목록 고정, 10-02 양식은 `legacyLayouts`에 보존. `planSupplierInput`을 확인 전용으로 교체 — 헤더가 순서까지 규격과 다르거나(뒤쪽 빈칸 포함) 바인딩 탭이 숨겨지면 `HOLD: LAYOUT_MISMATCH`, 같으면 쓰기 요청0과 고정행/열 drift 보고. 폭·숫자 서식·목록은 규격에 기록만 하고 검사하지 않는다. 옛 열 재배치·종합 재생성 writer 제거. `planPolicyImport`는 10-02 양식 전용임을 명시 HOLD. `f01-f86-sheet-spec`에 `supplierInputTransition`(F86 이관은 나중, F01 유지) 추가. runbook 최상단에 현재 기준과 5단계 전환 순서.
- 검증: 공급사 시트 테스트15 PASS(옛 양식·재배치·누락·추가·빈 헤더·뒤쪽 빈칸·숨김 탭 HOLD, 쓰기0, 정책 이관 HOLD 포함). Codex 독립검토 1차 NO-GO 3건(숨김 탭·문서 과장·뒤쪽 빈칸)을 모두 반영, check:sheets40 PASS, standards exit0, 전체 check(Vitest1168 PASS/14 외부환경 SKIP, build) PASS.
- 흡수한 Codex 관측(같은 날 양식 재구성 전, `work/freepass-data/f86-supplier-input` 미커밋 기록): 공급사19탭 입력210행/종합210행, 회사명 불일치0·종합 오류0. 사용행 CellData로 공급사→종합 210행·14,436칸 헤더별 대사 typed mismatch0·원본행 누락0. 정책확인 ledger MATCHED173/POLICY_CODE_EMPTY33, 차량번호 없는 기존4행. live F86 전체18탭 CellData를 private observation으로 보존(복원 가능한 전체 백업 아님). 로컬 gws는 Sheets scope 403, Codex 커넥터 읽기는 성공. 이 수치는 10-03 양식 재구성 전 관측이며 현재 양식의 실측이 아니다.
- 남음/HOLD: 실제 시트를 이 실행기로 fresh 재조회해 LAYOUT_VERIFIED를 받는 실측은 미실행(Google 읽기 binding 필요). 10-03 적용 시 `연식`에 `#,##0`이 걸렸을 수 있음(2023→2,023) — 규격에서는 제외, 화면 확인 필요. 정책 미확인37행·자차 충돌45행은 공급사 확인. 새 양식용 서식 재적용 계획기 없음.
- next_start_here: runbook `현재 기준` 절 → 전환 2단계(공동 시트를 읽어 기존 제공시트와 공급사·차량번호·헤더별 대조만 하는 모드, 쓰기·발행 없음). 공동 시트 헤더는 규격 `inputHeaders`를, 기존 시트는 ERP4 `inventory-source-registry`의 generic-sheet 공급사를 기준으로 한다.

## 2026-10-03 이안카 15분 자동 수집 활성 / 첫 실반영 검증

- 목적/결정: 사용자 최신 지시는 질문을 반복하지 말고 ONE 전체 재고·상태·대여료·사진을15분마다 계속 맞추는 것이다. 최소 권한 범위 설명 뒤 작업 진행 직접 지시를 받아 기존 계정에만 적용했다. 정책2차/RTDB/새 writer/수동 입력 시트는 제외한다.
- 정본/revision: Data 실행기는 main `4917f2a79c0ab41d83dee745c8645bf810934f98` 고정, ERP workflow와 지도는 main `6a72da4c`까지 반영. 본 인계는 audit-only main `ee08bb35ac00a61ebf5a8b4edb393e5f146d3a72` 위 문서 확장이다. 기존 dirty 작업선은 보존했다.
- 변경: 기존 github-inventory-writer에 단일 supplier SecretAccessor 및 private audit bucket `iancar-one/` prefix 조건부 objectCreator/objectViewer를 적용·재조회했다. 삭제/덮어쓰기/공개 공유 권한 없음. `IANCAR_ONE_15M_ENABLED=true` 설정·재조회로 기존02/17/32/47분 수집이 활성이다. 백업은 ifGenerationMatch=0, byte readback 후 atomic apply다.
- 실제 검증: 운영 계정 DRY_RUN `37098391402` SUCCESS. 두 적용 시도는 공급사 stale=true에서 writes0/HOLD로 차단됐다. 새 source `2026-10-03T05:13:44.411Z`의112대/공개105/사진59대2681장에 ALL apply `37099324378` SUCCESS. 신규5/미관측13 비공개 보류/삭제0. Data run `a54b1f94-f461-469e-8f52-05b4b5813267`, sourceDigest `880a8181c80e2a97c738b957a6b8a0fff6bbc5676cc30d87800e6e9a2ca3fa2a`; private backup `iancar-one/a54b1f94-f461-469e-8f52-05b4b5813267/backup.json`(fixed private evidence bucket). PHASE_ONE_ATOM_READBACK_VERIFIED.
- 소비처: 동일회차 F01/F86 발행, RP031 상태/요금 검증, 공개catalog mismatch0, F86 freshness, Atom↔F01↔F86 칸 및 전체 사진 링크 감사 SUCCESS. live eancar feed105/실사진53/연출50 직접 확인, 실사진3건 HTTP200 JPEG. source 전체 사진59대와 공개사진53대는 같은 모수가 아니다. generic raw terms coverage UNKNOWN은 여전히 HOLD이며 phase-one observed facts 적용을 Catalog ACTIVE 전체전환으로 확대하지 않는다.
- 독립 검토: 기존 코드/collector/workflow ANSWERED에 추가 IAM read-only ANSWERED/exit0. 첫 objectCreator overwrite 반례는 Google 공식 역할 정의와 ifGenerationMatch=0로 반박하고 검토자가 후속 ANSWERED에서 철회했다. 412를 무조건 성공 처리하라는 제안은 미채택(기존 원문 대조 필요).
- 남음/next_start_here: ERP `docs/예약작업-지도.md`와 활성 native 회차에서 다음 source 전진·실제 실행 지연/같은 발행본 대사를 확인한다. 첫 성공은 workflow_dispatch이며 native 자동회차 성공으로 세지 않는다. 긴 기존 writer 실행 시 추가 회차는 양보하므로 정확히15분 벽시계 SLA는 보장하지 않는다. supplier stale는 last-known-good 보존과 실패 receipt로 처리한다. Admin 개별UI/정책2차/전체 Catalog cutover는 별도다.

## 2026-10-02 공급사 입력 시트 수동관리 / 대여료 헤더 복원

- 목적: `프리패스 구글시트 상품리스트`를 자동 공급사 동기화가 아닌 사람이 공급사 탭에 한 행·한 칸씩 직접 입력하는 장부로 확정한다.
- 정본/운영: 보이는 공급사 탭의 현재 셀이 수동 입력 정본이며 `종합`은 수식 조회 탭이다. 이 파일에 예약 source refresh나 자동 덮어쓰기 writer를 연결하지 않는다. 새 차량의 회사명은 탭 이름, 차량번호는 행 식별 기준이다.
- 변경: 수동관리 모드와 입력 규칙을 기계 규격·실행기·runbook에 고정했다. 원본 웰릭스·우리캐피탈·KH 재고 탭을 재조회해 대여료 본문 기간색은 유지하고, 잘못 옅은 색으로 덮인 대여료·보증금 헤더를 원본 청록 `#0891B2`로 분리했다.
- 검증: 원본 웰릭스·우리캐피탈·KH의 헤더/본문 색을 native format으로 대조했다. Sheets 회귀47 PASS와 build PASS. 실제 파일은 종합+공급사19탭의 대여료·보증금 헤더180칸을 `#0891B2`/흰 글씨로 적용한 뒤 모두 재조회했고 본문 기간색도 일치했다. 종합 화면에서 진한 헤더와 옅은 본문을 확인했다.
- 남음: 운영 F01/F86, ERP 연동 공급사, 원천 데이터 값은 이번 수동 입력 시트 변경 대상이 아니다. 이 파일에는 자동 source refresh가 없다.
- next_start_here: `docs/SUPPLIER-INPUT-SHEET-RUNBOOK.md`의 수동관리 원칙과 `contracts/supplier-input-sheet-spec.v1.json`의 manual/rental color fields를 먼저 읽는다.

## 2026-10-02 입력 텍스트 맞춤 / 정책 원문 복원

- 목적: 셀 안 줄바꿈+행 높이 자동 맞춤, 예전 정책의 실제 내용 이관. 대상 main `fd873c62d6e66220d8b35baa100216364c178de4` 기반.
- 변경: 기존 input planner/계약을 확장하고 `planPolicyImport`/`buildPolicyArchive`를 추가했다. 원천16파일의71/72열을 헤더로 대조하여72항목을 보존했고173행의 빈 정책2,367칸을 이관했다. raw 기존값/0/수식은 보존, 원천 수식·헤더 hash·셀 provenance 및206행 matched/HOLD ledger를 남겼다.
- 남음: 정책코드 없는33행은 HOLD이며 기본 정책을 임의 적용하지 않는다. 전체 원문은 `정책원문`, 확인은 `정책확인`(관리안내39행 링크). 운영 F01/F86 발행기·source cutover·sharing·자동 정책 refresh는 이번 scope가 아니다.
- 독립 검토: Claude ANSWERED/exit0. 읽기 실패/없음 구분, 코드타입, 헤더별 archive/hash, 0/수식/provenance를 반영. 자동 코드 정규화는 원문키 불변성을 위해 반영하지 않고 HOLD.
- next_start_here: `docs/SUPPLIER-INPUT-SHEET-RUNBOOK.md` 최신 이관 절과 private run `supplier-policy-import-20261002-01`의 source/plan/readback을 확인한다. 실제 원문/계정 정보는 공개 repo에 넣지 않는다.

## 2026-10-02 공급사 원문 입력 시트 영속 규격

- 목적: 단발성 시트 편집을 계약/실행기로 고정한다. 회사명→상태→분류→차량번호→입고일자→점검사항, 단기1/6/12 표시, 옵션은 대여료 뒤, 기타기간 숨김, 정책 입력칸 공개, 숫자 콤마, 일반 dropdown, 탭 자물쇠 제거가 사용자 최신 결정이다.
- 대상 revision: main `4e437864cf3ff5d84c10493e0b7bb0a070772b66` 기반. 다른 checkout/운영 F01/F86 pin과 원천 데이터를 보존한다.
- 변경: `contracts/supplier-input-sheet-spec.v1.json`, `scripts/supplier-input-sheet.mjs`, `docs/SUPPLIER-INPUT-SHEET-RUNBOOK.md`. 별도 native binding과 fresh inventory로 dry-run하며 헤더 기준으로 종합/구조 gate를 재생성한다. private plan으로 실제 회사명 이동·보호 해제·종합을 적용했다.
- 검증: 신규 회귀10 PASS, 시트35 PASS, 전체 check/build PASS (Vitest1160 PASS/외부환경14 SKIP). 실제 입력행210/종합210 일치. Claude independent review는 REVIEW_TIMEOUT으로 답변이 없으며 PASS가 아니다.
- 남음: 운영 source cutover/공급사 sharing/자동 pin 및 제조사 종속 모델은 미연결. master16/114 목록은 F03 2026-10-02 실조회 snapshot이며 자동 freshness로 주장하지 않는다.
- next_start_here: `docs/SUPPLIER-INPUT-SHEET-RUNBOOK.md`와 기계 규격을 읽고 private binding/새 metadata/원본 backup부터 시작한다. 실제 worksheet 값은 public repo에 저장하지 않는다.

## 2026-10-02 공급사 관리 작업 회수 / 기존 운영 보존

- 목적: 사용자 요청의 완료 기준은 공급사 원천 조회·갱신과 대상 시트 대사 및 안전한 main 통합이다. Catalog 전체 전환을 이번 완료 조건으로 확대하지 않는다.
- 대상: main `298b296` 기반, 기존 PR262 관리 문서 회수. actor-prefixed branch 실패를 기존 Work의 `work/freepass-data/supplier-inventory-management` 이름으로 교정했다. 원래 작업 폴더의 dirty 문서와 타 작업은 보존했다.
- 변경: 기존 공급사 관리 기준을 통합하고 bridge 영수증에서 원천/신규/정책/시트 투영 검증을 구분한다. frozen `e6727ff0` 실행기는 최신 ONE API 소유 재고를 발견하면 backup 검증 단계에서 중단하여 lock/상품/정책/시트 쓰기를 시작하지 않는다. 현재 ERP 운영 pin·스케줄·실제 데이터 변경0.
- 회수 판정: 이안카 직접 수집/ONE 계약/공식 API PR265·267·269 및 손오공 사진 PR260은 이미 merged. 오래된 branch 전체를 재병합하여 최신 API·정책·사진 코드를 되돌리지 않는다. Core kit PR264는 별도 규격 작업이며 공급사 구현으로 섞지 않는다.
- 검증: 전체 check 1144 PASS/14 외부환경 SKIP, Sheets25 PASS/build PASS. delivery-owner 기존+신규 회귀를 별도로 실행한다. 운영 run36944530170의 23개 명령 정상종료 및 원자→F01→F86 mismatch0은 하류 투영 검증이며 공급사 원문 전량 정합성 PASS가 아니다.
- 남음: 신규 등록대기/공급사별 FULL+COMPLETE 원천 영수증·양방향 집합 대사, 손오공/픽업/오플 보완참조 차이 사유, 이안카 자동 writer 최신성은 미완료. 준비 bridge 활성화로 우회하지 않는다.
- next_start_here: `docs/BUSINESS-DATA-CONNECTION-MAP.md` 공급사 관리 기준과 `docs/NATIVE-SOURCE-COLLECTOR.md`를 따른다. 기존 SourceIngestionStore 및 공급사 adapter를 확장하고, 현재 운영 publisher의 검증된 rules를 확인한 뒤 별도 적용 경계에서 실제 시트 대사한다.
## 2026-10-02 이안카 실사진·차종 연출 이미지 — 운영 증거 최신화

- 목적/사용자 결정: 실제 API 사진을 유지하고, 사진이 없는 차량에는 이안카가 공개한 차종 연출 이미지를 원본 URL 그대로 사용한다. 실제 차량 사진처럼 표시하지 않는다. 기존 adapter/collector/photo-only publication 및 ERP ShopPhoto를 COMPOSE_OR_EXTEND했으며 새 저장소·시트·writer·RTDB 경로는 만들지 않았다. 두 대상 Academy READY, 다른 dirty checkout은 보존했다.
- 대상 revision: Data main `950ec9e131a539d0d58b441331afefe5fac72853`, ERP main `f24ab8133073fad0eb3867613495167f120b147d`, 기존 publisher pin `fe3eccc0173cb581e71a5a963bb7f28d3715b14f`. main fast-forward/push 확인. Data runtime은 기존 actual-photo transport `620c10f62874947ee012482cd8ef5c1b576b1c78`/Cloud Run `freepass-data-read-00015-649`이며 새 public illustration URL은 기존 compatibility reader로 제공하므로 별도 runtime 배포가 필요하지 않다.
- 실제 사진 발행: run `3a40956e-d168-41f8-b6b8-6dfbd068657d`, 공개109대 중50대/2,249장. 상세52대는 빈 사진 배열,7대는HTTP404였으며 404를 사진0장이나 재고 삭제로 처리하지 않았다. 해당 원본을 보존했다.
- 연출 이미지 source/write: fresh FULL+COMPLETE116대 capture `3b0db7ad-402c-4276-b168-c5f1267cd750`, sourceDigest `9fd4a59b7c98d4f6a56abff2817d732c6fa1f58e4b7d78d0268d8c607fafdb70`, syncedAt `2026-10-02T03:36:26.801Z`. 기존 빈 API사진52대에 exact vehicle ID/plate/full supplier model-name와 빈 배열을 재검증했다.51대는 MODEL_ILLUSTRATION,1대는 기존Drive folder 연결을 보존했다. 실제50대는 이번 write에서 손대지 않았다. run `dc456e14-3c5c-4292-ac04-fd677bbbf60b`, planDigest `c3bea2bd93bb3602709020784cac05a0d48abd380977684eac1a15988b628a49`, `PHOTO_ATOM_READBACK_VERIFIED`, typed private backup `photos-dc456e14-3c5c-4292-ac04-fd677bbbf60b.json`. 이 photo-only write의 재고/가격/삭제 변경0.
- 원본 보존: supplier neutral WEBP7개를 HTTP200/실제WEBP1536×1024로 확인하고 관측SHA256 checkpoint를 기록했다. URL/색상/이미지를 재생성·변환·재호스팅하지 않는다. 현재51대에는6개 asset이 쓰이고 MINI는 기존Drive 연결이 우선한다. SHA checkpoint는 관측 증거이지 매 렌더의 무결성 강제 검증이 아니다.
- 검증/운영 화면: Data 전체 check exit0(1,147 PASS/14 SKIP, architecture/access/sheets25/build/smoke/shadow), ERP typecheck/catalog102+illustration contract/fonts/build PASS. Claude scoped Data session22458와 ERP session23400은 본문/exit0/ANSWERED/GO이며 no-overwrite·exact identity·rerun·thumbnail/mobile 구분 반례를 반영했다. timeout/command-length 실패는 PASS로 세지 않는다. ERP CI36961373357 SUCCESS, Vercel production 배포 및 `/api/version` sha `f24ab81` 확인. 공개 feed109대에서 supplier illustration51/actual-photo proxy50 확인. 실제 `10하8263` 상세/확대/375px 모바일에 원본 WEBP와 연출 안내문 표시, `10하8128` 실제50장 갤러리/대표사진1920px 및 연출표시0 확인.
- 시트 실행: PREPARE `36961710523` SUCCESS, snapshot `20261002040132994-477dd48d50b8`의 illustration51대/actual-photo50대·2,249장 보존 확인. 같은 ready_run_id를 지정한 ALL apply `36962834677` SUCCESS. F01/F86 발행, RP031 evidence, 공개catalog, F86↔atom 신선도, 전체 칸 및 전체 탭 사진 링크 감사 모두 SUCCESS. 별도writer/수동append 없음.
- 새 native readback: F01 `1Y1Mx1EcEpAuNer0y50Dq4eK92CpVjThO_suZLmo2vVs`/668539469와 F86 `1hQtshpWKL4L0zSR3H3UQ36atICtHv9Ka7dQh7d7K5Vg`/2029374993의 `10.02 13:01 상품리스트 315대` C2:C316, F86/1942643715 `이안카 109대` D2:D110을 실제 연결로 재조회. 각 뷰의 exact plate/expected canonical photo URL 대사109/109, illustration51/51, actual50/50, preserved8/8, mismatch0(전체327개 차량 식별·링크 상태 일치). 기존 보존8대 중2대에는 기존Drive link가 있고6대는 사진 연결이 없다. 이 기존 상태를 공급사 사진없음으로 확정하지 않는다. API 빈사진52대 중의Drive1대와 전체 보존8대 중Drive2대를 혼동하지 않는다. 실제 F01 C70/F86 이안카D44에 `10하8263` 파란 링크 확인, 게시된 `/q/abkpegyd3a` 도착 화면의 원본 illustration와 안내문 확인. 기존 tabs/원천 숨김 사진/T카 링크 보존.
- 남음/next_start_here: 이번 실사진·연출 이미지의 Data→ERP 기본/이안카 white-label→F01/F86 연결은 위 시점에서 검증됐다. 다음 갱신은 기존 collector의 fresh `--photos`→dry-run/CAS/private backup→동일plan apply→기존 publisher exact READY→새 readback을 따른다. 정책2차와15분 공식 API writer/schedule은 별도다. 공개109대가 최신 source116대와 같다는 뜻이 아니며 재고 최신화는 이번 photo-only 범위 밖이다.7개 이전404는 재확인 전까지 미확인으로 보존한다. 기존Drive 실제 폴더 내용, Admin 및 모든 화이트라벨 개별 UI, Catalog V1 전체 cutover는 미검증이다. 실제사진 후속 수집 시 image_kind는 VEHICLE_PHOTO로 바뀌지만 과거 illustration metadata가 남을 수 있으며 공개 UI는 현재 image URL로 분류한다.

## 2026-10-02 이안카 사진 운영 배포 준비 — 아래 로컬 기록을 대체

- 사용자 직접 지시: 사진을 전량 연결하고 배포한다. Data/ERP/기존 F01·F86 publisher 순으로 진행한다. IAM 변경은 기존 runtime SA가 기존 이안카 단일 Secret을 읽는 범위로 한정한다. RTDB는 사용하지 않는다.
- 코드: Data 인증 transport + ERP 공개 상품/채널 gate + raster decode/EXIF·GPS 제거. Data의 private byte cache는 exact vehicle/photo ID, 30초·32MiB·최대8 fetch이며 Cloud Run concurrency8과 일치한다. Secret name/version을 GitHub vars로 pin하고 readiness에서 재검증한다. 사진만 수정하는 publication은15분 capture/CAS/private typed backup/재조회/감사 gateway를 사용한다. 절대 ERP proxy URL을 발행해 다른 origin의 Admin/AI도 참조할 수 있다.
- 검증: Data build/architecture/access PASS, 전체1143 PASS/14 SKIP, Sheets25 PASS; photo rollback을 mocked 원본·계약 보존/추가필드 삭제로 연습했다. ERP typecheck/공개catalog102+회귀/data authority PASS, CI 방식 public Firebase placeholder production build PASS. 실제 production 환경/화면 확인 전에는 배포 완료가 아니다.
- 원천 read-only 관측: 공개109 중104 응답,52대2348장,5개ID404. 404는0장이나 삭제가 아니며 해당 원본을 그대로 보존한다. 최신 full API list116대/coverage issues0에서 기존404 차번3개는 미관측; 차량ID를 추정 재매핑하지 않는다. 운영 재고/가격 변경은0이다.
- 독립 검토: 이전 전체 검토의 secret pin/concurrency/cache/rollback 지적을 반영했다. 정확한 gate 호출 첫 검토는 REVIEW_TIMEOUT이며 PASS가 아니다. 좁힌 검토 진행 중. 배포/IAM/원자 사진 write/시트 write는 아직 미실행.
- rollback: Cloud Run 이전 ready revision `freepass-data-read-00014-8db`; ERP 이전 main `a00547ce4c794343f5520b03f48df00cac2a4a2d`; publisher 이전 pin `ce811592daef6c0283c3637ec94f1b7cf09a3838`. 사진 원자 backup은 `iancar-photo-typed-backup/1`. 복구는 `source:iancar:one -- --restore-photos=<private-backup> --expected-digest=<sourceDigest>` dry-run 후 승인 시 `IANCAR_PHOTO_RESTORE_APPROVED=true`와 `--apply`; 원본 이외 변경이 있으면 HOLD한다.
- next_start_here: 독립 검토 blocker 해소 → Data main 통합/private runtime 배포 exact revision → ERP main 통합/production SHA와 실제 사진 확인 → fresh capture/동일plan photo-only write → 새 publisher pin·검증 snapshot으로 F01/F86 canonical workflow apply → 두 시트/모든 대상 소비처 새 readback. 해당 증거 전에는 전체 완료/15분 자동화 완료로 보고하지 않는다.

## 2026-10-02 이안카 인증 사진 transport — 코드/실호출 검증, 운영 연결 미완료

- 목적/결정: 사용자가 API 사진을 우리 서버에서 인증해 제공하는 방식을 승인했다. 새 사진 저장소/Drive 재호스팅/공개 API키는 사용하지 않는다. 기존 상품·사진·계약·가격은 변경하지 않는다.
- 대상: Data `5318ccfadc655a28a708fd645976057fb030941e` 기반 detached worktree `C:\Users\admin\.codex\worktrees\iancar-photo-proxy\freepass-data`; ERP `a00547ce4c794343f5520b03f48df00cac2a4a2d` 기반 detached worktree `C:\dev\worktrees\freepasserp4-iancar-photo-proxy-20261002`. 이전15분 초안/다른 dirty checkout은 보존했다. 두 대상 Academy READY, 기존 ONE client/compatibility reader/consumer gateway 및 ERP api/img COMPOSE_OR_EXTEND.
- 변경: 기존 Data adapter에 exact vehicle ID+plate/photo path 귀속, 대표사진 우선, raster MIME+magic/8MiB 스트림 제한 추가. Infra는 상품ID를 중앙 target에서 조회하고 공개 RP031만 허용하며 provider 호출은 composition root에 주입한다. 기존 소비처 token/capability/audit 후 `/v1/consumers/{consumerId}/catalog-compat/products/{productId}/photos`(count-only) 및 `/photos/{index}`(image bytes)를 제공한다. 상세 참조30초/128건 bounded coalescing, 이미지 바이트는 저장/캐시하지 않는다. provider 키·만료 URL·photo_id·원문 오류는 공개하지 않는다. ERP 기존 `/api/img?product={docId}&photo={index|manifest}&wl=eancar`는 기존 공개 목록/채널 fence와 consumer token/WIF를 사용하고 Data 사진만 전달한다.
- 검증: Data 전체 check PASS(1138 PASS/14 SKIP/build/architecture/access/sheets 등), 마지막 coalescing 변경 후 build+targeted76 PASS. Infra→adapter 직접 의존은 첫 architecture 검사에서 실패하여 runtime composition 주입으로 수정했다. ERP TypeScript 및 check-freepass-data-consumer PASS, diff whitespace 오류0. 실제 read-only RP031 상품 `10하8128`로 새 reader에서 사진50장 목록 및 대표 JPEG562156bytes/magic 검증 성공, business writes0. 이것은 로컬 reader 실호출이며 운영 HTTP/UI 표시나 전 차량 반영 완료가 아니다.
- Claude: 이전 방식 검토는 ANSWERED이며 stable vehicle ID/재배포 범위/소비처 Sheet 쓰기 금지 지적을 반영했다. 이안카 사진 제공 코드를 검토하는 별도 scoped read-only review는 아직 진행 중(session71308), PASS로 세지 않는다. 기존 Drive 폴더 존재는 우리 연결의 exact-ID metadata에서 확인했으나 reviewer의 다른 Drive 연결 검색0과 섞지 않았다.
- 운영 HOLD: 현재 private Cloud Run `freepass-data-read`에는 소비처 Secret만 바인딩되고 이안카 Secret은 미바인딩이다. 기존 runtime SA `freepass-data-read-runtime@freepasserp5.iam.gserviceaccount.com`에 기존 `freepass-data-iancar-one-api` 단일 Secret read 권한 및 Data/ERP 사진 연결 배포 범위를 사용자에게 질문했으며 아직 답을 받지 못했다. IAM mutation/배포/feature 활성화/DB·Sheet 쓰기/commit·push는 미실행. 검사 대상은 미커밋 로컬 초안이다.
- next_start_here: scoped review 반례 해소 및 ERP photo transport 행동 테스트/빌드 → 중앙 photo manifest/index를 공개 상품에 붙이는 소비처 연결(현재 공개 feed/상세에 proxy URL을 자동으로 붙이는 코드는 아직 없음; 주소만 만든 상태를 반영 완료로 말하지 않음) → 확인된 범위 사용자 승인 후 Secret read/binding 및 기존 deploy workflow에 영속 설정(현재 deploy의 --set-secrets는 기존 consumer Secret만 지정하므로 수동 binding만 하면 다음 배포에서 사라짐) → main 통합/배포 정확한 SHA → 인증 없는 ERP image request의 JPEG와 실제 목록/상세 갤러리 확인 → F01/F86 기존 photo_link/gallery 소비 경로에 Data 사실로 전달하고 새 readback. 무키 provider 사진401/키 인증200은 이전 및 이번 실측으로 확인했다. source photo_id는 영구키라고 가정하지 말고 신선한 상세에서 재조회한다.

## 2026-10-01 이안카 1차 실제 발행 — ERP·F01·F86 readback 완료

- 목적/정본: 공식 ONE API 차량번호·상태·기간/월연거리별 대여료를 Data 소유 RP031 상품으로 반영한다. source syncedAt `2026-10-01T08:13:03.756Z`, digest `3994442e0640d36722b206bac32f2dc55e22468ec05eeebc661c1dc9690fd9a5`, 117대/2,808개 실제 요금. 이 기록은 해당 관측 회차의 완료이며 현재 API의 실시간 신선도를 뜻하지 않는다.
- 대상 revision: Data main `2d2adc91d9f6f0c9885f1b57d603f804c0b571e5` 기반 기존 adapter/infra/runtime/test 확장. ERP main `8022e9a5`에서 정책 분리 및 실제 운영 배포 확인, `a00547ce`에서 중복 시트 별칭 제외/월연 거리 표시/기준 요금 보존 후속 수정. 기존 publisher engine `5fd7097d`으로 아래 실제 시트 적용; 후속 운영 pin `ce811592daef6c0283c3637ec94f1b7cf09a3838`.
- 변경: exact plate/source-ID 귀속·충돌/계약락·신선도·동시성 검사, 새 immutable ID 생성/기존 ID 보존, typed immutable backup 및 범위 한정 복구, structured 24개 요금과 시트 기준 별칭 8개, 정책 DEFERRED. 원천 미관측 역사210문서는 닫힌 상태로 보존한다. 삭제/계약 생성/정책 문서 변경0. 원천을 과거 Sheet로 대체하지 않는다.
- 실제 Data apply: run `b6a8ac1e-a86a-49c8-a53a-9037a760303a`, `PHASE_ONE_ATOM_READBACK_VERIFIED`, RP031327문서 중 source117/공개109(출고가능108·계약중1)/미공개8/역사210. 최초 적용에서 새26문서 생성 후 정책 빈 키 결합 오류를 발견해 typed backup으로 기존 값을 복구하고 신규 ID는 삭제 없이 닫았다. ERP 기존 `findGuestPolicy` 재사용/DEFERRED 방어 배포 후 최신117대를 다시 적용했다. private backup/receipt는 `.codex/private/freepass-data-iancar-withdrawals`에 보존, Git에는 원문·키·비공개 정책을 넣지 않는다.
- 시트 실제 적용: READY `36835722304`의 고정 스냅샷을 apply=true/target=ALL로 재사용한 운영 run `36837674105` SUCCESS. F01/F86 게시·전체 칸 대조·사진 링크 감사 모두 SUCCESS(건너뛴 준비 실행을 완료로 세지 않음). 기존 선두4탭은 상품317/손오공41/픽업151/오플41이며 F86 기존 supplier projection에 이안카109가 반영됐다. 별도 이안카 원천 요금표나 새 spreadsheet는 만들지 않았다.
- 새 native readback: F01 `1Y1Mx1EcEpAuNer0y50Dq4eK92CpVjThO_suZLmo2vVs`/668539469 및 F86 `1hQtshpWKL4L0zSR3H3UQ36atICtHv9Ka7dQh7d7K5Vg`/2029374993, `10.01 17:30 상품리스트 317대` A1:BQ318. 각각 이안카109, missing/status/기준요금/24개 전체 기간·거리·보증금/정책 표시 mismatch 모두0. F01 금액은 formatted string, F86 numeric이므로 타입 일치 대신 원천 금액으로 대사했다. 단기 월2,000km/장기 연20,000km 유지, 6개월 요금은 원천에 없어 빈 값, 카드·해지위약 조건은 확인중. 실제 두 Sheets 화면도 확인했다.
- 검증: Data 전체 check PASS(1,134 PASS/14 SKIP/build/architecture/data-access/sheets), engine check:sync/typecheck PASS, ERP contract102+phase-one 회귀/typecheck PASS. Claude scoped reviews ANSWERED는 빈 정책 키 결합·옛 override 누출·가드 정규화/잉여키·기준가격 역전 반례를 찾아 수정했다. timeout은 PASS로 세지 않았다. 월거리를 연거리로 바꾸라는 제안은 원천 단위 보존에 반해 채택하지 않았다.
- 남음: 정책 2차, 사진 전량 새 수집, 공식 API→상품15분 자동 writer/runtime secret binding, Catalog V1 ACTIVE release/cutover, Admin 및 모든 화이트라벨별 실제 검증은 별도다. 기존 hourly Sheet publisher 연결이 API15분 갱신 완료를 뜻하지 않는다. 전체 플랫폼 완료로 확대하지 않는다.
- 후속 ERP 배포 readback: `/api/version` sha `a00547c` 실제 확인. RP031 공개 feed109대/차량당24개 조건(합계2,616), source와 missing/status/rent/deposit mismatch0, policy 첨부0. 실제 `/q/p5tphe9zrr?wl=eancar` 요금24개 및 정책 확인 필요 표시 확인. 상세 사진14장은 기존 사진 보존 증거이며 이번 회차 전 차량 새 사진 수집 완료가 아니다.
- next_start_here: 이 회차의 source/atom/ERP/두 시트 대사 증거를 보존한다. 다음 API 갱신은 stale capture를 다시 쓰지 말고 fresh capture→dry-run/backup→동일 digest apply→consumer readback으로 진행한다. 정책은 rate별 보험·카드·위약 조건과 우리 계약을 필드별 대조한 뒤 별도 적용한다. Claude 잔여 제안은 향후 기준 별칭을 lowest mileage와 다르게 지정하거나 혼합 월연거리를 허용할 때 public 기준 표현을 다시 설계하라는 내용이다. 현재 Data는 lowest observed mileage 규칙을 고정하고 혼합 단위를 거부하므로 해당 반례는 현행 허용 입력에 해당하지 않는다.

## 2026-10-01 이안카 1차 적용 재개 — 최신 요금 수집 성공, Data 상품화 우선

- 목적: ERP와 F01/F86에 차량번호·상태·정확한 기간/거리별 대여료를 1차 반영하고 정책은 후속으로 분리한다.
- 대상: main `65b284c4a9796703ccaa414054fb3383845e1ab8` 기반. 기존 ONE adapter/job/test 확장. 운영 track Academy READY / COMPOSE_OR_EXTEND. 실제 DB·시트 쓰기는 미실행.
- 변경: PHASE_ONE_FACTS는 목록+rates만 수집하며 마지막 신선한 목록 상태를 사용한다. 상세/availability 변경으로 전체 수집을 실패시키는 불필요한 정책 단계 의존성을 제거했다. 새 ID/번호는 요금을 재조회하며 최대3회 후 미조회 ID가 남으면 HOLD. 요청 경로+목록 ID 귀속, 요금 관측15분, source absence 권한 없음.
- 실제 수집: source syncedAt `2026-10-01T05:39:49.172Z`, 116대/2784개 요금, AVAILABLE106/RESERVED1/PREPARING3/UNAVAILABLE6, issues0. private capture `1ece1751-39cc-4af6-bce7-a37cb4b2f53a.json`, digest `10705a20d1e5f53aec54575d83d5718f1b5114924a584aa5b6e251d6fb16c7d4`. private 위치는 기존 `.codex/private/freepass-data-iancar-one-captures`; 원문이나 키를 Git에 복제하지 않는다.
- 적용 전 조회: RP031 기존301/listable0/contract lock0. 전체 products 대사에서 정확한 차량번호 기존91/신규25/미관측 역사210/타 공급사 번호충돌0. 해당 capture는 적용시 다시 신선도·원천 변경을 확인한다.
- 검증: 전체 npm run check PASS, Vitest1129 PASS/14 SKIP, 전용53 PASS. 새 경로의 정책 조회 없음·예약 변화 수용·번호 변경 재조회·계속 추가되는 ID HOLD·unknown deposit·오래된 요금 관측 회귀 포함. Claude 첫 운영 범위 review는 REVIEW_TIMEOUT, 좁은 수집기 검토 재시도 결과는 아직 대기하며 PASS로 세지 않는다.
- 사용자 최신 결정: 별도 이안카 요금표를 생성하지 않는다. FreePass Data에서 Product/Offer/PriceTerm으로 상품화하여 기존 ERP·F01·F86 소비처에 반영한다. 공급사 표 형식 자체를 가져오지 않는다. 정책은2차다.
- Claude 좁은 수집기 독립 검토 ANSWERED: 마지막 목록 대사/귀속/신선도/실패 안전성은 동의. fingerprint에 조회 captured_at이 섞이는 문제를 지적하여 기존 full-facts처럼 captured_at:null 사본으로 hash하고 원문 시각은 보존했다. 시간만 바뀐 동일 원천의 fingerprint/sourceDigest 동일 회귀를 추가했다.
- 남음: 정책 링크를 그대로 복원하면 consumer 기본 정책이 잘못 노출되므로 분리해야 한다. ERP4 현재 원격 main의 withdrawal guard는 RP031 재노출 스냅샷을 거부하며 운영 pin은 `99a27c90347579e5086b9a538e28e3384f31820f`였다. 단순 atom status 복원/수동 Sheet append로 이 경계를 우회하지 않는다.
- next_start_here: 기존 canonical candidate/Product/Offer/PriceTerm 경로 확장 → 검증된 phase-one publication plan/backup/동시성·계약락/정책 분리/rollback 구현 → 독립 검토 → 정확한 RP031 범위 적용 → ERP 공개와 F01/F86 새 readback. 소비처 전량 parity나 운영15분 자동화는 아직 미검증이다.

## 2026-10-01 이안카 15분 eventual convergence 결정

- 사용자 결정: 공급사 15분 갱신 사이 순간 대수 차이는 정상 동기화 지연이며, 다음 회차가 따라잡아야 한다. 같은 벽시계 시각의 완전 일치를 실행 조건으로 강제하지 않는다.
- 대상: main `2550e024854cbf203e2a30df17e3a8103d98de08` 이후 ONE adapter/test/API 계약 확장. Academy READY. 원천 시각만 전진한 경우와 실제 차량/상태 변경을 분리한다.
- 변경: 상세의 fresh timestamp는 시작 timestamp보다 전진해도 허용한다. 신선도15분/미래60초/역행불가를 검증하며, 시작·종료 목록의 ID/번호/상태/available/from 집합은 정확히 비교한다. 원천 시각만 달라졌다는 이유의 false HOLD를 제거했다. 시작·종료 시각은 bounded observation window로 남겨 atomic snapshot이라고 주장하지 않는다.
- 경계: 재고/상태 실제 변경·페이지 내 drift·stale·API 오류는 해당 회차 재대사 대상이며, 기존 성공 발행본이나 계약락을 파괴하지 않는다. 정책 연결은 2차다. 운영 15분 writer/스케줄러와 첫 발행·소비처 readback은 이 변경에 포함되지 않는다.
- 검증: 전용49 PASS/build PASS. Claude 독립 검토 ANSWERED는 시각 분리와 정확한 사실 집합 비교에 동의했고, 원천60초 역행 허용과 주입 now/벽시계 혼용을 지적했다. 역행0초, 주입된 시작시각+경과시간으로 통일하고 종료1초 역행 회귀를 추가했다. 전체 check 재실행과 Git remote 확인 뒤 반영한다. 운영 최신 수집/발행 성공을 테스트로 대체하지 않는다.
- next_start_here: 최소 차량번호/대여료 수집 및 기존 운영 publisher에 이 eventual convergence 규칙을 연결한다. source/last-success/projection-readback 시각을 나눠 지연 상태를 보여주고, 실제 변경분은 다음 회차 재수집한다. 스케줄 실행 자체와 원천 최신성/발행 성공을 구분한다.

## 2026-10-01 이안카 1차 차량번호·대여료 / 정책 2차 / 대수 일치

- 목적: 최신 사용자 결정은 차량번호·대여료부터 연결하고 정책은 뒤에 붙인다. 이안카 ERP와 화이트라벨 이안카는 같은 원천 버전의 차량 집합·상태별 대수가 일치해야 한다. 예약은 계약중이며 실제 계약을 생성하지 않는다.
- 대상 revision: main `455a28d19f0634af2924c9b1e0b4d71e81d0d02f` 기반. 기존 ONE adapter/job/test/API 문서 확장(COMPOSE_OR_EXTEND), Academy READY. 신규 원장/별도 저장 경로 없음.
- 변경: `projectIancarOnePhaseOne`은 차량 ID/번호·상태·기간/월연거리별 월대여료만 REVIEW ONLY로 추출한다. 정책/보증금/노출/계약락 변경 없음. `--phase-one`은 전체 검증 조회 후 비식별 집계만 출력한다. 실제 sourceDigest/syncedAt·차량 ID·번호·원천/표시 상태·요금 tuple parity gate를 추가했다.
- 검증: 전용 43 PASS, build PASS, architecture/data-access boundary PASS, 전체 Vitest 1119 PASS / 14 SKIP. 소비처 운영 반영/배포/쓰기는 미실행. 최신 목록 관측은 112대였으며 앞선 111대 고정은 금지한다. 전량 재조회 첫 시도 HTTP503 실패; 두 번째는 50대 이후 DETAIL_SOURCE_DRIFT로 실패(503 재시도0). 서로 다른 원천 갱신 시각을 섞지 않아 발행하지 않았다. 현재 Firestore RP031301문서/listable0, ERP 공개 feed HTTP200/count0 새 조회 확인. 최신 요금 전량 검증은 HOLD다.
- Claude 독립 검토 ANSWERED: 합계만 같은 차량 집합, 틀린 가격, 다른 snapshot의 false PASS를 지적해 ID/표시/가격/snapshot gate와 upstream invalid-rate 회귀를 추가했다. `rates.updated_at`은 요금표 revision 시각이므로 임의로 inventory 15분 규칙을 적용하지 않았다. 신선한 GET와 inventory freshness를 별도로 검증한다. 지역번호 plate는 추정 변환하지 않고 현재 전체 REVIEW를 HOLD한다.
- 후속 독립 검토에서 whitespace plate로 가격 검증 건너뜀·빈 집합 PASS·객체 key 순서 오판을 발견해 공통 plate key/빈 집합 HOLD/명시적 scalar tuple 비교로 수정하고 회귀를 추가했다. 세 수정은 Claude ANSWERED 재확인. 별도 inventory utility의 빈 집합 MATCH 잔여도 HOLD로 수정했다. 전체 check PASS. 운영 원천 실패는 테스트 통과로 대체하지 않는다.
- 남음: 운영 writer/소비처 월·연 거리 tuple 표현/정책 미확인 표시/기존 정책 자동 노출 방지, exact backup+적용 전후 readback, F01/F86·ERP.com·화이트라벨·Admin 소비처별 대사. 기존 RP031 withdrawal와 Sheet 원천 ingest 제외는 유지한다. helper/test 통과는 재노출 완료가 아니다.
- next_start_here: `docs/IANCAR-ONE-API.md`의 1차 사용자 결정 및 ONE job `--phase-one`을 따른다. 신선한 전체 source를 다시 검증하고 같은 sourceDigest로 적용안을 고정한 뒤 별도 운영 승인 경계를 거쳐 발행한다. 같은 대수라도 missing/extra/duplicate/status/rate mismatch 중 하나가 있으면 HOLD.

## 2026-09-30 손오공 사진 — 영업자 실제 경로 복구

### 최신 재검토 및 실행 경계

- 2026-10-01 사용자 직접 지시: 티카 픽업의 Google Sheet 이동 링크는 `tica_link` 원본 그대로 유지하고 관련 수정을 main에 병합한다. `sheetPlateLink`의 비픽업 갤러리 분기와 픽업 T카 분리는 회귀검사로 확인했다. 기존 `사진` 원천도 보존한다.
- Claude 좁은 재검토 본문/exit0/ANSWERED: `HOLD_RESOLVED`, F86 API 마스크·정규화·실제 마스크 모방 시험25개 독립 재현 PASS. 아래 재검토 대기 문구는 이전 이력이다. 최신 main 통합 후 전체1,107 PASS/14 SKIP, sheets25 PASS/build PASS. 운영 시트 readback은 병합과 별개로 아직 미검증이다.
- 최신 main의 RP031 old-Sheet ingest 제외와 snapshot withdrawal guard를 ERP PR546에 그대로 합쳐 보존했다. 티카·사진 변경을 이유로 다른 공급사의 HOLD를 풀지 않는다.

- Claude 최종 독립 검토는 사진 링크/토큰 왕복과 Kakao 관련 10시험을 확인했지만 F86 온라인 조회가 글꼴 증거를 누락하는 상류 결함을 찾아 engine `53b8c18e`를 HOLD했다. 운영 pin/apply는 실행하지 않았다.
- 상류 Data `bbe6df8d26531b9af9cdbe9b60f864ae4deab7b4`에서 API fields mask와 정규화의 글꼴 보존을 수정하고, mask를 실제 적용하는 F86 온라인 apply/readback/2회째 쓰기 0 시험을 추가했다. sheets 25 PASS, 전체 Vitest 1,045 PASS/14 SKIP, build PASS. 좁은 Claude 재검토 대기.
- 기존 bridge engine `99a27c90347579e5086b9a538e28e3384f31820f`는 위 정본을 manifest와 함께 재vendor했으며 photo audit에도 동일 origin을 전달한다. `check:sync`/typecheck PASS. ERP PR546 pin 후보 `00032075`는 같은 origin `https://freepasserp.com`을 명시한다. source-contract 24공급사/schedule-map PASS.
- Kakao 실제 구조 조회 API에는 아직 `vehiclePhotos` 생산자가 연결되지 않았다. PR43 도구의 `NOT_QUERIED`는 사진 없음이 아니라 미조회다. 응대 규칙은 기존 ERP 실제 갤러리를 우선 확인하도록 고쳤지만 master 채택/실제 세션 및 API adoption은 미완료다. Data reference 계약을 legacy shadow의 새 직접 Firestore 경로로 우회하지 않는다.
- 직전 승인 대상: F01/F86 손오공 차량번호 링크를 기존 ERP 전체 갤러리로 변경하고 자동 갱신에도 유지. F86에서 연결되는 ERP 상품 화면에는 판매 요금도 보인다. 이 범위를 확인받은 뒤 reviewed pin/준비 회차/정확한 ready_run_id apply/새 readback/실제 클릭을 수행한다. 승인 전 **운영 완료 아님**.
- 아래 기록의 `53b8c18e`/`6b86d655`는 이전 후보 이력이며 최신 후보는 위 두 revision이다.

- 목적: ERP에 이미 있는 사진을 다시 공급사에 요청하지 않고 영업자가 실제로 찾고 전체 갤러리를 확인하도록 한다.
- 증거: production run `36679486202`, snapshot `20260930065134865-67357865edf8`. 손오공 비픽업 41대 중 직접 차량사진 36대/805장, 폴더 링크만 2대, 직접사진/링크 미제공 3대. F86 `손오공상품 41대` 41행을 차량번호로 대조: 사진 칸이 빈 11대 중 8대는 ERP 직접 사진이 있다. 모든 36대 대표 URL HTTP200/image, 36개 ERP 공개 갤러리 링크 HTML에서 같은 차량 식별 확인. 표본 20장 실제 확대/전환 확인. 전체 805장 이미지 내용/최근 촬영은 미검증.
- 원인: 기존 sheet bridge `sheetPlateLink`가 `image_urls`를 무시하고 `photo_link` 첫 주소만 연결한다. 대표사진 PR493은 CLOSED/미병합이라 live에 대표사진 열도 없다. 카톡 최신 행동 정본에는 사진을 데이터 미제공/공급사 질문으로 포괄 열거한 부분이 있다.
- 변경: PR260 reference `vehiclePhotos` 계약 + 기계 시트 정본의 사진 탐색 규칙. 기존 pinned engine의 순수 링크 투영을 복구하며 새 writer/토큰/원천/다운로드 기능은 만들지 않는다. Kakao 기존 구조 조회/직접 응대 도구에 사진 상태 보존과 photo-first 규칙을 추가한다.
- Claude: 두 번 읽기 전용 독립 검토, 본문/exit0/ANSWERED receipt 확인. origin 하드코딩을 제거하고 실제 36대 링크 왕복을 확인했다. 과거 engine reader와 현재 deployed reader의 key lookup 차이는 실제 운영 응답으로 대조한다. 파일 다운로드 복구 권고는 2026-08-30 사용자 결정에 반하므로 반영하지 않는다.
- 추가 검증: 기존 engine vendor drift는 Data `52a11c5` 정본 재동기화와 manifest 해시 갱신으로 복구, 전체 `check:sync`/typecheck PASS. 같은 snapshot 62,008칸 비교에서 차량번호 링크 36칸만 변경/다른 칸 0건. 운영 API에서도 같은 차량 36대의 사진 URL 805개가 정확히 일치했다(805장 이미지 내용 검증을 뜻하지 않음). Kakao 사진 관련 10개 시험과 Windows 실제 fixture PASS; baseline master의 전체 시험 실패 52건은 별도 잔여로 유지한다.
- HOLD: 운영 pin/시트 변경 직전 승인과 새 F01/F86 readback, AI Ops master 채택 및 실제 세션 채택, reference API 배포/adoption. 최종 Claude 검토 대기. 전체 시험 baseline 실패를 이번 사진 변경의 PASS로 숨기지 않는다.
- next_start_here: engine `53b8c18e2c9143ace2c26f0349fc959d61a28b19`, 운영 pin 후보 `6b86d655`/ERP PR546 (`work/freepass/sonogong-photo-pin-20260930`), AI Ops `24538b3`/PR43을 이어서 검토한다. PR545는 기존 branch 규격 오류로 닫고 동일 수정 PR546으로 대체했다. 승인 질문은 F01/F86 손오공 차량번호 링크→기존 ERP 전체 갤러리와 자동 갱신 유지에 한정한다. 현재 운영 writer pin은 `e6727ff04fcf98380701fa6360c36f313e0e321f`다. 순수 코드/계약 테스트 PASS를 live 완료로 확대하지 않는다.

<a id="data-start"></a>

## 2026-10-01 이안카 수정 API 재반영 요청 — NOT PUBLISHED / HOLD

- 최신 사용자 결정(예약): `RESERVED`는 공통 표시 **계약중** / 호환 status_kind **선점**, available=false. 원천 RESERVED를 보존하며 실제 계약 생성/계약락 설정은 하지 않는다. 기준 revision `f4a3cac`; 기존 ONE adapter/test/API 계약만 확장했다. `projectIancarOneReservation`은 표시 helper이며 아직 발행 writer에 연결되지 않았다. 전량 수집·정책 변환·ERP/F01/F86 readback HOLD는 그대로이며 next_start_here는 아래 publication 준비 경로다.
- 예약 규칙 검증: 전용28 PASS/build PASS/diff 검사 통과. 독립 Claude ANSWERED/exit0는 원문 보존·available=false·계약 사실 미생성에 동의했고 행 stale 의존을 지적했다. capture.readyForRawIngest와 envelope stale로 수정하고 실제 list parser 및 provider stale=false인데 시간 만료된 응답 차단 회귀를 추가했다. 수정 후 Claude 재검토는 미실행이며 테스트를 실반영으로 확대하지 않는다.

- 목적: 사용자 최신 지시는 수정된 ONE API를 ERP와 F01/F86 두 시트에 반영. 재노출 지시는 받았지만 원천 전량·요금 변환·소비처 대사 완료로 확대하지 않는다.
- 대상: main `553791243e5464d577a6cd7016f6d416c0d9b12d`; 이번 준비 변경은 기존 adapter/job/test 확장이다. Academy 처음 revision mismatch HOLD는 기존 registry-refresh 원격 관측으로 해소했고 READY receipt를 확인했다. 신규 adapter/writer/scheduler는 만들지 않았다.
- 확인: API 110대 차량번호 유효/중복0, 기존 RP031 301문서의 고유 차번호301 중 exact match89·신규21. 관측 상태 AVAILABLE102/RESERVED1/UNAVAILABLE5/PREPARING2. list/details/availability의 `synced_at`과 `stale`를 각각 보존한다. 존재하지 않는 차량의 rates는404였으며 요청 경로 귀속만으로 provider-echo와 같은 등급을 선언하지 않는다.
- 준비 코드: `collectIancarOneFullFacts`는 차량번호·ID·상태·요금 기간/거리/통화/VAT/보증금/조건버전·중복 조합과 시작/끝 inventory를 검사한다. 고정3 worker이며 503/429를 성공으로 숨기지 않는다. `--full-facts`, `--save-private`는 읽기/비공개 증거 보존용이고 상품·시트를 쓰지 않는다. 관측 시각은 RAW에 보존하되 provider fingerprint에서 제외한다.
- 원천 실패: 첫 전량 수집은 `IANCAR_ONE_DETAIL_AVAILABILITY_DRIFT`로 종료. 후속110대 상세/availability 대조 중 원천이 `02:14:28.979Z`→`02:29:35.599Z`로 갱신됐고, stale 응답이 AVAILABLE을 UNAVAILABLE로 내렸다. 이 mixed-window 결과를 공급사의 영구 재고 오류로 확정하지 않는다. 새 시각 전량 재시도는25대 진행 후 HTTP503으로 실패(requestId `7cc85252-38f9-48e3-95e0-a32a28132623`). 이후 좁은 표본 상세/availability/rates는 정상으로 회복됐지만110대 전량 성공의 증거가 아니다.
- 검토: 최초 로컬 Core는 본문/exit0이 있으나 ANSWERED receipt 없는 구버전 실행기여서 정식 게이트 통과로 세지 않는다. deploy Core 좁은 검토는300초 REVIEW_TIMEOUT. 함수 범위 재검토는 본문/exit0/ANSWERED를 받았고 captured_at 체크섬 churn과 full-facts 재고 권한 혼합을 지적했다. 요청시간 fingerprint 제외 회귀와 rates/조건/사진 권한만 선언하는 별도 `:full-facts` sourceId를 반영했다. rates coverage는 UNKNOWN이며 재고 FULL+COMPLETE head를 대체하지 않는다.
- 최종 좁은 재검토: 수정3항목에 대해 본문/exit0/ANSWERED, 준비 코드만 PASS·ERP/시트 NOT_DONE을 확인했다. 전용23검사 PASS, 최종 전체 check 1097PASS/14SKIP·build PASS. SKIP과 테스트를 운영 반영 증거로 세지 않는다. 새 Firestore 재조회는301건/listable0/출고불가301, ERP `?p=RP031` HTTP200/count0이었다.
- 남음: 전체 source window 성공, rates scope/완전성 근거, 월/연 약정거리 손실 없는 consumer mapping, 기간별로 다른 보증금 출력, 정책 조건별 provenance, API 전용 reviewed compatibility applier와 새21대 stable identity, 기존 RP031 ingest exclusion 유지한 snapshot guard 개정, ERP·각 채널·Admin·F01/F86 실제 readback. 현재 products/정책/시트/운영 workflow 쓰기0, 삭제0. 기존 재고 비노출 유지.
- next_start_here: 기존 `src/adapters/iancar-one-api.ts`/`src/jobs/collect-iancar-one-api.ts`의 full-facts read를 새 fresh window에서 재검증. source와 rate table capture가 성공하기 전 withdrawal guard를 제거하거나 옛 Sheet 재고를 복원하지 않는다. API key는 Secret Manager에서 프로세스 메모리로만 읽는다. 재수집 성공 후에만 verified raw evidence를 바탕으로 publication 계획을 독립 검토한다.

## 2026-10-01 사용자 지시 — 이안카 API 검증 전 임시 노출 중단

- 목적: RP031 이안카만 ERP/Admin 판매 노출과 F01/F86 출력에서 중단. 원본·계약·다른 공급사는 삭제하거나 초기화하지 않는다.
- 대상 revision: Data main `291cfb0` 위 최소 변경. ERP4 bridge main `a5011619ad3ecf5e02df5f6916fca384d5dd5fc8`는 RP031 ingest 제외와 과거 스냅샷 재발행 차단을 반영했다.
- 실행기: `src/jobs/withdraw-iancar-publication.ts`. 기본 DRY RUN. 정확한 Firebase target, 301건/노출223건/계약락0, 비공개 원본 백업+재읽기, updateTime 원자 거래, 전체301건 비노출 readback을 요구한다. 변경은 노출 관련 6필드만, 삭제0/금액변경0.
- 검증: 독립 Claude 검토 ANSWERED(전체 최초 요청은 TIMEOUT이며 합격 아님). build/전체 check 통과, 회귀 8건 통과. 프로젝트 target 명시 검사 보강. 적용 후 실패는 자동 재실행/복원이 아니라 현재 상태 재조회한다.
- 운영 적용: 실행 중 회차 `36797976786` 취소·종료 확인 뒤 one-shot `a8676cf1-9f32-48b7-a8b4-6ffa0a85b625` 적용. 원본301 백업,223 노출 중단,삭제0/계약변경0. 새 조회301/301 출고불가·listable0. 비공개 백업은 사용자 `.codex/private/freepass-data-iancar-withdrawals/`에 있으며 원문은 Git에 없다.
- 소비처 관측: ERP 공개 `?p=RP031`와 eancar 채널 HTTP200/count0. 등록11채널 plain/uniplan/freepassmobility/haheoho/eancar/chashoong/krautoplan/withautoplan/ksautoplan/carping/siauto 각각 HTTP200/이안카0(일시503은 실패로 기록하고 직렬 재조회). Chrome 인증된 Admin 이안카 검색은0대·조건에 맞는 차 없음, 기존 접수472건 보존.
- 최종 검증 revision: Data `b552696032ea05de8f0febd3c2ec52df3005d453` 전체 check 1090PASS/14SKIP. ERP4 workflow `a5011619ad3ecf5e02df5f6916fca384d5dd5fc8`, engine pin `e6727ff04fcf98380701fa6360c36f313e0e321f` 유지.
- 시트 적용 완료: 준비 `36798258460` SUCCESS → 해당 ready_run_id로 apply=true/ALL `36799142438` SUCCESS. 원자↔F01↔F86 대조·사진 링크 감사 통과. 커넥터 새 조회에서 두 상품리스트 `10.01 10:01 상품리스트 211대`, 공급사 `BQ2:BQ232`/`BQ2:BQ242` 실제211행·이안카0. F86 이안카223대 projection 탭 제거, 나머지18탭 유지. 원본301과 복구 백업 유지; 원천 데이터 삭제 아님.
- 실제 화면 확인: 인증된 Chrome F01/F86 표시·탭·헤더·표준/레트로 유지, Admin 이안카 검색0대. 긴급 snapshot-only 추가 경로는 검토 중 준비 회차가 완료되어 반영하지 않았으며 현 main 변경으로 계산하지 않는다.
- 현재 단계: 이번 RP031 임시 노출 중단은 원자·ERP/11채널·Admin·F01/F86 readback 완료. API 연동 완료 또는 새 API 재고 공개 완료라는 뜻은 아니다. 준비 과정의 통상 원천 갱신은 아이카83→84,픽업157→156을 반영했으며 다른 공급사 전체 셀 불변을 주장하지 않는다.
- next_start_here: RP031 노출/기존 Sheet 수집 제외와 과거 스냅샷 차단 유지. 재노출은 API 차량 식별·요금 범위·신선도 검증 및 별도 사용자 지시 이후만. 먼저 current main/workflow pin과 현재301건 비노출을 재조회한다.
- 미완 API full-facts 변경 3파일은 `C:\dev\worktrees\freepass-data-commission-audience-20260930`에 보존, 현재 main에 반영하지 않았다. 공급사 원문이나 비밀키는 Git에 저장하지 않는다.

## 데이터 업무 시작점 — 사람·AI 공통 안내

**프리패스 데이터를 이해하거나 이어서 작업할 때는 이 절부터 읽는다.** 이곳은 문서와 증거를 찾는 고정 안내이며, 아래 날짜별 기록은 당시 관측·변경 이력이다. 최신 사용자 지시와 현재 원천/코드가 과거 기록보다 우선한다.

처음에는 다음 세 가지만 확인한다.

1. **값의 뜻:** [상품·정책 의미 사전](COMMERCIAL-DATA-CONSUMER-ROLLOUT.md#policy-dictionary)에서 단위·기준액·주기·자격·예외를 읽는다. 같은 10도 10원/10만원/10%일 수 있으므로 숫자만 해석하지 않는다.
2. **업무와 정본:** 아래 질문별 안내에서 담당 문서를 고른다. 코드·계약은 GitHub, 현재 업무값은 지정된 운영 원천, 화면 전달 여부는 해당 소비처의 실제 응답이 근거다.
3. **현재 확인 범위:** 아래 미해결 항목과 해당 업무의 최신 handoff를 읽고 revision·관측 시각·검증 범위를 확인한다. 문서가 있다는 것과 데이터가 정확하다는 것은 별개다.

AI의 저장소 진입 순서는 [AGENTS.md](../AGENTS.md)를 유지한다. 업무 지식을 복제한 새 안내·사전·원장을 만들기 전에 아래 기존 정본을 확장할 수 있는지 확인한다.

<a id="data-reading-map"></a>

### 무엇을 알고 싶은가 → 어디를 보면 되는가

| 질문 | 먼저 볼 정본/안내 | 확인할 증거와 경계 |
|---|---|---|
| 기간별 선계산과 Admin 수수료 coverage는 어디서 읽는가? | [Admin 내부 기간별 경제조건](READ-RUNTIME.md#admin-내부-기간별-경제조건--2026-10-03) | Canonical 저장 시 계산, Admin 읽기만; 운영 backfill/재발행 미실행 |
| 프리패스 수수료와 공급사/영업채널 연동은 어떻게 다른가? | [수수료 연동 기준](READ-RUNTIME.md#수수료-연동-기준--사용자-결정-2026-09-30) | 기본은 지급수수료. 상대별 helper PREPARED, 외부 API와 scope 연결은 미구현 |
| 상품·정책의 숫자와 문구가 무슨 뜻인가? | [Commercial Data Catalog](COMMERCIAL-DATA-CONSUMER-ROLLOUT.md#policy-dictionary) | 72항목 의미. 공급사별 실제 값·예외·효력일은 원천으로 대조 |
| 접수·계약·인도·수수료 정산은 어떻게 연결되는가? | [업무 데이터 연결 지도](BUSINESS-DATA-CONNECTION-MAP.md) | ID/버전/스냅샷 관계와 업무 소유권. 실제 계약 확정·수금·지급을 별도로 확인 |
| 어떤 데이터가 있고 어떤 경로로 접근하는가? | [데이터 도메인 카탈로그](DATA-DOMAIN-CATALOG.md), [접근 Gateway](DATA-ACCESS-GATEWAY.md) | 제공 상태·권한·계약과 조회 영수증. 내부 collection 경로를 공개 계약으로 사용하지 않음 |
| F01/F86·ERP·화이트라벨·Admin에 잘 전달되는가? | [소비처별 사용 계약](F01-F86-ERP-PUBLICATION-CONTRACT.md), [소비처 런타임](ERP5-CONSUMER-RUNTIME.md) | 소비처별 release/snapshot·필드·실제 readback. 한 곳 성공을 전체 성공으로 확대하지 않음 |
| 공통 입력 UI와 수정 소유권은 어디에 고정됐는가? | [공급사 RUNBOOK](SUPPLIER-INPUT-SHEET-RUNBOOK.md) | supplier-input-sheet-spec.v1.json uiOwnership; 입력·머리글·종합·helper 소유권, 관리자 우회/자동 감시 HOLD |
| 시트 모양·열·숨김 규칙은 무엇인가? | [시트 규격](F01-F86-SHEET-SPEC.md), [실행 runbook](F01-F86-SHEET-RUNBOOK.md) | 기계 정본 `contracts/f01-f86-sheet-spec.v1.json`. 표시 검사는 원천 최신화 검사가 아님 |
| 공급사 수집 공통 규격과 공급사별 차이는 어디서 보는가? | [FreePass Data 원본 직접 수집기](NATIVE-SOURCE-COLLECTOR.md#common-supplier-adapter-contract--2026-10-02), [직접 연동 5곳 점검](NATIVE-SOURCE-COLLECTOR.md#supplier-direct-status) | 공통 RAW 계약과 공급사별 요금/사진/계산 입력·Scheduler 설계. 10-03 관측은 당시 증거이며 native transport·운영 전환 완료가 아님 |
| 원본을 어떻게 읽고 오류·갱신을 확인하는가? | [ERP5 캡처](ERP5-SOURCE-CAPTURE.md), [Source run 안전 규칙](SOURCE-RUN-SAFETY.md) | readTime·digest·전체 범위·갱신 run·accepted head. schedule/종료 성공만으로 최신성 판정 금지 |
| 어디까지 구현·운영되었고 무엇부터 이어가는가? | [Implementation Status](IMPLEMENTATION-STATUS.md), 이 문서의 업무별 날짜 기록 | CODED/TESTED/PERSISTENCE/DEPLOYMENT/CUTOVER를 구분. 현재 main·진행 PR과 대조 |
| 프로젝트 책임과 설계 기준은 무엇인가? | [승인 Architecture v2](ARCHITECTURE-V2-APPROVED.md), [Issue #24](https://github.com/freepass-creator/freepass-data/issues/24) | 설계 기준과 최신 도메인 소유권 결정 구분. 과거 charter를 후속 승인보다 우선하지 않음 |

### 원천과 비공개 증거를 찾는 방법

공개 저장소에는 사전·계약·검증 코드·비식별 결과만 둔다. 공급사 원문 위치와 세부 조건, 차량/고객/계좌 식별자는 권한 있는 증거에서 확인한다. 이 안내 자체가 접근권한을 부여하지 않는다.

- **현재 운영값:** 위 해당 도메인의 원천 registry/계약에서 위치를 확인하고 승인된 연결로 다시 읽는다. 파일·탭·범위·관측 시각 또는 source revision을 고정한다. 과거 캡처를 오늘의 정답으로 사용하지 않는다.
- **이 PC의 상품·정책 감사 이력:** 권한 있는 작업자만 사용자 홈의 `.codex/private/freepass-data-source-captures/<run>/`에서 `summary.json`의 `readTime`/`sourceDigest`를 먼저 확인한다. 같은 run의 `capture.json`, `policy-diagnostic-summary.json`과 추가 대사 자료를 함께 사용한다. 보고서가 보존된 run에는 `commercial-policy-audit-full.md`가 있다. 모든 run에 모든 파일이 있다고 가정하지 않는다.
- **다른 PC/권한 없는 AI:** 위 로컬 자료가 없으면 현재 업무 담당자에게 해당 감사의 관측 시각과 범위를 제시하고 승인된 증거 전달 경로를 확인한다. 공유 저장소 동기화가 완료됐다고 가정하거나 원문을 공개 Git에 복사하지 않는다. 접근 불가는 `HOLD_EVIDENCE_ACCESS`로 기록하고 공개 계약·코드 검토는 계속할 수 있다.
- **판정 순서:** 원본·승인 효력 → 같은 버전의 재현 가능한 대사 → 실행 로그·소비처 readback → AI 설명. 자료가 충돌하면 승인·효력·범위를 확인하기 전 임의로 하나를 선택하지 않는다.

<a id="data-open-items"></a>

### 미해결 항목 — 2026-09-30 상품·정책 감사 기준

아래는 해결 완료를 재확인할 때까지 유지하는 점검 목록이다. 특정 상품의 현재 오류 건수나 전체 데이터 상태를 보증하지 않는다.

| 이어서 확인할 항목 | 출발 문서 | 완료라고 말하려면 |
|---|---|---|
| 공급사 원문의 자격·요금·보험 조건 충돌 | [상품·정책 사전](COMMERCIAL-DATA-CONSUMER-ROLLOUT.md#policy-dictionary) | 적용 상품/계약자·효력일·승인 원문을 고정하고 충돌 해소 근거 확보 |
| 정책 연결·활성 여부·문자열 단위 해석 | [ERP5 캡처](ERP5-SOURCE-CAPTURE.md) | UID/코드/공급사 namespace와 효력 확인, 0/누락/미해석 구분, 같은 캡처 전후 검증 |
| 연령별 조건 누락·소비처 기본값 보충 | [소비처 사용 계약](F01-F86-ERP-PUBLICATION-CONTRACT.md) | 공개 가능한 필드 계약·출처를 확인하고 실제 응답/견적 경로를 재조회 |
| 신규 재고·정책 본문 갱신 | [Source run 안전 규칙](SOURCE-RUN-SAFETY.md) | 실제 실행 모드·원천 전체 범위·신규 행·정책 내용과 accepted head 대사 |
| 접수·계약·정산까지의 업무 연결 | [업무 연결 지도](BUSINESS-DATA-CONNECTION-MAP.md) | 계약 시점 스냅샷·실제 입출금·승인/취소/환수 증거를 해당 권한으로 별도 검증 |
| F01/F86·웹·화이트라벨·Admin 전체 전달 | [소비처 런타임](ERP5-CONSUMER-RUNTIME.md) | 등록된 각 소비처의 버전·필드·권한·실제 출력 readback 확보 |

### 다음 사람·AI에게 남길 기록

작업이 끝나면 기존 업무 문서를 갱신하고 아래 날짜 이력에 `목적 / 대상 revision·원천 관측 시각 / 변경 / 실행한 검증 / 남은 HOLD / next_start_here`를 남긴다. `next_start_here`는 읽을 문서·절과 다음 검증을 지정한다. 임시 로컬 위치만 남기거나 “테스트 통과”를 업무 전체 완료로 쓰지 않는다. 정본 문서가 이동하면 이 표와 README/AGENTS 링크도 함께 갱신한다.

### 이 안내의 유지 범위

2026-09-30 사용자 요청에 따라 기존 README·AGENTS·이 문서·상품정책 사전을 연결했다. 기준 revision은 `002cb95`, 이전 의미 사전/진단 병합은 [PR #256](https://github.com/freepass-creator/freepass-data/pull/256)이다. 이번 정리는 탐색·인계 개선이며 운영값·업무 권한·정책·스케줄 변경은 없다. 아래 날짜 이력은 삭제하거나 현재 상태로 재해석하지 않는다.

---

## 날짜별 작업 이력

### 2026-10-07 지휘·조정 최초 취합 / 단일 쓰기 담당 인수

- 공통시트관리 01a10ef3-e5bf-7660-bf5e-773c20c77465가 라이브/정본실행코드/공유파일 단일쓰기 담당 유지. 현재 실행중라이브쓰기0, 작업폴더52d372cba3652e71c1a1ec91585e6a71a6195341 clean 확인 후 이 기록만 수정. 점검3채팅은 읽기전용 유지, 보고만으로 라이브 수정 승인 대체하지 않음.
- 조정채팅01a11439-d01c-7ee1-9fa0-75726182c44b 수신보고(이 절에서 별도실측 아님): main72d486dc, PR397 actor-owned branch Canon Guard 차단·ERP398충돌/이전.3·정산399보존 필요. 각 최신head/검사 실제증거는 해당담당의 최신결과로 재확인한다. 과거397 head2c85b55로 실행금지.
- 로컬확인: package.json check:sheets가 shared-sheet-ux.node.mjs를 포함하지 않음. 수동 UX회귀75PASS와 CI필수검사 연결은 별개다. 후속 최소코드수정 후보로 남김(이번조정인수는코드쓰기0).
- 화면담당 수신보고:962머리글/메모·12입력100×74·9pt/날짜 일치, 웰릭스메뉴열기성공, 공급사계정검증HOLD. 종합182행·드롭다운784칸잔존은 판정/변경 추적 중, 값/행/목록 자동복원/삭제금지.
- 남음/next_start_here: 변경추적담당 완료근거 → 조정채팅 중복없이 최소후속배정 → 관리담당이 exact현재정본·검사·라이브수정범위를 검증 후 실행. 조정기록은 기존NEXT만 사용, 새원장/예약/branch없음.


### 2026-10-07 대표 요청 — 공통시트 지휘·조정 창구

대표가 오더받을채팅을 정해 각담당에게 전달하고 중복없이 모든업무를 아우르라고 직접 지시. 기존프로젝트에 [GHD] FREEPASS-DATA · 공통시트 지휘·조정(01a11439-d01c-7ee1-9fa0-75726182c44b) 생성, 기존5담당 상태/범위 확인 및 진행중업무 재실행없이 오더배정/검증/취합하도록 초기오더 전달. 관련 내부담당 메시지·상태조회 허용, 외부발송/배포/권한/운영쓰기 승인 대체 아님.

창구: 조정채팅에서 목표·범위·담당1명·의존성·완료조건을 정해 필요한 담당에게만 전달. 기존목적이 진행중이면 새 작업 대신 보완오더. 공유파일/Git/라이브 실행은 단일담당, 현재 공통시트 관리 담당만 시트쓰기. 정본통합/화면검증/변경추적3채팅은 읽기전용, ERP기존담당범위 유지. 수신/실행/검증/완료/보류 구분, 전달성공=완료 아님.

새 원장/branch/worktree/DB/예약/상주프로세스 없음. 기존NEXT와각채팅 결과를 공용재개점으로 사용, 조정채팅은 파일쓰기 전에 관리담당과 조정. 상시자동배정·감시는 실제설정없음. next_start_here: 조정채팅 최초5담당 현황표 → 기존3점검채팅 최초결과 → 필요후속은 단일담당 배정.


### 2026-10-07 대표 요청 — 공통시트 관련 업무 채팅3개

기존 프로젝트·작업선 재사용, 새 브랜치/worktree 없음. 세 채팅은 읽기전용 실제점검과 구체적인 다음행동을 담당하며 시트/공유폴더파일/인덱스 변경은 공통시트 관리 담당만 한다. 삭제금지·단일입력정본·최신 UI2026-10-07.3 유지.

| 채팅 | ID | 범위 |
|---|---|---|
| [GHD] FREEPASS-DATA · 정본 통합 | 01a11436-339a-7223-956f-2f114892e64c | PR397/main/ERP 작업선 최신규칙·CI·충돌·통합순서 점검, 직접 merge 없음 |
| [GHD] FREEPASS-DATA · 입력 화면 검증 | 01a11436-3867-7c03-b7b9-e00e55c7e065 | 필터/경고형보호/9pt/날짜/공급사용메모·목록 검증, 데이터/필터조건 쓰기 없음 |
| [GHD] FREEPASS-DATA · 시트 변경 추적 | 01a11436-40a1-7cc1-b1b9-92aa84bc618e | 종합행감소·동시본문변경의 writer/실행로그 조사, 자동화/행복원/DB 쓰기 없음 |

기존 ERP 연동01a10f56-3680-7b91-8337-a1e907fc391a 범위 유지. 신규3채팅 create_thread 영수증 확인, 최초진행 snapshot 확인은 별도이며 업무완료로 세지 않는다. next_start_here: 각 채팅의 최초실측결과를 해당채팅에서 확인하고 라이브수정 필요사항은 이 공통관리채팅에서 단일실행한다.


### 2026-10-07.3 공급사용 머리글 메모 — 현행

- exact implementation commit `0641316457cbd52a997f637785ddff4783b60fad`, 기존 PR397.

대표 지시: 입력 안내를 먼저, AI 문구 제외, 관리 설명은 아래 짧게. uiOwnership.supplierHeaderNotes의 74개 안내를 각 머리글 메모 첫 부분에 두고, 마지막에 관리 안내 한 줄만 둔다. 정책 의미는 기존 Commercial Catalog를 따르며 새 정책 사전/공급사 조건을 만들지 않는다. planSupplierHeaderNotes는 정확한 전체 머리글을 확인하고 note 필드만 쓴다. 이후 UI 계획기도 같은 메모를 사용하여 과거 기술 문구를 복원하지 않는다.
실제13탭×74열=962개 메모 새 조회 모두 일치, 머리글 값 변경0, 본문값/수식/행/열/보호/필터 쓰기0. 비공개 전후 보존.75tests PASS. 정본 baseline2026-10-07.3. UI 렌더는 미확인이나 메모 내용은 API 되읽기로 확인. next_start_here: RUNBOOK 이 최신 절 → spec supplierHeaderNotes → planSupplierHeaderNotes.


### 2026-10-07.2 현행 수정 — 필터와 머리글 보호 충돌

사용자 웰릭스 실제 화면에서 보호된 셀/개체 편집 오류 확인. 이전 .4 강제 머리글 보호가 기본 필터 사용을 막으므로 현재는 경고형 보호(warningOnly=true)로 전환한다. 이 최신 절이 이전 강제 보호 설명보다 우선한다. 기본 필터 사용 우선, 머리글 수정은 경고이며 권한 강제 차단으로 표현하지 않는다. AI 실행기의 표시필드 허용·삭제/행축소 금지는 유지한다.
라이브13개 헤더 보호의 동일 ID·range를 유지하고 warningOnly만 변경, 적용 응답 모두 true 확인. 입력값·행·열 삭제 요청0. 정본 baseline2026-10-07.2, 계획기도 경고형을 재생성하도록 수정,74tests PASS. 비공개 전후/요청 영수증 보존. 사용자 계정 실제 필터 재시도는 아직 미확인; 다음은 웰릭스 필터 동작 확인.


### 2026-10-07 필터 오류 조사 / 전체 열 범위 정정 — PERSISTENCE VERIFIED / UI HOLD

- 사용자: 필터 시 문제가 발생했다고 표시. 정확한 탭/동작/문구 clarification 대기. 현 브랜치 e4a28a1e92ea6de99d9025ab7eed6624fcb21edd, main e486d0e 확인; 신규 branch/merge 없음.
- 기존 보호13개 현재 full metadata 재확인. 모두 pyh관리계정 편집가능. 기본 메타데이터에 보호필드가 없는 것을 부재로 보지 않는다. 원인으로 단정하거나 보호 해제하지 않음.
- 실제 불일치: 종합 basicFilter A1:BJ174(62열), 현재74열·184그리드. 기존 criteria 출고불가 숨김 유지, setBasicFilter 한 요청으로74열·그리드전체 설정. 공급사12탭100×74는 정상범위, 수정0. 삭제/입력값/수식 요청0, 첫 full metadata 조회용 A1 폰트9 재설정1요청 별도.
- 새 조회에서 전체74열·그리드182 필터 범위 확인. 관측 사이 종합 행수184→183→182와 본문2714좌표 변화, 전후 값동일 검증 불성립. setBasicFilter에는 행삭제/값변경 없음; 외부 작업/동시편집 가능성 HOLD, 자동 원복 금지. 비공개 before/after 증거 tmp 보관.
- 정본 baseline2026-10-07.1 filterPolicy·planFilterRangeRepair·테스트74PASS. 첫 academy 검사 DIRTY_WORKTREE(내 준비코드) HOLD, 준비코드 커밋 후 실제 READY receipt 확인하고 라이브 실행.
- HOLD: 사용자 실제 오류 재현·해소 미확인, 브라우저 시트탭없음, 계속 줄어드는 종합 작업주체 미확인, capacity300불일치. 보호 관련 가설과 확인된 범위 오류를 구분한다.
- next_start_here: 사용자 exact 탭/동작 답 → 보호/필터 조건·세션 계정으로 재현. 범위만 맞췄다고 필터 오류 완전해결 선언하지 않는다. 동시 입력/삭제 원인 조사 전 값·행 복원/반복 쓰기 금지.


### 2026-10-06 AI Core·AI-OPS 실제 학습과 공통시트 적용 체크포인트

- learning implementation commit cb2717e65324702a6a9e8fb38f3f35ff8e859eca. B3Q 기존 상황실 thread01a10e59-61f0-75f0-9516-b08e71622caa에 send_message_to_thread 성공 영수증 확인. 수신 전달 완료이며 담당 인수/main 통합은 아직 미확인.

- 읽은 정본: C:/dev/ai-core AGENTS.md → WORK_READ_FIRST.md → docs/AI_WORKING_STANDARD.md, Core revision6088a502915408853d2607bbea56d7d57a2d450c. C:/dev/ai-ops AGENTS.md → docs/README.md → docs/AI-OPS-PC-세션-규격.md 및 GPT-인수인계-20261006.md, Ops revision24d11d2b6305f60205ece9961dfafc37e1ae7738. 문서를 복제하지 않고 이 경로로 이어 읽는다. 현행 GHD 오더 → B3Q 상황실 경로가 과거 B3Q/Claude 고정 표기보다 우선한다.
- 실제 활용: Core scripts/duo.mjs inbox 실행(열린 과거2건은 타 업무, 본 세션이 인수하지 않음). academy-start.mjs --task 공통시트 삭제 금지·규격 정합 및 기존 인계 기록 --root C:/dev/freepass-data --track document: READY, target acefa2e85571b6b4fcee7b7d7a92e8b3ca3e7d70, blockers0, warnings0, 새 자산 없음. 시작 receipt가 main 반영/시트 적용 완료를 뜻하지 않는다.
- 재사용 실행조건: supplier-input-sheet-spec.v1.json .5 + RUNBOOK 맨 위 및 AGENTS가 공통시트 기준. shared-sheet-ux의 표시 허용 검사, shared-sheet-lightweight의 tab inventory/축소금지, 기존 Node73 회귀 및 NEXT 정확한 commit pin 사용. Google Sheets connector는 이전 실제 live read/write 증거가 있는 pyh 계정 경로를 재사용하며 이번 학습 작업에서 시트 쓰기0. 차종 판단은 ai-ops 차종-기준-한장만, 정책 의미는 기존 Commercial Catalog. bogi.mjs는 기존 정본 숫자 조회 후보이나 이 업무에서 숫자 조회/실행하지 않았으며 접근 가능 판정으로 세지 않음.
- 다른 담당 요청: B3Q 상황실의 기존 Data 검토·반영 담당이 PR397을 현재 main과 비교하여 삭제금지 .5/UI .4 규격·CI·독립검토를 확인하고 통합까지 추적. 목적: 오래된 main/AI/ERP 작업선이 현재 사용자 규칙을 덮어쓰는 일 방지. 완료조건: main의 실제 commit과 동일 규격 되읽기, ERP 기존 작업선에서 동일 정본 수령 확인, 양쪽 NEXT 이력 보존, 겹치는 본문 변경 없음. ERP 구현은 별도 기존 담당 범위, 본 세션에서 중복 구현/병합하지 않는다.
- 요청 없음: 새 DB·예약·상주프로세스·브랜치·카톡/메일 발송·권한 확대·원격 화면 점유. 기존 Data 단일 정본/실행담당 유지, 무거운 통합 검증은 B3Q 담당, GHD 업무 화면 보호.
- 의존성/HOLD: main 미반영·ERP .3 이전 정본, 지속 감시/운영 pin 없음, 종합296 vs300, 보호 현재 inventory 재확인. B3Q 수신은 전송 영수증과 담당 인수/실제반영을 구분하여 추적한다.
- next_start_here: PR397 → 위 삭제금지 감사 exact commit e8bff40939ef2e59fcd7ff6e5a183622d8e8fc68 → RUNBOOK 최신 .5 절. 현재 공유 체크포인트를 이어받고 새 지침/원장/구현을 만들지 않는다.


### 2026-10-06 공통시트 비휘발성·브랜치 정합 감사 / 삭제 금지

- exact safety implementation commit: `e8bff40939ef2e59fcd7ff6e5a183622d8e8fc68`, PR397.

- user: 이제 삭제 금지, 규격 정합·main/브랜치 분기 확인. 라이브 쓰기0.
- main 6df910c74561cf1cfc589abf3fde8fcf02ca347b: UI/규격 lock 미포함. PR397 OPEN, 현재 작업 HEAD845eef7의 규격 .4만 최신. ERP branch 9bb60b6a3efeea4a42a2a6c3f6a23111a8d60542는 .3, UI 소유권 미포함. 별도 런타임4파일 변경과 겹치는 NEXT는 통합 시 양쪽 이력 보존 필요. 자동 merge/rebase/브랜치 삭제 없음.
- 실제 읽기: 12입력100행×74열, 종합296행×74열, 각14개 유한 상태/상품 TEXT_EQ. 962헤더와 표본 날짜/9pt/상태9목록 drift0. 종합300정본과4행 차이는 HOLD, 자동 복구 없음. 보호13개는 이전 적용 영수증 근거이며 이번 기본 metadata가 보호를 반환하지 않아 현재 보호 재확인은 HOLD.
- 빈틈: 과거 열삭제 계획기 및 경량 rowCount 축소/압축 경로가 남아 있음. 최신 사용자 삭제 금지를 정본 .5 destructiveChanges=FORBIDDEN에 기록하고 두 경로를 데이터 접근 전 차단. 현재 UI 적용은 .4 유지, 라이브 쓰기0. 73 Node tests PASS(과거 정책 fixture는 명시적으로 현재 잠금 제외).
- HOLD: PR397 미병합, ERP .3 미동기화, 전체 공급사 본문/금액·정책 audit 미수행(이번 규격 표본 검사), 관리자 API 우회, 운영 pin/자동 감시 미설정.
- next_start_here: PR397의 .5 정본·삭제 방지 코드를 main 통합할 때 현재 main 및 ERP 겹침 확인 후 동일 정본 사용. 오래된 브랜치로 라이브 시트 쓰기 금지. 새 explicit user decision 없이는 삭제/축소 경로 활성화 금지.


### 2026-10-06 공통시트 UI·수정 소유권 고정 — PERSISTENCE VERIFIED

- exact implementation commit: `4e9eceae213367ef8aebd3c75ec4f329c21c0a08`, PR397.

- 대표 최신 지시: UI/UX와 수정 주체 고정, 날짜 yy-mm-dd, 작은 글씨, 인도완료·취소·진행중 표시. 정본 baseline supplier-input-presentation/2026-10-06.4 / uiOwnership.
- main 6df910c 확인, 겹침은 dashboard 감사 산출물만; PR397 기존 공급사 시트 작업 이어감. 입력은 공급사 담당자, 표시 규격은 대표 승인 Data 관리 경로, 종합은 기존 생성 경로, helper는 Data 관리.
- 실제: 13탭 9pt / 날짜 두 열 yy-mm-dd / 머리글 소유권 메모 962칸 / 상태 9개 고정 목록(공급사12탭) / 세 가지 정확한 상태 색 추가. 전체 행 색·수식·정책 드롭다운 추가 없음. 머리글 A1:BV1 실제 보호13개, pyh 관리 계정·Google 소유자 수정 가능, 본문 입력 유지.
- 실행기 scripts/shared-sheet-ux.mjs는 입력값·수식·구조 쓰기 차단, 정확한 inventory·머리글 및 보호 소유권 drift HOLD. before/after와 원본 사본은 비공개 증거로 보존. 새 조회 입력값/수식 차이0, 9pt/날짜 drift0. 72 tests PASS.
- HOLD: 소유자/관리계정 직접 API 우회 가능, 자동 감시 미설정, 실제 렌더/속도 미측정(현재 IAB 탭 없음), 종합 실측296행 vs 정본300행(이번 UI 작업 구조변경0). 공급사 입력 권한을 확인하지 않고 종합/helper 전체를 잠그지 않음. ERP 연결은 별도 세션.
- next_start_here: RUNBOOK 맨 위 UI 현행 규격과 JSON uiOwnership을 먼저 읽고 승인된 표시 계획기 사용. 새 지시 없는 데이터 변환/삭제/탭 복원 금지.


### 2026-10-06 공급사 공통 시트 관리 기준 확정 — CODED / 운영 자동 감시 미설정

- 구현 pin `88004cfe57bd14a4f66714b7b93605d0838e55b5` (PR #397), 관련 시트 검증69/69 PASS. 다음 handoff 커밋은 이 pin 기록만 추가한다.

- 대표 «이제 공급사들 여기서 관리할거니까». 현행 supplierManagement와 버전2026-10-06.3에 공통 입력 권한·기존 시트 대조 전용/자동 덮어쓰기 금지·공급사코드+차량번호 식별·미확인 차이 HOLD·공통 시트/ERP 세션 분리를 기록했다. API/홈페이지 직접 공급사 경로는 변경하지 않음.
- 읽기 대조: 공급사 원본15파일/18코드 및 현재12입력 탭, 추가 F01 주상품 조회. 현재 입력의 실제 차량번호 누락 발견0, J&J 상태2차이·스타2대 원본빈값/공통금액 존재·연식15차이. 표시 차이와 원본 오류 가능성을 구분하며 수정0. absent 스위치플랜8·에스에이30·연카0행은 탭 부재로 별도 HOLD. F01의 실제차량12개 미조회는 게시 조건/검증 HOLD 원인 확인 필요. 정책은 현재 차량 귀속 근거 부족으로 비교 HOLD.
- 비공개 전수 조회 및 차이 기록: checkout 밖 freepass-sheet-comparison-20261006의 snapshots.json/audit.json/비교결과.md. 종합296행 drift 관측/재복원 없음. 이번 관리 결정은 규격/권한 기록이며 라이브 값·서식 변경0, 자동 감시·운영 cutover 완료 아님.

### 2026-10-06 공통 시트→Data→ERP 수집 범위 정합 — CODED / TESTED / 실제 시트 읽기 검증

- 대표 «프리패스데이터에서 공통시트 데이터 잘 연동해서 erp 구성». ERP 대상은 기존 계약의 ERP.com으로 잠정 해석(대상 확인 질문 답 미수신). ERP 소비자 인증/호환 API는 기존 구현을 사용하며 ERP의 별도 원천 writer를 만들지 않는다.
- 구현 pin: `ccc5094ddf54d698e71dd64b45f097c871c6cab5` (PR #397). 이 다음 기록 커밋은 구현 pin을 명시하는 handoff다.
- 현행 기계 정본 버전 supplier-input-presentation/2026-10-06.2. 수집기 및 빈 칸 입력 export를 현재12탭/15코드에 맞췄다. 전체 등록15탭/18코드는 보존, absent3탭은 보고서 HOLD. PARTIAL/COMPLETE coverage와 Domain head 판정 유지; canAssertSourceAbsence=false, 부재로 기존 재고 삭제/판매완료 금지. 없어진 등록 탭이 다시 나타나면 capture는 scope drift로 멈춘다.
- 실제 Sheets connector 조회12탭/171행 전후 effectiveValue 동일, 날짜 실제 값 보존 캡처·정규화 확인: VALID133, 나머지38행은 연식/등록일23·차종확인5 등 차량번호/값 근거 문제로 HOLD. UI 후보를 차종 정본으로 인정하지 않음. 원문·보고서는 checkout 밖 비공개 증거 디렉터리, 운영 쓰기0.
- 검증: 관련 Vitest147/147, 시트104/104, TypeScript build 및 architecture/data-access checks PASS. 전체 Vitest1651 PASS/14 SKIP, runtime-policy watchdog1 FAIL(로컬 Git Bash의 jq 미설치); 전체 PASS로 표현하지 않는다.
- HOLD: 운영 source ingestion/배포/main 병합/ERP readback·cutover 미실행, 운영 신원과 consumer wiring은 이 환경에서 확인 불가. Canonical 미확인38행을 임의 보정하지 않음. 종합은 새 조회296행으로 drift(기준300), 외부 작업 보존을 위해 이번 재복원 없음. 지속 자동 강제·ERP 반영 완료로 확대하지 않음.
- next_start_here: PR #397의 현행 범위 변경 검토 → 운영 수집 dry-run에서 writer/source head/기존 Canonical 대사 → 별도 운영 승인과 인증 신원으로 적용·되읽기 → ACTIVE release/ERP 소비자 읽기 parity 확인. 호환 `/catalog-compat`과 Canonical `/catalog` 전환을 혼동하지 않는다.

### 2026-10-06 대표 공통 시트 규격 잠금 — CODED / TESTED / PERSISTENCE VERIFIED

- 대표 최신 지시로 기계 정본 changeControl과 버전 supplier-input-presentation/2026-10-06.1 고정. 현재12개 공급사 탭·100행/종합300행·앞7개 고정 후보·정책자유입력·노란배경금지·차종연쇄금지·2만km와 향후 동시 변경 절차를 RUNBOOK 현행 절 및 AGENTS에 명시. 문서 중 과거 지시는 이력이며 재적용 금지.
- 전용 실행기는 물리 탭 구성 drift를 쓰기 전에 거절. 외부에서 바뀐 종합290행은 기존300행 결정대로 복원. 입력값/서식/다른 탭 변경0. check:sheets104/104 PASS. 구현 pin `0d1b955aa8f521bcac369d0c5bec6c5f034f4d27` (PR #397).
- HOLD: 자동 감시/운영pin 연결 없음, 열림 속도 실측/화면 검증 및 신규 스타5대 차종·정책 정본 연결은 계속 미완료. 규격 잠금을 운영자동화 완료로 표현하지 않음.


### 2026-10-06 입력 경고·노란 배경 정리 — PERSISTENCE VERIFIED

- 대표 후속: 잘못됨 경고 개선, 노란 배경 제거. 입력 UI 전용 정적 선택 목록을 기존 게시값+실제 기존 표시값으로 구성해 현재 입력 검증 불일치0 확인. 차종 정본·원본 값 변경0, 수식0, 새 자유입력 후보는 재갱신 필요.
- 보이는13탭 노란5908칸 제거(필터행168칸 추가 마무리), 새 조회0. 13탭 userEnteredValue 전후 동일. 전용 계획기/정본/시험 수정, check:sheets103/103 PASS. 자세한 범위와 정본 분리는 SUPPLIER-INPUT-SHEET-RUNBOOK 최신 절. 구현 pin `bb41f0183208846bfd1e5a0c8e744d36780ba440` (PR #397).
- HOLD: 속도 실측/화면 검증 및 이전 스타 신규차종·정책 연결 보류는 유지. 운영 데이터 적재·마스터 승격·다른 공급사 최신화 없음.


### 2026-10-06 스타·스카이 기존 원본 최신화 대조 — PERSISTENCE VERIFIED / 신규 차종·정책 HOLD

- 대표 지시 «스타스카이 오늘 기존 시트에 업데이트 해놨대 그거만 맞춰보자». ERP4 원천 등록과 Drive 현행 파일 제목으로 동일 원본을 확인, 스타재고·스카이재고·운영정책 전체 범위 읽음. 스타재고28대, 스카이재고0대, 공통 스타23대. 차량번호는 공백만 제거해 대조했으며 공급사 원본은 읽기 전용으로 유지.
- 전체 공통 시트 백업 후 스타 및 같은 차량번호의 종합 칸에 요금·주행거리·입고일 변경 반영. 빈 원본 값과 요금 «-»는 기존 유효값을 지우지 않음. 날짜는 기존 serial 형식 유지. 신규5대는 빈 행에 원문·상태·요금·직접 기재된 사실만 추가, 차종4칸은 «확인 필요»로 표시하고 정책을 이웃 차량에서 복사하지 않음. 기존 차종 정정값은 원본의 오래된 정제칸으로 되돌리지 않음.
- 실행:71개 updateCells 요청,251칸. 새 조회에서251칸 모두 요청값 일치. 현재 원본 스카이 재고가0대이므로 숨김 보관 탭 및 관계사명 복원 없음. 그 외 공급사 탭·서식·검증·그리드 쓰기0. 외부 변경으로 종합290행/일부 공급사 탭 삭제 상태가 관측됐으나 이번 scoped 최신화에서는 복원하지 않음.
- HOLD: 신규5대 FreePass Data 차종 정본/정책 연결 및 다음 적재·정정 이력 연결, 원본 연식2000/2020과 기존 정정값 충돌2건, 원본 주행거리 공란1건, 신규 캐스퍼 원본24개월52,000원·36개월48,000원(임의×10 하지 않고 그대로 보존/확인 표시). 차종·정책 전체 연결 완료가 아니다. 개별 원문/전후/쓰기 감사는 체크아웃 밖 비공개 freepass-star-sky-20261006/audit.json 보관.
- 검증 단계: PERSISTENCE VERIFIED(위251칸), 코드 변경/배포 없음. main43201d4 확인. handoff pin `dd76fbcb71c71d5595347faf988b25160e01573f` (PR #397).


### 2026-10-06 대여료 앞 경량 드롭다운·색상, 업체100/종합300행 — PERSISTENCE VERIFIED

- 최신 사용자 지시대로 앞 7항목 고정 목록과 상태·상품 두 열 TEXT_EQ 색을 적용. 현재 입력 14탭 100행, 종합 300행(머리 포함). 값·차종명·금액 유지, 스타 아래 7행은 위 빈 행에 보존. 자세한 실행 정본과 필터 복사 주의는 SUPPLIER-INPUT-SHEET-RUNBOOK 최신 절.
- 코드: dropdownPolicy.lightweight 및 scripts/shared-sheet-lightweight.mjs. 이전 일반 전체 복원·행별 연쇄 빌드/배포는 계속 차단. check:sheets 102/102 PASS. 구현 pin `c5b16437cea0a07aa620d2c8a904553d4118a9c1` (PR #397).
- HOLD: 열림 속도 실측/화면 검증, 외부에서 없어진 연카 입력 탭의 운영 의미. 종합은 외부 갱신으로 95→148행, 이번 작업은 종합 값 쓰기 없음.


### 2026-10-06 공통 시트 전체 자유 입력 — PERSISTENCE VERIFIED / 속도 실측 HOLD

- 대표 최신 요청: 드롭다운과 느려지는 요소를 전부 제거. 원본 전체 백업 후 현재 39개 탭 데이터 검증 전부 제거, 조건부 서식 293개 제거, 숨김 보조 수식 44,955개 제거. 차종/금액/종합 등 보조 탭 외 모든 탭의 userEnteredValue를 백업과 새 조회로 탭별 비교해 동일 확인. 새 전체 조회에서 검증 규칙 0개, 조건부 서식 0개, 보조 수식 0개 확인. 일반 서식/정적 목록/빈 보조 탭은 유지.
- 앞선 A:P 유지 및 행별 Apps Script 설치 방향은 폐기. 정본 disabled/freeText/performancePolicy와 빌드·배포 차단으로 재생성 방지. check:sheets 100/100 PASS. 현재 main 076d32bb98aa516003435ae3fd8b8fd00c26a162 확인. 구현 커밋 `c58649025597987fe1ad0a63b01f9e21f4e40d4b` (PR #397).
- 외부 변경으로 연카 입력 탭 8108이 작업 도중 없어졌다. 최초 원자적 batch는 실패하여 변경 없음, 새 메타데이터로 나머지 탭에 적용. 공급사 구성 변경 및 종합 영향은 HOLD; 이 작업은 탭 삭제/복원하지 않았다. 속도 개선 실측·브라우저 화면 검증은 HOLD.
- 후속 질문: 대여료 앞에만 드롭다운을 두는 방법을 문의. 고정 목록은 보조 수식 없이 가능하나 조건별 연쇄는 행별 갱신과 실측 필요. 재적용 지시 전까지 전체 자유 입력 유지.


### 2026-10-06 공통 시트 차종 행별 드롭다운 — CODED / TESTED, DEPLOYMENT HOLD

- 대표 요청: 조건별 차종 드롭다운은 유지하되, 선택·편집한 행만 갱신해 44,955개 숨김 후보 수식을 걷어낸다. `ai-ops/docs/차종-기준-한장.md` 기준에 따라 마스터 이름·차종 값·제원은 변경하지 않고 게시된 목록만 소비한다.
- 기준: main `076d32bb98aa516003435ae3fd8b8fd00c26a162`, 앞 작업 commit `eba195aa495faa6e9ebd34d4a3eae4c8c0a7c793`, 기존 PR #397/같은 작업 가지에 추가.
- 구현 commit `07f24004bb3548da228444ae94e8f20944a8c094` pushed. 시트 전용99 PASS(신규10), diff 검사 PASS. 실제 게시 목록527키·중복0·제조사17 확인. 비공개 생성 산출물은 이번 작업 PC의 Codex tmp `freepass-cascade-20261006/script-content.json`; 운영 파일 ID·인증을 Git에 복제하지 않는다.
- 구현: bound Apps Script onEdit/onSelectionChange·선택 행 복구 메뉴, 다중 행 붙여넣기, 값 보존·불일치 경고·정확한 workbook/sheet/header binding, 같은 계층 규칙의 API 검증 계획기. 생성/설치 CLI는 운영 ID를 private artifact에만 넣고 기존 코드·trigger 충돌을 HOLD하며 설치 후 되읽기를 남긴다.
- 실제 확인: Sheets 연결 `pyh@teamjpk.com`, 40탭/4,383,859칸/조건부 서식309, 숨김 helper15탭/전체 열 참조 XLOOKUP44,955. 설치 CLI는 `APPS_SCRIPT_AUTH_UNAVAILABLE`로 네트워크·시트 쓰기 전 종료. Apps Script 설치가 가능한 인증 경로가 없으며 Sheets 권한을 대체로 쓰지 않는다. 현재 시트 변경 0, 기존 helper 수식 제거 0.
- 검증: 신규 Node 테스트 10 PASS(계층 부모·미확인 값 보존·다중 행·범위/ID·동시 값 변경·API 생성·기존 script 충돌 보존·인증 없을 때 무쓰기). 운영 이벤트·seed·helper 참조 제거·속도 개선·API publisher 연결은 미검증 HOLD.
- next_start_here: 공급사 runbook의 2026-10-06 추가 결정/운영 전환 순서. 기존 pyh Apps Script API 인증 경로를 확보하고 생성된 private bundle로 설치·이벤트·API 입력 검증을 먼저 끝낸다. 보조 수식부터 제거하거나 설치 코드만으로 완료 선언하지 않는다.

### 2026-10-06 공통 입력 시트 드롭다운 축소·연주행 표기 고정

- 대표 결정: 속도 때문에 대여료 앞(A:P)만 기존 드롭다운 유지. 첫 대여료 `1개월`(Q)~`비고`(BV)는 자유 입력. `연 20,000km`는 `2만km`. 대화 기억으로만 두지 않고 `supplier-input-sheet-spec.v1.json` 및 `SUPPLIER-INPUT-SHEET-RUNBOOK.md`에 기록한다.
- 기준 commit: main `076d32bb98aa516003435ae3fd8b8fd00c26a162`; 작업 가지 `codex/shared-sheet-dropdowns-before-rent`.
- 구현 commit: `81bb2e4f87329b7d8995b82bf73ee3fa0776d3d7`, PR [#397](https://github.com/freepass-creator/freepass-data/pull/397). 15탭 첫 데이터 행과 마지막 행 새 조회에서 Q:BV 검증 0, 첫 데이터 행 A:P 기존 검증 총 105 유지. 화면 확인용 별도 로그인은 사용자에게 요구하지 않는다(대표 10-06: 기존 API 연결로 처리).
- 실제 적용: Google 연결 계정 `pyh@teamjpk.com`, 현재 공급사 입력 탭 15개 Q2:BV1000 검증 제거(필터 숨김 행 포함). 연주행 AN열에서 명시한 같은 거리 표기 118칸만 `2만km`; 새 조회에서 이전 표기 0·새 표기 118·AN 검증 0. 종합 수식·금액·차종 사실 변경 없음.
- 코드: 자유 입력 칸의 과거 목록 정의는 변환 이력용으로 보존하되 드롭다운 설정·탭 일관성 계획기에서는 재적용하지 않는다. 명시한 연주행 별칭은 정규화 계획기에 연결했고 `2만km` 재실행은 변경 0.
- 검증: 시트 전용 Node 테스트 89 PASS, git diff --check PASS. 운영 쓰기 응답과 새 API 조회 확인. 브라우저 화면 검증·응답 시간 개선 실측·자동 동기화 연결은 미검증이며 이번 완료 주장에 포함하지 않는다.
- next_start_here: 이 절과 공급사 runbook의 2026-10-06 결정을 먼저 읽고 옛 정책 드롭다운 목록을 복원하지 않는다. 코드 변경의 main 반영은 별도 PR로 추적한다.

### 2026-10-05 손오공 구독 보증금 0·보험료 별도 점검

- 원인: 상품 price.<기간>.deposit 의 0 은 공급사 API 의 자리표시자이고 규칙은 deposit_note «월 대여료 × 약정연수 (최대 3개월)» 에 있다(원문은 손으로 안 덮음). 카톡 참조 카탈로그는 이미 이 규칙으로 계산했지만 정본 매핑(erp5-product-mapping)은 UNKNOWN_DEPOSIT 이었다. 이제 도메인 `depositFromYearsRuleNote` 로 읽을 때 계산(12개월 1배·24개월 2배·36개월↑ 3배)하고 쓰지 않는다. 날것 price.deposit 을 직접 읽는 소비처는 0 을 보증금 없음으로 읽지 말고 매핑·카탈로그 값을 써야 한다.
- 정책 POL-0020 insurance_included «보험료 별도» → 공식 안내 «대여료에 보험료 포함»: 정책 정정기 계획(비공개)로 처리, 정정기 허용 칸 insurance_included 에 «보험료 포함/별도» 형식 허용 추가.
- 남음: POL-0020 연령하향(만21세·21세+10만·23세+7만 ↔ 공식 만25.5세만 +10만)·분납(가능 ↔ 2회까지)은 별건(대표 10-05 21·23세 판매 방침 층 적용 필요).

### 2026-10-05 뮤카(RP035) 조건 변경 — 분납 폐지 반영

- 목적: 대표 10-05 지시. 보증금 분납 폐지 + 영업 분납 정액 줄 삭제. 선납 정액(100만·120만)·추가보증금×10%(40만 한도)·프리패스 차량가×1% 는 그대로. 정책 효력일 2026-10-05.
- 변경: `src/application/kakao-catalog-reference.ts` 뮤카 지급 — 분납은 `contractDate` 가 효력일 이후면 `MEWCAR_INSTALLMENT_ABOLISHED_CONFIRM_REQUIRED`(확인 필요, 계산 안 함), 계약일을 모르면 `MEWCAR_CONTRACT_DATE_REQUIRED`, 그 전 계약은 옛 규칙. `tests/kakao-catalog-reference.test.ts`·`docs/READ-RUNTIME.md` 갱신.
- 남음: 호출부(접수·정산 입력)가 `contractDate` 를 넘기게 하는 일(넘기지 않으면 분납은 멈춘다). 근거 문서는 비공개(ai-ops).

### 2026-10-05 후속 목록 (정책 정정기·빈 칸 채우기 반영 뒤)

- [완료 2026-10-05] 이안카 정책 동기화(`src/infra/iancar-policy-sync-firestore.ts`): 상품 119 + 정책 4를 한 `db.runTransaction`으로 묶고 사전 `updateTime` 조건을 재확인한다. 소유 가드(#388)는 백업·쓰기 전과 트랜잭션 내부 현재 데이터 기준으로 모두 검사한다.
- 빈 칸 채우기 읽기 어댑터: 완료(confirmed 기준 = products `확정 === true` 그리고 `검수상태 === "확정"` 둘 다). 적용은 줄확인 지원 시트고치기(ai-ops#62)로만.
- 배움 → 프리패스 데이터 다리 코드(docs/POLICY-CORRECTION.md 설계 메모).

### 2026-10-05 이안카 정책 동기화 한 트랜잭션

- 목적: `applyIancarPolicySync`가 상품 정책 연결 119건과 정책 4건을 따로 커밋해 생기던 반쪽 반영 위험을 제거한다.
- 대상 revision: `work/freepass-data/iancar-sync-one-transaction-20261005` `106d565c788e8ef39cf8b136951eb8e55f069913` 기준.
- 변경: `applyIancarPolicySync(input, deps?)` 주입점을 추가하고, 사전 상품 119·정책 4 읽기/백업 뒤 단일 `db.runTransaction`에서 123개 문서 `updateTime` 사전조건, 소유 가드, 상품 `update`, 정책 `set(merge)`을 수행한다. 기존 호출부는 변경 없음.
- 검증: `npm.cmd test -- tests/iancar-policy-sync-transaction.test.ts` 6 PASS, `npm.cmd run build` PASS, `npm.cmd run check:standards` PASS(standards status는 기존 PARTIAL 유지: unresolved capability 9개).
- 남음: 실제 Firestore 쓰기·fetch·push·commit은 사용자 실행 규칙상 미실행. next_start_here: 네트워크 가능한 운영 환경에서 동일 코드로 dry-run/승인 실행 시 backupPath와 정책 4개 readback을 확인한다.

### 2026-10-05 공통 시트 빈 칸 채우기 계획기

- 목적: 공급사 15탭 차량 줄의 빈 칸만 프리패스 데이터 정본 값으로 채우는 비공개 시트고치기 계획 파일을 만든다. 시트 쓰기·커밋·push 없음.
- 대상 revision: work/freepass-data/sheet-blank-fill-20261005 `0ed468a6c753e842e86648d8aebd614d801cd8db` 기준.
- 변경: `src/application/sheet-blank-fill.ts`, `src/jobs/plan-sheet-blank-fill.ts`, `tests/sheet-blank-fill.test.ts`, `docs/SHEET-BLANK-FILL.md`, `package.json` 스크립트 추가.
- 검증: `npm.cmd run check`와 `npm.cmd run check:standards` 실행 결과를 최종 보고에 남긴다.
- next_start_here: 비공개 캡처 JSON을 15분 안에 넣어 `SHEET_BLANK_FILL_INPUT`/`SHEET_BLANK_FILL_OUT`으로 계획·보고서만 만들고, 적용은 상황실 시트고치기 엔진에서 별도 수행한다.
### 2026-10-05 정책 정정기 일반 경로 추가

- 목적: `policy/<정책코드>`의 공급사 조건층과 판매 방침층을 근거·시행일·계획 digest로 정정하는 일반 정정기를 추가했다.
- 변경: `policy-correction` 도메인 검증, Firestore 적용기, `repair:policy-correction` job, 테스트, 짧은 운영 문서 추가. 기존 공급사 전용 정정기 코드는 건드리지 않고 `package.json` 스크립트만 추가했다.
- 검증: `tests/policy-correction*.test.ts` 추가. 전체 `npm.cmd run check`와 `npm.cmd run check:standards`는 이 작업 마지막에 실행 결과를 보고한다.
- 남음: `policy_field_owner: "policy-corrector"` 표시는 이번에 쓰지만, 기존 공급사 전용 보정기·매일 수집기가 이 표시를 보고 덮어쓰지 않게 하는 방어 로직은 후속 작업이다.
- next_start_here: 실제 운영 적용은 `POLICY_CORRECTION_PLAN` dry-run의 `planDigest`를 확인한 뒤 같은 digest를 `AUTHORIZE_POLICY_CORRECTION`으로 넣고 `--apply`를 붙인다.

### 2026-10-05 하루 한 번 박제 첫 예약 실행 — 예약이 만들어지지 않음(읽기만 점검)

- 점검(05:17 KST, 읽기만): `shared-sheet-daily.yml` 의 03:40 KST(`40 18 * * *`) 예약 실행이 **만들어지지 않았다**. 이 워크플로 실행 목록은 10-04 수동 실행 셋(시험 37188258463 · 첫 적용 37188552323 · 날짜 실제 값 시험 37203529314)뿐이다. 워크플로 상태 active, 변수·권한 변경 없음.
- 원인(근거): GitHub 예약 누락·지연. 같은 저장소의 «매시» 감사(`erp5-continuous-audit.yml`)도 실제 예약 실행은 4~6시간 간격(10-04 08:44·14:56·18:45 UTC), 수집·배달 예약도 같은 간격이다. 관문 실패가 아니라 실행 자체가 없다.
- 감시: 마지막 매시 감사 37225665365(10-04 18:45 UTC)의 `daily-writer-guard` = OK · writes 5,632 · 경로 없는 쓰기 0 · 허용 밖 0 · 실행 구간 밖 0 · 조용한 적용 0 · 구간 안 박제 실행 3.
- 정정 이력 보충값(03:17 KST): 10-04 이력 629 → 번호 없는 줄 9 제외 620, 증거 버킷 파일과 같아 다시 올리지 않음, 합치기 통과(620·건너뜀 0).
- 고침(PR #366): 같은 날 04:40·05:40·06:40 KST 재시도 예약. 박제 단계를 «캡처·계획(쓰기 없음)»과 «쓰기(Apply to FreePass Data)» 두 단계로 나누고, 관문은 «실행 생성 시각의 KST 날짜»가 오늘인 apply 실행 중 쓰기 단계에 들어간 것(성공·실패·진행 중, 이전 시도 포함, 나누기 전 판의 한 단계도 보수적으로)이 있으면 건너뜀 — 캡처·계획에서 멈춘 실행은 그날 재시도를 막지 않는다. 오늘 범위를 페이지 끝까지 읽고, 조회 실패는 멈춤, 수동 apply 는 상황실 통제 예외. 캡처는 시트 읽기 일시 오류(시간 초과·429·5xx)를 30초 뒤 세 번까지 다시 읽음(쓰기 전). 관문의 감시 신선도(3시간)는 그대로.
- 오늘 박제(상황실 수동 apply): 시험 실행 37231963146 통과(레코드 206 · 공급사 입력값 192 · 날짜 실제 값 295 · 쓰기 0) → 수동 apply 37232401933 은 캡처 단계 시트 읽기 일시 오류(SHARED_SHEET_READ_UNKNOWN, 쓰기 전 멈춤 — 쓰기 0) → 재실행 37232583749 **성공**: 레코드 206 · 공급사 입력값 192 · 정정 이력 620 · 날짜 실제 값 295 · 기간 대사 712=712 · writerReady → PARTIAL_HOLD · committed 49 · held 114 · readbackMismatches 0 · 증거 보관·되읽기 확인. 수동 apply 변수는 바로 지움(상황실).
- 보류 114(10-04 첫 적용 47 대비 증가)의 사유: 세부모델 이름 변경 65(`SHARED_MODEL_CHANGE_REQUIRES_SEPARATE_COMMAND` — 10-04 공통 시트 세부모델 이름 v1 반영으로 정본과 이름이 달라짐, 정본 이름 바꿈은 따로 명령) · 연식↔최초등록 불일치 25 · 차종 식별 불완전 11 · 가격 기간 없음 9 · 번호 미배정 5 · 배터리 용량 형식 4(10-04 표시 형식 «0.###»가 정수를 «22.kWh»로 보임 — 정규화기 수정 PR #367) · 최초등록일 형식 3(공급사가 «주문발주»·드라이브 주소를 적음) · 번호 없음 3 · 상품구분 2 · 자산 상태 2 · 주행거리 1(«매각»).
- 보류 47 → 114 대조(10-04 첫 적용 37188552323 과 사유별): 같은 사유 그대로 — 연식↔최초등록 불일치 25 · 차종 식별 불완전 11 · 가격 기간 없음 9 · 번호 미배정 5 · 최초등록일 형식 3(공급사가 «주문발주»·드라이브 주소를 적음) · 번호 없음 3 · 상품구분 2 · 자산 상태 2 · 주행거리 1(«매각»). **새로 생긴 것 둘**: 세부모델 이름 변경 65(`SHARED_MODEL_CHANGE_REQUIRES_SEPARATE_COMMAND` — 10-04 공통 시트 세부모델 이름 v1 반영으로 정본 이름과 달라짐, 정본 이름 바꿈은 따로 명령) · 배터리 용량 형식 4(10-04 표시 형식 «0.###"kWh"»가 정수를 «22.kWh»로 보임 — 정규화기 수정 #367). 47 + 65 + 4 − 겹침 2 = 114.
- 판단: 10-04 서식 통일(글자→숫자·날짜 463칸, 연도 포함 날짜)로 «원문이 바뀌었다»는 이유의 보류는 없다(그런 보류 사유 자체가 없고, 다른 사유 수도 그대로). 형식 때문에 생긴 것은 배터리 4뿐이며 정규화기에서 같은 값으로 받게 고쳤다(#367) — 원문 이력에 따로 «형식 변경» 표시를 둘 필요는 없다(원문은 처음·최신을 그대로 보존하고, 뜻은 정규화가 맞춘다).
- next_start_here: 재시도 PR 반영 뒤 첫 예약 실행의 관문·DRY_RUN 숫자·적용 결과(APPLIED/PARTIAL_HOLD·committed·held·readbackMismatches 0)·증거 보관과 다음 감시 OK 를 이 아래에 남긴다.

### 2026-10-05 정정 원문 박제 — 외부 차량번호 사양 조회 18대

- 대표 규칙(10-04): 공급사 첫 원문은 영구 보존, 원문으로 하나로 안 정해지는 차는 외부 차량번호 사양 조회 결과를 «정정 원문(출처·시각)»으로 따로 저장. 쓰기 길이 없어 정정기에 `productSourceCorrections`(#379)를 더함 — `products/<id>.원문`은 건드리지 않고 `원문_정정`(최신)·`원문_정정_이력`(누적)에 차명·연식·최초등록·연료·배기량·출처·조회일, 항목마다 결정적 키(계획 digest·상품·출처)·기록 시각. 재실행은 건너뜀, 계획 때 정정 원문 digest(`expectedCurrentDigest`)와 다르면 거부, 이력은 배열만·옛 이력 보존 확인, 이력에 없는 기존 정정은 덮지 않고 거부, 트랜잭션 재시도에도 안전. 독립 검토(상황실 Codex) 지적 4회 고친 뒤 반영.
- 적용(AI 상황실): 조회 20대 중 이름이 나온 18대. 재감사(새로 읽음): 18대 모두 정정 원문 = 조회 결과, 이력 1개씩(= 정정 원문), 키·기록 시각 있음, 공급사 원문 차명과 상품 차종·제원 칸 그대로, 그 밖 상품 차종 칸 변화 0.
- 후속(운영 위험 낮음 — 상황실 한 곳에서만 실행하면 손상 없음): 트랜잭션 안에서도 «옛 이력 ⊆ 쓸 이력» 확인 · 같은 정정 값이 이미 이력에 있으면 키가 달라도 건너뜀.
- next_start_here: 남은 외부 조회 후보(하루 20대, 결과는 같은 방식으로 박제) · 마스터 정비(베뉴 겹침·RAV4 6세대·볼트 EV 부분변경 달) · 매일 박제 뒤 값 유지 확인.

### 2026-10-05 차종 마스터 표시 이름·에이스맨·괄호 이름 정비 · 외부 사양 조회로 정한 상품 · 세부트림

- 정정기 `masterTitleRepairs`(#378 — vehicle_master.title, 바꿀 값은 반드시 «최종 제조사 + 최종 세부모델», 저장 글자 그대로 사전조건, 퇴역 마스터 거절, 별칭 없음 — 옛 표시 이름은 백업·감사). 독립 검토 지적(정규화 비교) 고친 뒤 반영.
- 마스터 정비(110건, 적용 AI 상황실, 되읽기·감사 110): 표시 이름 80행(이름 정정 뒤 옛 이름이 남아 있던 것 + 아래 이름 바꾼 마스터) · 에이스맨 «에이스맨 1세대» → «에이스맨 J05»(규칙 1 세대명 대신 개발코드, BMW 그룹 보도자료 «J05», 국내 출시 2025-03-13, gen_code J05) · 괄호 이름 6개 괄호만 빼기(규칙 ②: «엑센트(신형)» → «엑센트 신형», i30·베르나·투스카니·프라이드 «신형», «야리스 비츠») — 세부트림 행 20·상품 2 포함.
- 상품 15대(일괄 계산 보강·외부 사양 조회): 보강 규칙(전기 전용 차는 마스터 트림 연료로)으로 정해진 어벤저 3 · 외부 차량번호 사양 조회(«정정 원문» — 그 결과만 믿고 공급사 세부모델·별칭은 쓰지 않음, «가솔린+전기» = 하이브리드)로 정해진 11 · 모델 칸까지 다른 차 1(«아이오닉/더 뉴 아이오닉 일렉트릭» → «아이오닉 5 / 아이오닉 5 NE»). 조회 20대 중 못 정함 8: 볼트 EV 부분변경 시작 달이 마스터에 연도만 · «베뉴»와 «베뉴 QX» 마스터 기간 겹침 · RAV4 6세대 마스터 없음 · 조회도 선택창만 뜬 차.
- 상품 세부트림 5대(조회 결과의 등급 → 마스터 세부트림 이름: «C 클래식» 2 · «기본형» · «프리미어» · «익스클루시브»).
- 재감사(새로 읽음): 실행 전 사본 + 계획 = 지금 값(마스터·트림·상품 차이 0), 표시 이름 어긋남 0, 괄호 이름 0. 세부모델이 마스터 이름인 상품 1,658 → 1,673 / 1,760.
- 진행 중: 정정 원문 박제 정정기(#379 — 공급사 첫 원문은 그대로, `원문_정정`·`원문_정정_이력`에 출처·조회일, 재실행 안전 키·기대 이전값·이력 보존 확인) 반영 뒤 조회 결과 18대 박제. 공통 시트 쪽 바꿀 칸(조회 20대 중 공통 시트에 있는 3대 12칸)은 대표 손작업 목록으로.
- next_start_here: #379 반영·18대 박제 → 재감사 · 마스터 정비(베뉴 겹침·RAV4 6세대·볼트 EV 부분변경 달) · 남은 외부 조회 후보(하루 20대) · 매일 박제 뒤 값 유지 확인.

### 2026-10-05 상품 제조사·모델 칸 53대 정리(정정기 상품 차종 칸 고치기)

- 일괄 계산의 확인 필요 중 «모델 이름이 마스터에 없음» 82대: 빈 제조사, «아이오닉5»처럼 띄어쓰기 다른 모델, 제조사 칸 틀림(기아 → 아우디 A6), 모델 칸에 세부모델이 들어간 것(«디 올뉴니로EV»). 정정기가 상품 세부모델만 고칠 수 있어 `productIdentityRepairs`(#376 — 상품 maker·model·sub_model 을 한 번에, 저장 글자 그대로 사전조건, 퇴역 아닌 마스터 하나와 정확히 일치, 근거 필수, 마스터 이름 바꾸기·퇴역과 다른 계획) 를 더함. 독립 검토(상황실 Codex) NOT_OK 3 → 고친 뒤 OK.
- 계획 53 · 보류 29(칸·원문 모두 빈 21, 어벤저 닷지/지프, 도어 없는 미니 쿠퍼, 컨트리맨 등). 모델은 모델 칸·원문으로 마스터에 있는 모델 하나일 때만, 세부모델은 일괄 계산과 같은 규칙(+ 전기 전용 차는 마스터 트림 연료로, 괄호 속 코드, «더 뉴K8»처럼 붙여 쓴 부분변경 이름 — 보강 뒤 일괄 계산 558대 판단 불변 확인). Codex 검토: 보류 제안 4 반려(공급사 모델 칸 «디 올뉴니로EV»+연식+전기 = SG2 하나 / 티볼리 X170 은 마스터 이름, «X100»은 마스터 표시 이름 칸의 옛 값), 추가 제안 3 수용(아이오닉 5 NE — N 은 롱레인지·익스클루시브 등급 없음 / 그랜저 GN7 — «디 올 뉴 그랜저»는 GN7 출시 이름).
- 적용 AI 상황실, 되읽기·감사 53. 재감사(새로 읽음): 53대 세 칸 모두 계획대로, 계획 밖 상품 변화 0. 세부모델이 마스터 이름인 상품 1,605 → 1,658 / 1,760.
- 곁에서 발견(마스터 정비 목록): 마스터 표시 이름(title) 칸이 이름 정정 뒤에도 옛 이름(예: «더 뉴 티볼리 X170» 행의 title «X100»), 에이스맨 마스터 이름 «에이스맨 1세대»(세대명 규칙 위반).
- next_start_here: 확인 필요 최종 목록(보류 29 + 외부 사양 조회 결과) · 마스터 title·에이스맨 이름 정비 · 다음 매일 박제 뒤 값 유지 확인.

### 2026-10-05 일괄 계산 — 상품 세부모델 558대를 차종 마스터 이름으로

- 기준 v1 잠금 뒤 첫 일괄 계산. 상품 1,760대 중 이미 마스터 이름 1,047 · 계획 558 · 확인 필요 155. 정정기 `repair:vehicle-name-parity` 의 `productRepairs`(products.sub_model 만, 옛 값을 사전조건으로)로 200·200·158 세 묶음(한 묶음 상한 200).
- 판단(«원문으로 뜻으로 하나일 때만»): 최초등록 월(없거나 깨졌으면 연식 기간 — 전년 7월~그해 12월, «YYYY-01-01»은 공급사 자리값으로 보고 연도만)과 겹치는 마스터 세부모델(생산 기간은 트림 행의 월) 가운데 연료(하이브리드·전기 — 하이브리드 이름 세부모델이 없으면 그 마스터에 하이브리드 행이 있을 때만), 차체 낱말(밴·쿠페·슈팅 브레이크·롱 휠 베이스·픽업, 2인승), 원문에 적힌 이름(부분변경 이름·코드·세대 «N세대», 미니 5도어 F65·3도어 F66)으로 하나가 될 때만. 부분변경 이름이 «안 적힌 것»만으로 옛 세부모델을 고르지 않음. 어긋나면 확인 필요.
- 검토: Codex 계획 검토 5회(오배정 지적 — 니로 EV·뉴모닝 SA·레이 2인승 밴·RAV4 6세대·자리값 날짜 — 을 규칙으로 막거나 보류로). 마지막 지적 «디 올 뉴 니로 EV → 니로 EV SG2»는 반려(니로 EV DE 생산 2021-12 끝, «디 올 뉴 니로»가 SG2 공식 이름). 적용 AI 상황실, 되읽기·감사 200·200·158.
- 재감사(새로 읽음): 558대 모두 계획한 이름, 계획 밖 상품 변화 0(제조사·모델·세부트림 칸 포함, 새 상품·없어진 상품 0). 세부모델이 마스터 이름인 상품 1,047 → 1,605 / 1,760.
- 확인 필요 155: 세부모델이 하나로 안 정해짐 73(외부 사양 조회 후보, 판매 중 먼저) · 제조사·모델 칸 문제 82(빈칸·«아이오닉5» 표기·마스터에 없는 차종 — 정정기는 세부모델만 고침).
- next_start_here: 다음 매일 박제 뒤 558대 값 유지 확인(다른 수집 경로가 시트 값으로 덮는지) · 제조사·모델 칸 82대 «추천안+근거» 계획(필요하면 정정기 모델·제조사 칸 확장) · 외부 사양 조회 73대.

### 2026-10-05 V60 크로스컨트리 정리 · 차종 기준 v1 잠금

- 결정(AI 상황실 10-05, 대표 원칙 «세대명 안 씀·예외 만들지 않기»): 2세대(국내 2019-03~) «V60 크로스컨트리 2세대» → «V60 크로스컨트리»(공개 개발코드 없음 → 모델명, 규칙 1) · 1세대(국내 2015-09~2018, 트림 행 0·상품 0, 규칙 17 범위 밖)는 이름을 «V60 크로스컨트리 확인 필요»로 비킨 뒤 퇴역(2세대로 이음) · 새 마스터 «V60 크로스컨트리 FL»(볼보코리아 2022-09-27 부분변경 출시 때 공식 부분변경 이름 없음 → FL, 5시리즈 G30 FL 선례대로 이름·연식만). 우리 차 1대는 원문(B5·최초등록 2021-03, B5 는 2세대 전용)으로 2세대 확정 — 외부 사양 조회 안 함.
- 정정기는 같은 묶음에서 이름 바꾸기와 퇴역을 같이 못 하므로 두 묶음(이름 6건 → 퇴역 1건). Codex 계획 검토 통과. 적용 AI 상황실, 되읽기 6·1.
- 재감사(새로 읽음): 실행 전 사본+두 묶음 = 지금 값(마스터·트림 차이 0) · 마스터 1,870 → 1,871 · 퇴역 5 → 6 · 끊긴 연결 0 · 퇴역 마스터에 남은 연결 0 · 트림-마스터 이름 불일치 272 그대로.
- 남은 일(이번 범위 밖): 2025-11 이후 «B5 Ultra» 트림 행 1을 FL 마스터로 옮기기(세부트림 정비 때) · 1세대 별칭 «V60 크로스컨트리»는 지금 별칭으로 찾는 코드가 없어 문제 없음 — 별칭 검색을 붙일 땐 퇴역 마스터를 뺀다. 상품 1대 세부모델 «V60 크로스컨트리 2세대» → «V60 크로스컨트리»는 공통 시트 쪽(대표 손작업, 바뀔 칸 목록 상황실로).
- **기준 v1 잠금(규칙 22)**: 세부모델 이름 v1(`docs/VEHICLE-SUBMODEL-NAMES-V1.md`)이 프리패스 데이터 차종 마스터에 반영됨(1~6차 + 정본 카탈로그, 각 재감사 차이 0). 2026-10-05 부터 차종·제원 기준 한 장 규칙 1~22 = «기준 v1». 바꾸는 건 대표 지시가 있을 때만, 날짜를 정해 «v1 → v2»로 남긴다. 기준 한 장 문구는 AI 상황실이 ai-ops 에 반영.
- next_start_here: 마스터 완료 → 일괄 계산 시작(상품 1,760대 전체 이름 맞추기) · 세부트림 이름 정비 · 정정기 후속 PR(운영 위험 낮음 7건) · G90 롱 휠 베이스 행 터보 칸 모순 · 셀토스 하이브리드 생산 시작 제원 정비.

### 2026-10-05 보류 3대 해소 — 수입차 부분변경 FL 마스터 2 · 정본 카탈로그 3대

- 근거: 수입사는 완전변경에도 «뉴»·«더 뉴»를 붙여(BMW «뉴 5시리즈» 2020-10 LCI, 벤츠 «더 뉴 E-클래스» 2020-10 부분변경) 이름으로 부분변경이 갈리지 않음 → 규칙대로 코드 뒤 FL(공통 시트 값과 같음). 셀토스 하이브리드는 국내 계약 2026-01 — 차종 마스터 생산 시작 2026-07 이 틀린 값(정정기로 못 고치는 칸, 제원 정비 목록으로 상황실에 넘김)이라 보류 사유가 아님.
- A 차종 마스터(`repair:vehicle-name-parity`): 새 마스터 «5시리즈 G30 FL»·«E-클래스 W213 FL»(이름·코드·연식만), 되읽기 2. B 정본 카탈로그(`rename-vehicle-models`, A 뒤): 차종 3 + 상품 3 → «5시리즈 G30 FL»·«E-클래스 W213 FL»·«셀토스 하이브리드 SP3», renamed 3 · readbackOk. Codex 계획 검토 «A 먼저면 통과». 적용 AI 상황실.
- 재감사(새로 읽음, 읽기만): A 실행 전 사본+계획 = 지금 값(마스터·트림 차이 0, 계획 밖 새 문서 0) · 마스터 1,868 → 1,870 · 끊긴 연결 0 · 퇴역 연결 0 · 트림-마스터 이름 불일치 272 그대로. B 바뀐 칸은 세 차종·세 상품의 세부모델·표시 이름·revision(+1)·수정 기록뿐, 나머지 156+156 문서 변화 0. 세부모델이 마스터 이름인 정본 차종 155 / 159(남은 4는 옛 세대 이름 «올 뉴 카니발»·«더 뉴 스타리아»·«뉴모닝»·«더 넥스트 스파크» — 이번 범위 밖).
- 다음 매일 박제 보류 기대값: 세부모델 이름 변경 사유 4 → 1(시트 QM6 «더 뉴 QM6 HZG FL», 대표 손작업으로 «더 뉴 QM6 HZG»가 되면 0) + 그날 새 줄.
- next_start_here: V60 크로스컨트리(지지오토 결과 뒤) → 기준 v1 잠금(규칙 22).

### 2026-10-05 정본 카탈로그 차종 이름 맞추기 · 차종 마스터 4차 나머지 적용

- 정본 카탈로그(`catalog_vehicle_models`·`catalog_products`): 매일 박제(run 37232583749)가 세부모델 이름 변경 65건을 `SHARED_MODEL_CHANGE_REQUIRES_SEPARATE_COMMAND` 로 보류 — 공통 시트엔 v1 이름, 정본 카탈로그엔 옛 이름. 고치는 검토된 명령 `rename-vehicle-models`(#336, 차종 + 그 차종을 쓰는 상품을 한 거래로, 되읽기)를 그대로 씀. 줄마다 매일 박제 증거의 공급사 원문(차명·연식·최초등록·연료)과 대조, 목표 이름은 차종 마스터 이름만, 하이브리드 이름 ↔ 연료 일치(니로는 하이브리드 전용 예외), 최초등록이 그 세부모델 생산 시작보다 앞서면 보류. Codex 계획 검토(보류 1 → 통과). 적용 AI 상황실(origin/main 69d4d80): renamed 62 · readbackOk.
- 재감사(새로 읽음): 실행 전 사본+계획 = 지금 값(계획 밖 문서 변화 0 — 칸 순서 차이는 비교에서 제외). 세부모델이 차종 마스터 이름인 정본 차종 104 → 155 / 159.
- 보류 3(다음 매일 박제에서도 보류로 남을 것): 5시리즈 G30 FL·E-클래스 W213 FL(차종 마스터에 그 이름 없음 — 수입차 부분변경 이름 근거 필요) · 셀토스 하이브리드 SP3 1대(원문 최초등록 2026-04 < 마스터 생산 시작 2026-07). 시트 쪽(대표 손작업): QM6 1대 시트 값 «더 뉴 QM6 HZG FL» → «더 뉴 QM6 HZG»(대표 10-04 규칙, 정본은 이 이름) — 시트가 고쳐지기 전엔 이 1건도 보류. 다음 매일 박제 보류 기대값: 65 → 4(시트 QM6 고치면 3) + 그날 새로 생긴 줄.
- 차종 마스터 4차 나머지(16건, Codex·Gemini 격리 교차 확인 같은 근거 0/7, Codex 계획 검토 통과): «렉스턴 스포츠 Q200»·«더 뉴 렉스턴 스포츠 Q200»(KGM 공개 코드, 부분변경은 원래 세대 코드 — 그랜저 GN7 선례, gen Q215/Q250/Q260 → Q200) · 칸은 공식 공개 코드 확인 안 돼 «렉스턴 스포츠 칸»·«더 뉴 렉스턴 스포츠 칸»(행 «렉스턴 스포츠 칸 Q201» → «렉스턴 스포츠 칸») · «더 뉴 레이 밴 TAM»(괄호 제거, 행 6 모두 2인승)·«더 뉴 기아 레이 밴 TAM» · «모닝 어반 밴 JA»(차체 낱말은 코드 앞). 적용 상황실, 되읽기·감사 16. 재감사 차이 0, 트림-마스터 이름 불일치 290 → 272.
- V60 크로스컨트리: «V60 크로스컨트리 P3» 안은 거둠(플랫폼 이름은 개발코드가 아님 — Codex) — 지지오토 결과 대기.
- next_start_here: V60 CC · 수입차 부분변경 이름(G30·W213) 근거 · 셀토스 하이브리드 날짜 모순 · 정정기 후속 PR(운영 위험 낮음) → 기준 v1 잠금(규칙 22) → 상품 전체 이름 맞추기.

### 2026-10-05 세부모델 이름 v1 — 차종 마스터 4차(스타리아) 적용

- 대표 10-05 «스타리아 세부트림도 니네가 찾아서 뭘로 하는 게 맞다고 얘기해 줘야지» → 결정 대기에서 빼고 근거로 결론. 근거: 현대 가격표 구조(투어러·카고·라운지·리무진 = 차체·인승 라인업, 등급 = 스마트·모던·프레스티지·인스퍼레이션, 2024년형·더 뉴 스타리아 같은 구조) · 중고차 표기(«스타리아 2.2 디젤 라운지 7인승 2WD 인스퍼레이션» — 세부모델 하나, 차체는 등급 쪽) · 같은 등급 이름이 차체마다 다름(영업자 혼동) · 2025-02 하이브리드 리무진은 가격표 등급 이름이 «리무진». Codex·Gemini 격리 교차 확인(같은 근거 0/6).
- 결론: 세부모델 «스타리아 US4»·«스타리아 하이브리드 US4»·«더 뉴 스타리아 US4»·«더 뉴 스타리아 하이브리드 US4»·«더 뉴 스타리아 일렉트릭 US4». 세부트림 = «차체 + 등급»(투어러 스마트·투어러 모던·카고 스마트·카고 모던·라운지 프레스티지·라운지 인스퍼레이션·리무진 인스퍼레이션, 2025-02 하이브리드 리무진만 «리무진») — 미니 «C 에센셜» 선례. 기준 한 장은 안 바뀜.
- 계획 128건(Codex 계획 검토 3회 → 통과): 세부트림 56행(옛 이름 trim_aliases), 세부모델·연결 31행, 새 마스터 2(신차 구분은 원래 마스터 값), 차체별 빈 일렉트릭 마스터 4개 퇴역, 옛 파워트레인 칸은 지우지 않고 차체를 붙여 옮김(같은 칸 = 연료·인승·구동·터보·배기량 모두 같을 때만). 적용 AI 상황실(origin/main cbf6076), 되읽기·감사 128.
- 재감사(읽기만): 실행 전 사본+계획 = 지금 값(차이 0). 끊긴 연결 31→0 · 안 갈린 하이브리드 행 40→25 · 퇴역 1→5 · 퇴역 마스터에 남은 연결 0.
- 상품·공통 시트는 안 바꿈(대표 손작업) — 바뀔 칸 4대 목록은 상황실이 대표께. 원문으로 부분변경 전 하이브리드로 확인된 차 1대 포함(원문 차명 «스타리아 하이브리드 1.6 HEV 투어러 11인승 모던», 최초등록 2025-09 → «스타리아 하이브리드 US4 / 투어러 모던», 지금 상품 세부모델 «더 뉴 스타리아»는 틀림).
- 남음(4차 나머지): V60 크로스컨트리(2세대 «V60 크로스컨트리», 1세대 «V60 크로스컨트리 P3»로 바꾼 뒤 퇴역 — 지지오토 대조 뒤), 렉스턴 스포츠 코드, 레이 밴, 세부트림 이름 정비, 정정기 후속(운영 위험 낮음).

### 2026-10-04 세부모델 이름 v1 — 프리패스 데이터 차종 마스터 3차 정비 적용

- 정정기 확장 #355: 모델명(`masterModelRepairs`·`trimModelRepairs`, 옛 이름 `model_aliases`) · gen_code(`masterGenCodeRepairs`, 옛 값 `gen_code_aliases`, 빈 칸은 근거가 있을 때만 채움) · «variants 안 세부트림 ⊆ 최상위 trims» 검증 · 마스터와 연결 행의 모델명 일치(재연결·생성 포함, 트랜잭션 안) · 별칭 보존(저장 원문 포함, 되읽기) · 계획·저장값 형식 검사(생성 문서 허용 칸·형식, 파워트레인 칸, 한 칸 문서 ID). 검토: Codex 여러 차례 + 상황실 독립 Codex. 후속(운영 위험 낮음, 실데이터 형식 이상 0 전제): 비문자열 master_id·retired 조회, 빈 별칭·«|» 키 충돌, 적용 단계에서만 거절되는 입력의 사전 검증.
- 결정 9줄 Codex·Gemini 격리 교차 확인(같은 근거 0/9): 아이오닉 5·6·9 띄어쓰기 · 더 뉴 아이오닉 6 CE · 아이오닉 9 ME · 아이오닉 5 N NE · G90 롱 휠 베이스 RS4 · GV80 쿠페 JX1C(블랙은 세부트림) · 모델 Y L. gen_code 정리(AX1·X170·F66·CV, 빈 칸 ME·CE). 같은 이름 마스터로 끊긴 연결 다시 잇기(팰리세이드 LX2·아반떼 AD·G90 RS4·C-클래스 W205/W206·V60 CC). 들어오는 행 세부트림 «기본»→«기본형», 마스터 세부트림 목록은 지우지 않고 더함.
- 계획 1묶음 137건(Codex 계획 검토 3회 → 통과), 적용 AI 상황실(origin/main 1bb4645), 되읽기·감사 137.
- 재감사(읽기만): 실행 전 사본+계획 = 지금 값(마스터·트림 차이 0). 끊긴 연결 61→31(남은 31 = 스타리아, 대표 답 대기) · 이름 불일치 302→290 · 같은 이름 마스터 묶음 6 · 트림 키 중복 0 · 퇴역 마스터에 남은 연결 0.
- 남음(4차): V60 크로스컨트리 세대 가르기(대표 «지지오토 조회» — 상황실 조회 후), 렉스턴 스포츠 코드, 레이 밴(승용 세부트림 섞임 — 원문 대조), 세부트림 이름 정비(아반떼 AD «GDI 스타일» 등), G90 롱 휠 베이스 행 터보 칸 모순(제원 정비), 스타리아. 이름 불일치 290 의 대부분은 규칙 17(최근 10년·우리 차) 밖 옛 세대.
- next_start_here: 4차 → 기준 v1 잠금(규칙 22) → «마스터 완료, 일괄 계산 시작».

### 2026-10-04 세부모델 이름 v1 — 프리패스 데이터 차종 마스터 2차 정비 적용

- 정정기 확장: #352 옛 마스터 «퇴역» 표시(지우지 않음 · 트림 연결·상품 이름 사용이 남으면 거부 · 연쇄 금지 · 퇴역 마스터 동결) · #353 `masterVariantRepairs` 에 최상위 `trims` (freepass-admin `src/adapters/erp5/vehicle-master.ts` 가 `trims ∪ variants[].trims` 로 세부트림을 대조).
- 결정표 27줄을 Codex·Gemini 격리 교차 확인(같은 근거 문장 0/27) → 합의 24줄 + 대표 QM6 답(기준 한 장 3번 규칙 예, ai-ops 41dcea1). 계획은 Codex 검토 3회(보류 2 → 통과), 적용은 AI 상황실(실행 환경 `FIREBASE_PROJECT_ID=freepasserp5`, #353 이 들어간 main). 2묶음 되읽기·감사 171·160.
- 바꾼 것: 끊긴 연결 복구, 개발코드 이름 정정(GN11→더 뉴 그랜저 GN7 · CV1→CV · AX1e→AX1 · X100→X170), FL 마스터 새로(G80 RG3 · GV80 JX1 · GV70 JK1 · 일렉트리파이드 GV70 JK1 · 모델 3·Y), 일렉트릭 분리(코나 OS·SX2 · 니로 DE), G70 2020-10 부분변경 기준으로 G70 IK / 더 뉴 G70 IK, 미니 쿠퍼 F66·F65 와 세부트림 이름, «쿠퍼 S»(F66/F65) 퇴역 표시 1건. 새 마스터 12개는 옮겨 오는 행으로 파워트레인·세부트림을 채움. 상품 칸은 안 바꿈(일괄 계산 때).
- 재감사(새로 읽음, 읽기만): 실행 전 사본+계획 = 지금 값(마스터·트림 차이 0). 같은 이름 마스터 묶음 7→6 · 트림 키 중복 0→0 · 끊긴 연결 230→61 · 퇴역 마스터에 남은 연결 0 · 트림-마스터 이름 불일치 386→302 · 안 갈린 하이브리드 행 44→40 · 세부모델이 마스터와 맞는 차 992→995.
- 남음: 정정기 다음 확장(마스터 gen_code·모델명 띄어쓰기, «variants 안 세부트림 ⊆ 최상위 trims» 검증 — 상황실 권고), 스타리아 세부트림(대표 답 대기), 렉스턴 스포츠 칸·V60 크로스컨트리 코드, 남은 끊긴 연결 61. 계획·백업·runId 는 비공개 경로(ai-ops 인수인계).
- next_start_here: 정정기 확장 → 나머지 정리 → 기준 v1 잠금(규칙 22) → «마스터 완료, 일괄 계산 시작».

### 2026-10-04 세부모델 이름 v1 — 프리패스 데이터 차종 마스터 1차 정비 적용

- 대상: `vehicle_master`·`vehicle_trim_master`(기준 한 장 0절 5번 «지금 기준»). 정정기 확장 #348 로, 5묶음(176·176·193·197·90건). 계획은 Codex 재검토 4회 후 GO, 대응표는 Codex·Gemini 독립 일치(Gemini 는 격리 폴더 실행 — 같은 폴더에서 돌리면 Codex 답을 베낌, 근거 문장 겹침 수로 독립성 확인). 적용은 대표 승인 범위로 AI 상황실(실행 환경 `FIREBASE_PROJECT_ID=freepasserp5` — 빠지면 시작에서 멈춤, 쓰기 0).
- 바꾼 것: 이름 바꿈(옛 이름은 `sub_model_aliases`), 하이브리드 세부모델 분리(규칙 15·18, 벤츠·BMW 제외), 등급을 세부모델에서 빼서 합침(하이루프·X-Line·스타리아 카고/라운지/투어러), 데이터에 없는 세부모델만 새로(기존 ID 재사용 우선), 하이브리드를 뺀 원래 마스터 variants 정리.
- 재감사(새로 읽음, 읽기만): 적용 전 스냅샷+계획 = 지금 값(마스터·트림 차이 0). 같은 이름 마스터 묶음 8→7 · 트림 키 중복 0→0 · 끊긴 연결 395→230 · 트림-마스터 이름 불일치 790→386 · 안 갈린 하이브리드 행 243→44 · 세부모델이 마스터와 맞는 차 876→992(차 이름은 아직 안 바꿈 — 일괄 계산 때).
- 보류·2차: 코드 확인 7건(그랜저 GN7↔GN11, EV6 CV↔CV1, 캐스퍼 일렉트릭 AX1↔AX1e, 티볼리 X170↔X100, 볼트 EV, 렉스턴 스포츠 칸 Q250, V60 크로스컨트리 세대), 미니 3도어·5도어, G70 IK·슈팅 브레이크 기존 ID, QM6 세 갈래, 스타리아 리무진·더 뉴 스타리아, 같음 세부모델의 끊긴 연결, 합쳐진 뒤 남는 옛 마스터 정리. 계획·실행 기록·백업은 비공개 경로(ai-ops 인수인계).
- next_start_here: 2차(위 보류) → 기준 v1 잠금(규칙 22) → «마스터 완료, 일괄 계산 시작»(공통 시트·공급사 시트·상품 차종 칸).


### 2026-10-04 하루 한 번 박제 자동 실행 권한 적용(대표 승인 ①안)

- 코드·문서: #347(전용 워크플로 `shared-sheet-daily.yml` · 장기 키 없는 시트 읽기 · 매시 감사 `daily-writer-guard` job · 예약 관문 = 최근 감시 성공 · 수동 apply 변수 관문) · #337(`docs/SHARED-SHEET-DAILY-IDENTITY-PLAN.md` 확정판). 실행 명령 묶음(실행·되돌리기 분리, ID 포함)은 ai-ops 비공개 인수인계에만 있다.
- 실행(AI 상황실, 단계마다 되읽기): 서비스 계정 `github-data-inventory-writer` · 맞춤 역할 `freepassDataDailyWriter`(권한 다섯, 지우기 없음) · `(default)` 데이터베이스 조건 바인딩 · 새 WIF 풀(이 저장소·main·`shared-sheet-daily.yml`·environment) · 증거 버킷 만들기·보기(버킷 정책에 조건이 있어 `--condition=None` 필요) · 공통 시트 «보기» 공유 · environment 변수 · Firestore 쓰기 감사 로그 + 다른 계정 쓰기 로그 저장 전 제외 + 감사 계정 data_access 로그 보기.
- 검증: 시험 실행 run 37188258463(레코드 206 · 공급사 입력값 192 · 보류 47 · 기간 712=712 · writerReady) → 통제된 첫 적용 run 37188552323(PARTIAL_HOLD · committed 3 · held 47 · readbackMismatches 0, 감사 로그에 쓴 문서 경로가 남음 확인, 수동 apply 변수 바로 지움) → 감시 run 37190197244(daily-writer-guard OK · writes 5,632 · 경로 없는 쓰기 0 · 허용 밖 0 · 실행 구간 밖 0 · 조용한 적용 0).
- 상태: `FREEPASS_DATA_SHARED_SHEET_DAILY=on`, 첫 예약 실행 10-05 03:40 KST. 이때부터 공통 시트 → 프리패스 데이터 박제는 사람 손 없이 돈다. 운영자 PC 수동 박제는 멈춘다(예외는 AI 상황실 지시).
- next_start_here: 10-05 아침 첫 예약 실행(관문 통과·적용·되읽기 0)과 다음 매시 감시 OK 를 확인해 이 아래에 «2026-10-05 첫 예약 실행» 으로 남긴다. 남는 점: 증거 버킷 «보기»가 버킷 전체 범위 — 접두어 조건으로 따로 좁힌다.

### 2026-10-04 다나와 사본 삭제 · 기준 규칙 17~22

- 기준 한 장(ai-ops): 2aaed92 규칙 17(먼저 완성할 범위 = 최근 10년, 그랜저 IG부터) · 98d0ad5 규칙 18(하이브리드·EV는 꾸밈말 — 더 뉴 토레스 하이브리드 J140)·19(판단 원칙: 영업자 혼동 → 우리 규칙 → 제조사, 셋 추천 합의; 테슬라 FL, 미니 C·S 세부트림) · aef3f64 규칙 20(세부모델 별칭 칸을 프리패스 데이터에)·21(다나와는 한 건씩 근거로만)·22(세부모델 이름 v1 반영 후 «기준 v1» 잠금).
- 다나와 사본 삭제(대표 «지우고», 다나와 이용약관 «동의 없이 무단복제·가공 금지»): 회사 드라이브 비공개 작업기록 폴더의 다나와 브랜드 목록 사본 13개·대조 사본 1개를 휴지통으로, 작업기록 압축본은 다나와 원문을 뺀 판으로 교체, 로컬 임시 사본도 삭제. 삭제 기록은 같은 폴더에. 우리 이름 표(`docs/VEHICLE-SUBMODEL-NAMES-V1.md`)는 남김. 드라이브 ID 는 비공개 ai-ops 인수인계(`docs/handoffs/차종마스터-작업기록-20261004.md`)에만.
- 다음: 세부모델 이름 v1 을 프리패스 데이터 차종 마스터에(이름 바꿈 12·새로 넣음 32·하이브리드 떼기 약 28개 세부모델 176행·세부모델 별칭 칸·세부트림 맞춤) → Codex → 상황실 경유 대표 승인 실행 → 기준 v1 잠금 → «마스터 완료, 일괄 계산 시작».


### 2026-10-04 차종 레퍼런스 적재 실행기 막음(#339 사후 검토)

- #339(e77a7a7, `ingest:vehicle-reference`)는 관문 없이 main 에 들어왔다. `VEHICLE_REFERENCE_IMPORT_APPROVED=true` 와 입력 파일만 있으면 시험 실행 없이, Catalog 쓰기 주인(EXCLUSIVE) 검사·access.write 기록 없이 운영 Firestore(`vehicle_master_source_documents` 등)·Storage 에 바로 썼다. 기존 `capture/ingest/promote-vehicle-master-*` 경로와도 겹친다.
- 조치: `scripts/import-vehicle-reference.mts` 를 어떤 환경 변수로도 실행하지 않도록 막았다(`VEHICLE_REFERENCE_IMPORT_BLOCKED`, 종료 코드 1). 정규화·봉인 코드와 시험은 그대로 둔다.
- 운영 흔적(10-04 읽기만 조회): `vehicle_master_source_documents` 에 `sourceName == FreePass Vehicle Reference` 0건, 프로젝트 버킷(`freepasserp5-data-audit-evidence`)에 `vehicle-master/reference-import/` 0건 — 조회한 범위에서 실행 흔적을 찾지 못했다(과거 미실행을 증명하는 것은 아니다).
- 다음 할 일: 레퍼런스 데이터셋을 기존 차종 마스터 적재 경로의 한 원천으로 합친다(시험 실행 기본 → 계획 digest 승인 → 쓰기 주인 검사·access.write → 되읽기). 합친 뒤에만 실행기를 다시 연다. 차종 마스터 정비 순서는 차종 마스터 세션이 정한다.

### 2026-10-04 급한 작업 세션 하루 기록 — 휘발성 방지(대표 «작업한 것들 단단히 붙들어 둬라»)

- 비공개 작업 기록: 회사 드라이브 비공개 폴더 «급한작업 작업기록 2026-10-04»(ID는 ai-ops 비공개 인수인계에만). 임시 폴더 전체 압축(파일 502개, 원본 3,010MB → 43MB, 무결성 확인) + 핵심 파일 13개(계획·적용 영수증·원문 점검표·지지오토 조회 목록·원문 정정 기록). 차량번호는 이 공개 문서에 적지 않는다.
- 운영 적용 회차(전부 `apply-vehicle-name-reference-repair` 또는 `rename-vehicle-models`, 개인 백업 → 단일 트랜잭션 → 되읽기; 백업은 운영자 PC `~/.codex/private/freepass-data-vehicle-name-backups` 와 위 드라이브 압축 안 `private-backups/`):

| 시각(UTC) run | 대상 | 건수 | 원천/계획 digest 앞 16자 |
|---|---|---|---|
| `2026-10-04T03-56-13-433Z-3cabe1de…` | products.sub_model | 59 | (위 «첫 적재» 항목) |
| `2026-10-04T04-17-25-043Z-e50b50f4…` | vehicle_trim_master.trim | 25 | plan `8a5d4d9c8302352…` |
| `2026-10-04T04-24-57-504Z-34dc862a…` | vehicle_trim_master.trim | 4 | source `401247c185c288cb` |
| `2026-10-04T04-29-44-634Z-4fa64829…` | products.sub_model (판매 범위) | 89 | source `b739160eaeb5878b` |
| `2026-10-04T04-36-21-448Z-37f8dc4f…` | products.sub_model (판매 범위 2차) | 33 | source `9d62df6d3cb65717` |
| `2026-10-04T04-49-13-329Z-3583aa6d…` | products 2 · vehicle_trim_master 4 | 6 | source `aba7e6aa5fe052dd` |
| `2026-10-04T04-51-54-233Z-075abe58…` | vehicle_master 1 · products 11 (별칭) | 12 | source `3e441aba4b6e6ec3` |
| `2026-10-04T05-26-05-436Z-fb146bcb…` | 레이 빈 sub_model 채우기 | 5 | plan `3ae9aef0d0816598` |
| `2026-10-04T05-26-13-568Z-21ab7599…` | products.trim_name | 1 | plan `61885abc54ea963d` |
| (rename) | 공유 VehicleModel 세부트림 KA4 | 3 | plan `23c7bd579cb22f2b` |

- 첫 박제(공통 시트 → Canonical): products 159 · RAW 206 (위 «첫 적재» 항목에 digest·숫자).
- 공급사 원문 점검(읽기만, 10-04 오후):
  - 옵션 원문: 공통 시트 206줄 중 옵션 있는 184 · 빈칸 22. 공급사 시트(웰릭스·빌린카 등 12곳)에 있는 158대는 옵션 글자까지 전부 같음(0 불일치). 빈칸은 공급사 원문에도 없음(에스에이 17 — 원문.전체.옵션 빈칸, 우리캐피탈 1 등 — 우리가 지운 것 아님). 이상값: `-` 7 · 트림이 옵션 칸에 들어간 1 · 내용 없는 빈 줄 2.
  - 차명 원문(products 1,760 + 공통 시트에만 있는 12 = 1,772): Codex 전수 판정 정상 1,567 · 비어 있음 49 · 모순 65(그중 입력 연식 의심 42) · 깨짐 91. 판매 중 545대: 정상 502 · 비정상 43. 공통 시트 204대: 정상 182 · 깨짐 13 · 모순 9.
  - 지지오토 조회 목록: 비정상 중 «원문 + 연식·최초등록 + 상식 규칙»으로도 세부모델이 안 정해지는 차만 Codex 2차로 걸러 42대(판매 중 5 · 공통 시트 5, 그 순서로 정렬). 원문으로 정해지는 94대는 조회하지 않는다(별도 목록). 번호 없는 2줄은 조회 불가.
- 열린 것: #337 매일 박제 신원 계획(대표 승인 대기 — 전용 데이터베이스 vs 맞춤 역할+조건+감지) · 그 전까지 매일 박제는 운영자 PC 수동 · 지지오토 42대 조회는 AI 상황실이 다음 날 아침부터(결과는 «정정 원문(출처·시각)»으로 박제, 공급사 첫 원문은 그대로) · F03 을 기준으로 읽는 곳 7군데 전환(차종 마스터 세션 계획, #340).
- next_start_here: 차 한 대씩 이름 맞추기는 멈춤(기준 한 장 규칙 13). 차종 마스터(프리패스 데이터 vehicle_master·vehicle_trim_master) 정비 «마스터 완료» 알림 → 공급사 시트·공통 시트·프리패스 데이터 차종 칸 일괄 계산 → 그때 F03 읽는 코드(드롭다운 원천·이름 정정 실행기·이름 변경 계획 원천)도 마스터 기준으로 바꾼다.

### 2026-10-04 차종 마스터 전담 세션 하루 기록 — 휘발성 방지(대표 «작업한 것들 단단히 붙들어 둬라»)

- **세션**: `[B3Q] FREEPASS-DATA · 차종 마스터`(옛 «고도화 전 정리», 대표가 10-04 차종 마스터 전담으로 지정). 대표가 이 창에서 직접 오더·보고.
- **작업기록 원본(비공개 회사 드라이브)**: 폴더 «차종마스터 작업기록 2026-10-04»(ID 는 비공개 저장소 ai-ops 인수인계에만) — 임시 폴더 `fp-move` 통째(zip 379개: 계획 JSON·실행기·Codex 검토 기록·시트 스냅샷·백업 ID) + 참고 17개(다나와 13개 브랜드 타임라인 `brand-*.json`, 엔카 확인 필요 행 수집 `encar-held-20261004.json`, F03↔프리패스 데이터 대조 `diff.json`·범위 `scope.json`·다나와 대응 `match.json`). 업무 데이터(차량번호 포함 스냅샷)는 이 드라이브에만 두고 저장소에는 넣지 않는다.
- **F03 시트 적용 회차(그 뒤 F03은 투영으로 전환, 쓰기 멈춤)** — 시트 쓰기는 이 세션 권한 판정에 막혀 대표 승인으로 AI 상황실이 실행, 되읽기 다른 행 0·재감사 위반 0:
  - 차종 4단 구조 최종(세부트림 파워트레인 버림·셀토스 SP3·제원 구동 3값·파워트레인_보조 2,324행): 백업 사본(ID 는 비공개 기록), 차종마스터 262칸·별칭 갱신 27·추가 151
  - 인승 뗌·기아 X-Line: 백업 사본(ID 는 비공개 기록), 28칸·별칭 17
  - BMW xLine·현대 H-Pick: 백업 사본(ID 는 비공개 기록), 13행·별칭 13
  - 행 추가 후보(그랜드 스타렉스 CVX 프리미엄 1행·세부모델 별칭 5): 백업 사본(ID 는 비공개 기록)
  - 투영 표시: 네 탭 A1 메모 «투영 — 직접 수정 금지, 정본은 프리패스 데이터»(값 변경 없음)
- **코드·문서 PR**: 정본 함수 #325(파워트레인 표기)·#331(인승 뗌·X-Line)·#332(제조사별 공식 표기), 기록 #327·#335, 옮기기 계획 #340(SSOT F03 절 «F03 → 프리패스 데이터 차종 마스터 옮기기»).
- **기준 한 장(ai-ops `docs/차종-기준-한장.md`) 오늘 커밋**: 990cea1·9f87452(다나와 기준 — 이후 대체) → ed8a872(엔카·다나와 둘 다 근거, 이름은 우리 규칙) → 8ccba18(0-1절 «어기지 말 규칙» 1~12, 특별 이름 우선 «쏘나타 디 엣지 DN8») → 5ecbe75(13 마스터부터, 그다음 일괄 계산) → 7f70f75(14 출시 수식어 안 붙임 «그랜저 IG·더 뉴 그랜저 IG·그랜저 GN7·더 뉴 그랜저 GN7») → 798a819·682cbbb(15 하이브리드·전기차 세부모델 따로, 모델명 뒤·코드 앞) → 99b1921(16 파생 낱말은 제조사가 붙인 그대로 — 하이브리드·일렉트릭·EV·EVX). 상황실 쪽: 72ff613(정본 = 프리패스 데이터, F03 투영), 근거 셋(옛 F03·다나와·엔카).
- **숫자(읽기만)**: F03 활성 세부트림 1,605 중 프리패스 데이터와 같음 490·이름 없음 449·세부모델 없음 661. `products` 1,760대가 쓰는 F03 세부모델 129·세부트림 224행, 그중 마스터에 없는 세부모델 34개. `products` 세부모델 이름이 마스터와 안 이어짐 817대. 다나와 대조: F03 세부모델 268 중 같은 이름 42·바로 대응 86·후보 여럿 35·없음 80·미수집 브랜드 25(벤츠·BMW·아우디·도요타).
- **남은 결정(대표)**: 세부모델 별칭 칸을 프리패스 데이터에 만들지 · 토레스 여섯 줄안(토레스 J100 / 더 뉴 토레스 J116 / 더 뉴 토레스 하이브리드 J140 / 뉴 토레스 J150 / 뉴 토레스 하이브리드 코드 확인 필요 / 토레스 EVX U100 — 제조사 표기 따름) · 규칙 «기준 v1 확정» 잠금 여부.
- **GPT 무료 채팅 수집**: 대표가 크롬 ChatGPT(Profile 1)에 다나와 수집 오더를 직접 넣음 — 이 세션이 지켜보기 담당, 아직 그 창을 열어 진행을 읽지 않음(화면 쓰기 전 상황실에 «화면 씀»). 결과는 참고 자료, 묶음마다 무작위 10% 다나와 화면 대조.
- **멈춘 것**: F03 쓰기(투영 전환), freepasserp4 `repair-f03-ssot-projection` 자동 쓰기(#556), 급한 작업 세션의 차 한 대씩 이름 정정(규칙 13 — 이미 들어간 KA4 3대·레이 5대·스타렉스 1대는 PR #338 기록).
- **next_start_here**: 남은 결정 받기 → 기준 v1 잠금 → `products`가 쓰는 세부모델 34개 + 하이브리드 분리부터 프리패스 데이터 차종 마스터 정비안(엔카·다나와·옛 F03 나란히, 우리 규칙 1~16) → Codex → 반영 → F03 읽는 곳 전환(#340 순서) → «마스터 완료, 일괄 계산 시작»을 급한 작업 세션에.


### 2026-10-04 이름 정정 3건 운영 적용 (빈 세부모델 채우기 · 상품 세부트림 · 공유 차종 이름 변경)

- 코드: main `d650022`(#333 빈칸 채우기·상품 세부트림, 근거는 `audit_events`) · `a451d17`(#336 `rename-vehicle-models`, 거래 안 참조 상품 전체 대조). 각 건 시험 실행 → Codex OK → 계획 digest 승인 → 적용 → REST 따로 되읽기.
- ① 레이 5대 빈 `products.sub_model` 채우기(F03 «더 뉴 기아 레이» 4 · «더 뉴 기아 레이 EV» 1, 세부트림은 안 건드림): plan digest `3ae9aef0d081659825b43458fb7f01b1ed46d366195174fb0703db4afb502512`, run `2026-10-04T05-26-05-436Z-fb146bcb-c2e2-40f0-ac94-6c8d8feffde9`, 되읽기 5 · 감사 5. 상품 문서에 근거 필드 없음 확인.
- ② 그랜드 스타렉스 1대 `products.trim_name` «프리미엄 → CVX 프리미엄»(원문 CVX Premium, F03 신규 행): plan digest `61885abc54ea963dddd4706fb844c1ec6b73b044d737b12fd42153dfb24193a3`, run `2026-10-04T05-26-13-568Z-21ab7599-e57c-4ae1-a5c0-8c848e5f3fca`, 되읽기 1 · 감사 1.
- ③ 정본 공유 차종 3개(더 뉴 카니발 KA4) 세부트림 «9인승 프레스티지 → 프레스티지»(인승은 제원, F03 HEV 프레스티지 행은 통합→프레스티지, 다나와 기준도 같다고 차종 마스터 세션 확인): plan digest `23c7bd579cb22f2b72fd49f4486aef2478461cfa9b4db9248ca9d09bf6d991f7`, renamed 3 · alreadyApplied 0 · readbackOk — 모델·상품 revision 2, displayName 일치.
- 계획·백업은 운영자 PC 비공개 폴더(`~/.codex/private/freepass-data-vehicle-name-backups`)에. 차량번호는 이 공개 문서에 적지 않는다.
- 남음: 세부모델·세부트림 기준이 다나와 글자로 바뀜(ai-ops 9f87452). F03 정비 뒤 «F03 갱신» 알림을 받아 프리패스 데이터·시트 이름 맞추기. #337(매일 박제 신원)은 대표 승인 대기 — 그 전까지 매일 박제는 운영자 PC 수동.

### 2026-10-04 F03 인승 뗌 · 제조사 공식 표기(X-Line·xLine·H-Pick) 적용

- 목적: 기준 한 장 2절 5번(인승은 제원)·6번(제조사 공식 표기)을 F03 에 반영. 정본 함수 #331·#332.
- 증거: `docs/ERP-COM-GOOGLE-SHEETS-SSOT.md` F03 운영 규칙 두 줄 — 백업 사본(ID 는 비공개 기록), 되읽기 다른 행 0, 재감사 위반 0. 시트 쓰기는 이 세션 권한 판정에 막혀 대표 승인으로 AI 상황실이 실행.
- 남음(HOLD): 카니발 하이리무진 3·카니발 KA4 2·코란도 투리스모 6·옛 익스플로러 13 등 확인 필요. 행 추가 후보 묶음(그랜드 스타렉스 `CVX 프리미엄` 1행 + Data 세대코드 세부모델 별칭 5)은 적용 완료(백업 사본(ID 는 비공개 기록), 재감사 위반 0).
- next_start_here: 남은 확인 필요 행을 엔카 공개 화면으로 → 같은 방식(Codex GO → 계획·실행기 → 상황실 실행).

### 2026-10-04 vehicle_trim_master 세부트림 정정 운영 적용

- main `5e04298`(#328) 의 `apply-vehicle-name-reference-repair` 로 적용: run `2026-10-04T04-17-25-043Z-e50b50f4-73bc-4133-89b6-345f9f609ee6`, plan digest `8a5d4d9c8302352489037562ba5fcd33e50ee7ecab51fba96cf2f3005dd4c542`, 개인 백업 뒤 단일 트랜잭션, trimCount 25 · 되읽기 25(옛 이름 `trim_aliases` 보존 확인 포함).
- 재조회: 표기·엔진 접두 차이 26건 중 25건 F03 이름과 일치, 남은 1건은 같은 등급 근거가 없어 제외한 MINI `JCW ALL4`. sub_model parity audit 은 변화 없음(이슈 648 · 영향 products 394 — 세부트림 정정은 sub_model 을 건드리지 않는다).
- 기존 HOLD(이번 범위 밖, 다음 순서는 AI 상황실이 정함): F03 대조 기준 vehicle_trim_master 일치 803 · 세부모델은 맞으나 F03 세부트림에 같은 이름이 없는 행 241 · 세부모델 이름이 달라 대조 못 한 행 1,008.

### 2026-10-04 공통 시트 첫 적재 운영 적용 · Catalog writer 소유권 이전 · 이름 정정 적용

- products 이름 정정 59건(표기 56·분류 3) 운영 적용: F03 최종안 재조회로 to 이름·현재 from 59/59 확인 뒤 기존 `apply-vehicle-name-reference-repair`, run `2026-10-04T03-56-13-433Z-3cabe1de-dd89-4f36-889e-eaebcfff6c60`, 개인 백업 뒤 단일 트랜잭션, 되읽기 59/59. 적용 뒤 parity audit: 공통 시트 차 이슈 61→0, 전체 이슈 721→648, 영향 products 466→394.
- Catalog writer 소유권: SHARED_MIGRATION(data·admin) → EXCLUSIVE `service:freepass-data`, revision 1, 되읽기 OK(plan digest `d7081c10…`, rollback = before-image).
- 첫 적재(공통 시트 + `--erp5-capture` + `--supplement`): run COMPLETED·head CURRENT, RAW 206(차 203 + 번호 빈 행 3, HOLD 47 포함)·공급사 입력값 198·정정 이력 168행·후보 206. Canonical products 159(노출 ACTIVE 92 · 비노출 HOLD 67)·자산 159(차량번호 유일)·offer 159·sourceFirstRunId 159. 기간 대사 저장 566 = 제공 566(+HOLD 146 = 712), 되읽기 어긋남 0. 수수료 KNOWN 391·UNKNOWN 175(전부 null). plan digest `b76bfc3c…`.
- 3대 조회(query-canonical-by-plate): 노출 1·비노출 1 정상, 가격 기간 없는 HOLD 1 은 Canonical 0건(RAW·공급사 입력값만).
- vehicle_trim_master 세부트림 정정: 기존 이름 정정 job 을 `trimRepairs` 로 확장(옛 이름 `trim_aliases` 보존, 승인은 계획 전체 digest). 계획 25건(표기 14·XM3 엔진/E-TECH 접두 11), MINI `JCW ALL4` 1건은 같은 등급 근거가 없어 제외.
- ★다음에 할 일: 가격 기간이 없는 차(10-04 6대 — NO_PRICE_TERMS 단독 HOLD)의 정본 구조 — 가격 없으면 정본값 ③을 만들 근거가 없어 지금은 RAW·공급사 입력값만 둔다(AI 상황실 10-04).

### 2026-10-04 F03 차종 4단 구조 최종 적용(세부트림·셀토스 SP3·별칭·제원·파워트레인_보조)

- 목적: 차종 기준 한 장(ai-ops `docs/차종-기준-한장.md`)대로 F03 세부트림에서 파워트레인을 통째로 버리고, 버린 파워트레인은 새 탭 `파워트레인_보조`에 모은다. 제원 구동은 2WD·4WD·AWD 세 값.
- 증거: `docs/ERP-COM-GOOGLE-SHEETS-SSOT.md` F03 운영 규칙 「차종 4단 구조 최종 적용」 줄 — 백업 사본(ID 는 비공개 기록), 되읽기 다른 행 0, 재감사 위반 0.
- 남음(HOLD): 세부트림 확인 필요·엔카 근거 없음 63행, Data 표기 차이 목록(급한 작업 세션), F03 기본형 parity 61.
- next_start_here: 공통 시트·Data 가 F03 새 세부트림 이름을 가져가는지(급한 작업 세션 «F03 트림 갱신») 확인 → `npm run audit:vehicle-name-parity` 재실행.

### 2026-10-04 보충 JSON 준비(공급사 입력값·정정 이력) · 다음에 할 일

- 보충 JSON(비공개, Drive 사본): 공급사 입력값 `SHEET_BACKUP` 6대(products 없는 11대 중 번호가 정해진 차 — 그날 아침 «정본v1 적용 전» 백업 사본의 각 공급사 탭 행, 칸 이름 그대로) + 정정 이력 481건(10-04 칸 변경 기록 488줄 중 번호 미배정 「신차·미정」 7줄 제외, 시각은 UTC). 번호 미배정 5대(신차 4·미정 1)는 차량번호 키가 없어 공급사 입력값을 붙이지 않는다 — 그 행 원문은 RAW 로 남는다.
- 검증: main 의 `capture:shared-sheet --supplement` 로 실제 공통 시트와 합쳐 형식 통과(레코드 206 · 공급사 입력값 6 · 정정 481, 종료코드 0). 첫 적재 때 `--erp5-capture`(products.원문 184+8대)와 함께 쓴다.
- ★다음에 할 일 — Canonical 쓰기를 켜기 전에 꼭: ERP5 등 다른 적재기의 «공통 차량번호 유일성 보장». 공통 시트 적재는 자산 ID 를 차량번호에서 만들어 트랜잭션 안에서 중복을 막지만(#324), 다른 적재기는 ID 체계가 달라 같은 번호라도 계획 단계 스냅샷 검사로만 막힌다. ERP5 경로는 지금 `canonicalWriteAuthorized=false` — 켜기 전에 같은 번호 → 같은 자산 ID(또는 번호 유일 제약)를 모든 적재기에 맞춘다.
- 다음에 할 일(유지): `powertrainText`, 원산지·차종구분·차종크기·색상·차량가격·옵션 정리값.

### 2026-10-04 차량번호 한 줄 세 겹 — 공급사 입력값(②) 보존 · 최초 회차 연결(①)

- 종착지(AI 상황실·대표, ai-ops 「차종 기준 한 장」 5절): 차량번호 한 줄 = ① 원문(처음 + 최신) ② 공급사 입력값(덮지 않고 따로) ③ 우리 정본값(F03 이름·제원·기간별 가격·수수료, 값마다 근거).
- ①: RAW 는 회차마다 74칸 전부 보존(기존). 이번에 `firstRunId`(RAW·후보) → `VehicleAsset.sourceFirstRunId` 를 더해 자산에서 처음 원문 RAW 로 바로 간다.
- ②: 공통 시트는 우리가 고친 값이 섞이므로 ②의 출처로 쓰지 않는다. `capture:shared-sheet --erp5-capture <inspect-erp5-source 캡처>` 가 기존 products 읽기의 `원문`(공급사 시트 수집기가 쓴 값)을 차량번호별로 캡처에 붙이고, 각 행 RAW 옆 `payload.supplierEntered` 로 박제한다. 같은 번호에 원문이 엇갈리면 넣지 않는다. 시트 행 digest·fingerprint 는 바뀌지 않는다.
- products 에 없는 차(10-04 기준 11대)와 정정 이력은 `--supplement <JSON>`(`supplierEntered[]`·`corrections[]`) — 한 번 쓰는 생성 절차: 그날 아침(우리가 고치기 전) Drive 백업 사본의 그 차 행을 칸 이름으로 맞춰 `SHEET_BACKUP` 으로, 칸 변경 기록(10-04 첫 묶음 488줄, Drive 비공개 사본)을 `corrections`(차량번호·시각·칸·전→후·출처)로. 이후 AI 가 시트를 고칠 때마다 같은 형식의 기록을 남기고 데일리 박제에 같이 넣는다.
- 다음에 할 일(코드 없음, 결정 대기): 정리값 `powertrainText`(F03 「파워트레인_보조」 탭 완성 뒤 판단), 원산지·차종구분·차종크기·색상·차량가격·옵션 정리값(지금은 RAW 에만 있다).

### 2026-10-04 공통 시트 203대 ↔ FreePass Data 마스터 연결 대조 · 이름 정정 계획(적용 전)

- 목적: 대표 «차종·제원 마스터를 그대로 갖다 써라 · 새 코드 만들지 마라». freepasserp5 `products` 1,760 · `vehicle_master` 1,816 · `vehicle_trim_master` 2,078(읽기 전용)과 기존 `npm run audit:vehicle-name-parity` 로 공통 시트 203대를 대조했다. #319(Data 우선 적재 규칙)는 기존 parity·repair 경로와 겹쳐 닫았다.
- 결과(203대): products → vehicle_master → vehicle_trim_master 끝까지 연결 137(이름으로 108, `master_id` 로 29), vehicle_master 까지만 47(그 master 에 trim 행 없음 24 · 트림 표기 다름 23), 연결 안 됨 8(세부모델 이름이 master 에 없음 7 · 제조사·모델 조합 오류 1), products 없음 11. F03 행 매칭 195/203(96%), 제원마스터 매칭 연료 100% · 배기량 95% · 구동 19%(구동 별칭 결정 뒤 예상 91%, 남은 18대는 빈칸).
- parity audit(F03 266 세부모델 / master 1,816 / products 1,760): FAIL, issues 721(HOLD 711 · ERROR 10), 공통 시트 차 61대가 `PRODUCT_USES_DRIFTED_MASTER_NAME` 55 · `PRODUCT_REFERENCE_NAME_MISMATCH` 6.
- 이름 정정 계획 생성 절차(한 번 쓰는 절차 — 코드로 만들지 않는다, 9-28 과 같은 방식): ① freepasserp5 세 컬렉션과 공통 시트를 읽기 전용으로 받는다 ② parity audit 의 PRODUCT 이슈 차 + 마스터 미연결 차 중 공통 시트에 있는 차만 고른다 ③ `to` = 공통 시트의 F03 세부모델(원문 대조로 확정한 값), `from` = products.sub_model. 시트 세부모델이 F03 행이 아니거나, 제조사·모델이 다르거나(이 job 은 sub_model 만 바꾼다), 확인 필요 차는 제외 ④ 기아 개발코드 규칙과 어긋나는 F03 이름(「셀토스 2세대」)으로 바꾸는 줄은 제외하고 고도화 전 정리로 넘긴다 ⑤ Codex 검토에서 «다른 차종·세대로 바뀌는» 분류 정정은 별도 승인 목록으로 뺀다 ⑥ 기존 `apply-vehicle-name-reference-repair` dry-run 으로 형식을 확인한다.
- 계획: product 57건(master 0), sourceDigest `0e3f1d5abba038d93cfc254832ab727c9081d2e8b440cb54d1ea9924f6d7fa70`, dry-run DRY_RUN. 분류 정정 2건(픽업→SUV 1 · 다른 세대 1)은 별도 승인 목록. 계획·차량별 목록은 비공개 위치에만 있다(공개 저장소라 차량번호 없음).
- 적용 조건: F03 전체 정비(고도화 전 정리) 뒤 기존 apply 경로(정확한 sourceDigest 승인 · 개인 백업 · 단일 transaction 전제조건 · 감사 · 되읽기). 적용 전 F03 재조회로 `to` 이름이 그대로인지 다시 맞춘다.
- 남음: trim_master 행 없는 24대분 · 트림 표기 차이 23대(고도화 전 정리), 제원마스터 구동 별칭(FWD·RWD→2WD, 4MATIC·콰트로·xDrive·4MOTION·HTRAC→AWD, 4WD 는 원문이 4WD 일 때만), 공통 시트 차종 칸 되쓰기(Data → 시트, gws 백업·쓰기·되읽기, 공급사·사람 입력값은 덮지 않고 표시) — F03 정비와 이름 정정 뒤 한 번에.

### 2026-10-04 공통 시트 캡처 수집기 · 모든 차 박제 규칙 · 시트 차종 정리 운영 기록

- 결정(AI 상황실 = 대표 오더, 10-04): ① 들어온 모든 차를 Canonical 에 넣는다. 시트 «차량상태»는 원문 그대로(`sourceVehicleFacts.supplierStatus`) 보존하고 노출만 가른다 — 출고가능·즉시출고 = Product ACTIVE(노출), 출고협의·계약중·상품화중·출고불가 = Product HOLD(비노출). 목록 밖 상태·이후 상태 변경은 HOLD(`SHARED_SHEET_STATUS_POLICY`, `STATUS_CHANGE_REQUIRES_REVIEW`). 자산 상태 매핑 중 출고불가 → RESERVED 는 임시값이다. ② 한 줄이 틀려도 나머지는 박제 — 74칸 형식이 깨진 줄·같은 공급사+차량번호 중복은 그 줄만 위치 키로 RAW 보존 후 HOLD. 숫자 없는 차량번호(「신차」 등)는 식별자가 아니다. ③ 정리값은 «FreePass Data 에 이미 있는 값 → F03 별칭으로 F03 이름» 이 먼저, 원문 재해석은 Data 에 값이 없거나 원문과 모순일 때만.
- 변경: `capture:shared-sheet`(Sheets values.batchGet + 격자 행 수로 15탭 전체 범위일 때만 complete), 위 ①② 규칙, `CanonicalizationDecision.productStatus`. 계획 사전검사·소유권 이전 job 은 #313.
- 실측(로컬, 실제 시트 캡처 → 빈 Catalog 기준 계획, 쓰기 0): 레코드 206(차 203 + 차량번호 빈 줄 3), CREATE 157 / HOLD 49(연식↔최초등록 불일치 26, 차종 식별 불완전 12 등). 제공 기간 712 = 계산 712. CREATE 중 수수료 확정 기간이 있는 차 120, 모든 기간 확정 86. 계획·캡처는 비공개 경로에만 있다.
- 시트 작업(빠른 길, 백업 → 쓰기 → 되읽기, 모든 회차 되읽기 불일치 0). 백업 Drive 사본: `1MOZOlbofJiZoLucn3p6PWJW33q8tCPuqgNe_N7YpGuc`(원문 판정·지지오토 전), `16iZFQOWCL8hdDrTsMQAFMK9tyUJRATr-jXz_wcGzqi4`(제원 정정 전), `1K9eVE5TM_EDEMv5icdjo0UmmBgcwhG8iKCWKQG663cI`(Data 대조 전). 바꾼 칸: 원문 판정·지지오토 36, 제원·연식 27+10, F03 신규 행 반영 14+13+6, Data 대조·F03 개명 6. 차명 원문을 지지오토로 정정한 줄은 비고에 «지지오토 정정 10-04 / 공급사 원문: …». 결과: 시트 203대 중 F03 4칸 일치 190 이상, 세부트림 빈칸 9 → 8(남은 것은 원문·Data·F03 어느 쪽으로도 하나로 안 정해지는 차 — 확인 필요).
- Data(ERP5 products) ↔ 시트 대조(104줄): 이름 규칙 차이만 23, 세부모델 같고 Data 트림이 F03 이름 아님·빈칸 29, 시트가 원문과 맞음 33, Data 가 원문과 맞아 시트를 고침 3, 확인 필요 10, Data 없음 6. Data 쪽은 하이브리드·E-TECH 누락, 「더 뉴」 세대 누락, 제조사 오류 등 원문과 어긋나는 값이 있어 그대로 채택하지 않는다.
- 남음: Data 우선 단계(Data 값 → F03 → 원문과 모순 없을 때만 채택)를 적재 계획에 넣기. ERP4 수동 단계(쓰기 신원으로 캡처·dry-run·apply) — 시트 공유 대상은 `github-inventory-writer@freepasserp5`, 공유는 대표 답 대기. 확인 동선 등록 스크립트 장애(AI-OPS 수리 중). 상태 변경(노출 전환)을 검토 명령으로 반영하는 경로.
- next_start_here: #313·#315 머지 → `ownership_dry_run` 실행(숫자) → Codex → ERP4 수동 단계 PR → 203대 운영 dry-run → apply → `query-canonical-by-plate` 3대 되읽기.
- Data(ERP5 products) 쪽 정정 목록(원문과 어긋남 — 시트는 원문 기준 F03 값을 유지, Data 는 고칠 대상. 차량별 목록은 비공개 판정표 `시트-vs-Data-판정-20261004.md`): 그랑 콜레오스 E-TECH 하이브리드를 비하이브리드 등급으로(ECH 누락) 16대, 하이브리드 세부모델 누락(카니발 KA4 HEV 3·그랜저 4·K5 1) 8대, 「더 뉴」·세대 누락(카니발 KA4·그랜저 GN7·쏘나타 디 엣지·모닝 JA·K9 RJ 등) 9대, 니로 세대 오류(더 뉴 니로 SG2 → 디 올 뉴 니로) 2대, 렉스턴 → 렉스턴 스포츠 오류 1대, 아반떼 MD·뉴모닝·SM7 New Art 를 최신 세대/기본형으로 잘못 둔 것 3대, 제조사 오류(아우디를 기아) 1대, 등급을 옵션·런칭 표기로 둔 것(파이니스트→런칭, 아이코닉 컬러패키지, S350 d → S350 BlueTEC) 5대. 반대로 Data 가 맞아 시트를 고친 것 3대(세대·N Line·기본형), Data 근거로 시트 연식·최초등록을 고친 것 1대(더 뉴 팰리세이드 2023).

### 2026-10-04 F03 세부트림 규칙 남은 행 · 신규 행 · 기아 세대 별칭

- ★현행 규칙(2026-10-04 대표 최종, 아래 옛 규칙 문구를 대체): 차종 4단 구조 «모델 → 세부모델 → 파워트레인 → 세부트림» — 파워트레인(배기량·엔진 이름 TCe·dCi·TSI·TDI·VGT·터보·GDi·VVT·e-S/C 등·연료·구동)은 제원 칸이라 차종 마스터에 통째로 쓰지 않는다. 세부트림 = 엔카 세부등급 그대로, 없으면 등급 이름에서 파워트레인을 버린 나머지, 남는 게 없으면 기본형. 「엔진 이름은 남긴다」는 철회됐다 — `ERP-COM-GOOGLE-SHEETS-SSOT.md` 「차종 4단 구조」 절과 `src/domain/vehicle-trim-name.ts`가 정본.
- (당시 기록) 목적: 세부트림 규칙(정본 `src/domain/vehicle-trim-name.ts` — #310·#312·#314 당시: 배기량·연료·구동만 뗌, 엔진 이름 남김 — 이후 철회, 배기량 뒤 터보·T·D와 붙은 배기량도 뗌)을 F03 전체에 반영하고, 공통 시트에 나왔지만 F03에 없던 차를 추가.
- 변경(시트, 모두 Codex GO·백업·재조회·RAW·되읽기 다른 행 0·불변 ID 그대로): 남은 행 이름 변경 51·통합 9·확인 필요 9·별칭 60, 신규 6행(아반떼 CN8·아반떼 MD·뉴모닝·GV80 기본형·SM7 New Art·G90 RS4 기본형), 기아 세대 별칭 17줄(구분 `세대`), 정정(엑센트 VVT·SM7 V6 원복, G80·G90 구조변경 확인 필요). 기록: `ERP-COM-GOOGLE-SHEETS-SSOT.md` F03 절. 엔카 증거 파일은 세션 임시 폴더(공개 화면 관측, 저장소에 넣지 않음).
- 남음: 확인 필요(카니발 KA4 인승 갈림, 엑센트 모던·프리미엄, PV5 플러스, SM6 LPe PE, G80·G90 구조변경, 쏘나타 디 엣지 비즈니스 1/2, 셀토스 2세대 개발코드), 엔카 증거 없는 세부모델(구형 익스플로러 등)은 손대지 않음, ERP4 발행기 이름 기반 ID·운영 매뉴얼 최종본 PR, 별칭 E열 `vmt_` 15줄.
- next_start_here: 확인 필요 행은 공급사 원문(확인 동선) 또는 엔카 공개 화면으로 하나가 정해질 때만 같은 절차로 고친다. 새 차가 F03에 없으면 엔카 공개 화면 끝 이름을 규칙 파일로 바꿔 신규 행(키는 그 모델 기존 모델행키를 만든 제조사 이름으로 계산).

### 2026-10-04 F03 세부트림 규칙 B(파워트레인 뗀 등급 이름) — 규칙 파일 · 급한 분 적용

- (당시 기록 — 현행 규칙은 위 「차종 4단 구조」) 목적: 대표 확정 「세부트림 = 엔카 끝 이름에서 배기량·연료·구동을 뗀 등급 이름, 없으면 기본형」. 떼는 낱말을 세션마다 다르게 고르지 않도록 `src/domain/vehicle-trim-name.ts` 하나로 고정(시험 `tests/vehicle-trim-name.test.ts`). (당시 판단: 엔진 이름은 남기고 연료 표시는 뗀다 — 2026-10-04 대표 최종 «파워트레인 통째로 버림»으로 철회.) 새로 판단이 갈리는 낱말은 `TRIM_UNDECIDED_TOKENS`에 두고 그 행 이름 변경을 보류한다.
- 변경(시트): 공통 시트 203대 세부모델 먼저 — F03 11행 이름 변경, 21행 확인 필요 표시, 별칭 11줄. 백업 `1tzNG4bbVmq6M2hErrZ4V8aGtP3YS9B2Cf31XNToDQMs`, 되읽기 기대값과 다른 행 0. 문서: ERP-COM SSOT 운영 규칙(엔카와 다른 점 5., 세부트림 줄), 런북 ⑤, 공통 시트 규격 `basicTrimRule`.
- 남음: F03 나머지(규칙 적용 이름 변경 약 50행·연료·엔진만 다른 행 「통합→」 약 25행)와 엑센트 신형(엔카 이름 미확인) — 같은 절차(Codex 검토 → 백업·재조회·RAW·되읽기). 판단 갈리는 낱말 7개 결정. 카니발 KA4 등 엔카가 인승으로 가르는 등급의 F03 행 정리.
- next_start_here: `trim-final-plan` 생성기(규칙 파일 결과 + 엔카 증거 우선 + 통합 대표 행 + 판단 낱말 보류)로 나머지 계획 → Codex 검토 → 적용.

### 2026-10-04 공통 시트 RAW → Canonical 로컬 구현

- 목적/정본: 74칸 공통 입력시트의 원문·정리값·기간별 수수료를 기존 SourceIngestionStore/CatalogStore로 연결. `work/freepass-data/sheet-to-canonical-20261004`, HEAD 및 로컬 origin/main `515845dd4a8a113f1c1a908be73b928cd1003338`(#296/#302/#303 포함). Git 쓰기·운영 Firestore/구글/원격 접속 없음.
- 변경: [설계 한 장 및 운영 준비](SHARED-SHEET-CANONICAL-DESIGN.md). 캡처 JSON 어댑터, 순수 정리기, 계획 digest/expectedRevision/EXCLUSIVE writer를 검사하는 dry-run·apply job, 운영자 로컬 조회 job. RAW/최초 관측/lineage/revision 보존. 공급사별 집계·수수료 UNKNOWN·기간 대사, 원천 변경/부분 재실행 시험. 기존 구조 변경 BLOCKED는 HOLD.
- 검증: Academy READY. 신규 30/30, 관련 회귀 포함 64/64 PASS. `npm run check` 실행: 아키텍처·데이터 접근 경계·build 및 Node 시험 139/139 PASS; Vitest 1,379 PASS / 9 FAIL / 14 SKIP(총 1,402, 122파일). 9 FAIL은 기존 4파일의 실행 환경 문제: tsx 자식 프로세스의 `uv_os_get_passwd ENOMEM` 계열 7, jq 실행 권한 거부 1, 로컬 Finder 서버 연결 거부 1. 해당 4파일을 단일 worker로 다시 실행해 동일 9건 재현. 전체 check는 미통과다. `npm run check:standards` 별도 실행 PASS(30 schemas, 시험 15/15); 기존 platform profile PARTIAL·미해결 capability 9개 유지. `git diff --check` PASS.
- 남음: 운영 203대 캡처/대사·저장/조회 실물 확인, 실제 writer 소유권과 ADC/IAM 확인, 다른 원천의 기존 차량 binding 정리. Claude 독립 검토는 네트워크 금지로 UNAVAILABLE. 15분 상시 엔진/워크플로/소비처 발행 미연결. 운영 완료로 판정하지 않는다.
- next_start_here: 정상 실행 환경에서 실패한 기존 9검사와 Claude 읽기 전용 검토 → 설계 문서의 운영 준비 → 비공개 실제 캡처를 `--firestore` dry-run하여 계획·HOLD·기간 대사 검토 → 해당 계획 digest로 apply → 운영자 로컬 조회. 이번 로컬 세션에는 운영 실행 권한을 사용하지 않았다.

### 2026-10-04 F03 차종마스터 대표 최종 규칙 적용 · 세부트림 «끝 단» 대조

- 목적/대상: AI 상황실 오더(대표 최종 10-04 — 엔카와 다른 점은 기아 개발코드·괄호 없음·기본형·제조사 짧게). F03 `1oMB9eoNnQFxUyRK4CSxYh_hKrtCf7s_79xLs-GYwXCE`, 문서 기준 main `609e82a`.
- 변경(시트): 백업 `1S7cHo_YlKGa7I32UDrLdoDDiEx6AZDqqpIR8twi6tms` 후 597행·1,307칸(제조사 371 → 쉐보레·르노·KGM, 세부모델=모델 338 → 기본형, 볼트(Volt) → 볼트 Volt), 별칭 26줄 수정·69줄 추가. 변경(문서): `ERP-COM-GOOGLE-SHEETS-SSOT.md` 운영 규칙에 «엔카와 다른 점 — 이것뿐», «세부트림 = 엔카 맨 끝 단», 3차 반영 기록·후속 HOLD, 검증 기록에 세부트림 대조.
- 검증: Codex `gpt-6-astra` 계획 검토 NO-GO(셀토스 별칭 키 하나) → 수정 → GO. 쓰기 직전 전체 재조회 = 검토 스냅샷, 되읽기 기대값과 다른 행 0, 불변 ID 그대로, 원자ID 1,678·중복 0. 남은 위반: 기아 `셀토스 2세대` 4행. 세부트림 끝 단 글자 일치 65/87(74.7%, Codex 독립 판정), 불일치 22는 안 고침.
- 남음(HOLD): 세부트림 「기본형」 해석(글자대로면 맞는 트림 29행+후보 13행이 기본형으로 뭉침 — AI 상황실 결정 대기), 세부트림 불일치 22행 정정, ERP4 발행기 이름 기반 ID(돌리지 않음), 공동 시트 차종목록·채운 값 재계획, 별칭 E열 `vmt_` 15줄, ERP4 운영 매뉴얼·projection·makerForMatch 최종본 PR, 셀토스 2세대 개발코드.
- next_start_here: AI 상황실의 「기본형」 결정을 받아 세부트림 반영 계획 → Codex 검토 → 같은 절차(백업·재조회·RAW·되읽기)로 적용.

### 2026-10-04 차종 정제 계층 순서 회귀 수정

- 목적/대상 revision: 제조사→모델→세부모델→세부트림 순서 강제. `ef3630b93cf61de3b1620943d649e40525dfc014`(#296 머지), `work/freepass-data/refine-order-20261004`. 파일 수정·로컬 검사만 수행, Git 쓰기·운영 데이터/Firestore/시트 접속 없음. academy:start READY.
- 변경: 원문 사실 묶음에 maker/model/subModel·필드 근거 보존, 기존 normalized 저장/로더에 선택 subModel 전달. 승격 selector 전에 모든 원문 계층을 ACTIVE anchor 부모·refs·이름과 대조하여 불일치/미정 HOLD. Catalog는 세부모델 없는 트림 저장을 거부하고 LINK 공백 일치 금지. 정제 순서 정본: `LEGACY-NORMALIZATION-RULES.md`.
- 기존 시험 조정: `쏘렌토`/`더 뉴 쏘렌토`를 모델명 차이를 무시하고 합치던 fixture를 모델 `쏘렌토` + 세부모델 `더 뉴 쏘렌토`로 명시했다. builder fixture 3곳에 상위 계층을 추가했다. 신규 저장 경로·별칭 추론 없음.
- 검증: 관련 6개 파일 30 PASS(지정 3개 회귀명 포함, 입력 불변·부모 불일치·세부모델 저장/재읽기·LINK 공백 포함), build PASS. 전체 `npm run check` 실행: 정적/규격/경계/시트/build/Node 시험 PASS, 최종 Vitest 1,334 PASS / 9 FAIL / 14 SKIP(4개 시험 파일의 환경 실패), 전체 exit 1. `check:standards` exit 0, 15 PASS; 기존 capability 미해결 상태 PARTIAL 유지.
- 남음: 전체 검사 CLI/로컬 서버 환경 실패(`tsx` 초기화 `uv_os_get_passwd ENOMEM`, `jq Permission denied`, 로컬 서버 ECONNREFUSED). 최소 `node --import tsx -e`도 같은 ENOMEM 재현. Claude 검토는 FAILED/CLAUDE_PROCESS_FAILED(exit 1), 독립 검토 UNAVAILABLE이며 PASS 아님. 세부모델 없는 기존 파서 출력은 원문 사실로 보존하지만 승격은 HOLD; PHASE 이름을 임의 보충하지 않는다.
- next_start_here: 위 diff와 3개 회귀 시험 검토 후 환경을 정상화하여 전체 check 및 Claude 독립 검토 재실행. 커밋·배포·운영 적용은 이 작업 범위 밖이다.

### 2026-10-04 PR1 — 기간별 경제조건 재계산 job (로컬 구현 / 운영 HOLD)

- 목적/정본: #296 이후 `sales-commission-2026-10-04`로 기존 Offer를 재계산할 dry-run 기본 job과 전용 거래 명령. 대상 `work/freepass-data/recompute-economics-20261004`, 기준 `ef3630b93cf61de3b1620943d649e40525dfc014`. 사용자 범위대로 Git 쓰기·외부 네트워크·운영 Firestore·자격증명 접근 없음.
- 재사용: Academy READY(`COMPOSE_OR_EXTEND`); `updateOfferPrice` 거래 구조와 `precomputeOfferEconomics`, CatalogStore, bootstrap/firebase-target 재사용. 기존 일괄 재계산 진입점이 없어 전용 job/시험을 추가했다. 가격 변경 명령을 재사용해 감사 의미를 바꾸지 않는다.
- 변경: `recomputeOfferEconomics`/전용 field-authority, 정책·전체 입력 digest·expectedRevision 고정 plan, 공급사/기간/상태/변경 원인/UNKNOWN 집계. 변경분만 원자적 revision/history/감사 before-image/outbox/receipt 저장. writer 기록 누락·충돌·입력 drift는 HOLD; 첫 오류에서 중단하고 부분 완료 수 표시. Admin projection/worker 호출 없음.
- 검증: build PASS, 전용 메모리 15/15 PASS, 빌드된 CLI `--memory` dry-run 쓰기0/상품1/기간1/변경1 확인. `npm.cmd run check` 최종 exit1: Vitest 1341 PASS/9 FAIL/14 SKIP(121파일 중113 PASS/4 FAIL/4 SKIP); 앞단 Node 시험131 PASS, 아키텍처·데이터 접근 경계·빌드 PASS. 독립 `check:standards` exit0/15 PASS/스키마30개 컴파일, 기존 profile PARTIAL 유지. 실패는 tsx `uv_os_get_passwd ENOMEM` 계열 실행 시험과 로컬 서버 연결 실패, jq 실행 권한 거부이며 환경 제한으로 전체 통과 선언하지 않는다. `tsx` 대신 빌드된 JS의 메모리 CLI는 정상이다.
- 남음: 원격 main/Issue24/PR 및 Claude 독립 검토는 네트워크 금지로 UNAVAILABLE. 운영 apply·실제 before-image 보존 검증·Admin 재발행/응답 대사는 미실행/HOLD. 배치는 Offer별 거래이며 전량 원자 적용이 아니다. 기존 worker의 outbox 소비 영향도 운영 승인 전 확인한다.
- next_start_here: `docs/READ-RUNTIME.md` 재계산 절 순서대로 실행 revision/프로젝트/정책/범위/planDigest/백업·복구·writer를 고정해 운영 apply 승인을 받고, 별도 Admin READY 생성·활성화 승인 후 응답 집계를 대사한다. 코드 revert/보상 거래/이전 READY 재활성화는 각각 별도 복구 단계다. 먼저 제한 없는 로컬 검사 환경에서 기존 실패9개를 재검증한다.

### 2026-10-04 PR #296 4차 — 경제 금액 근거 분리

- 목적/대상 revision: `e9011ba1709825d70281ea098d6f34cbe016e8b2`, `work/freepass-data/commission-f04-align-20261003`. 파일 수정·로컬 검사만 수행; Git 쓰기·운영 접속 없음.
- 변경: 수수료 규칙 근거 `sourceRefs`와 가격 출처 `priceSourceRefs` 분리. UNKNOWN/NOT_APPLICABLE의 근거는 빈 배열, Q12 근거는 실제 계산 시에만 포함. 보증금·Admin 미계산 응답·감사와 두 JSON Schema 조건을 맞춤. Admin 복사/게이트웨이 전달/health 집계 경로 확인.
- 검증: 관련 6파일 164 PASS. `npm.cmd run check`에서 정적검사·빌드 및 Node 검사 109 PASS; Vitest 1324 PASS / 9 FAIL / 14 SKIP. 실패 4파일 단일 워커 재검사도 60 PASS / 9 FAIL. `node --import tsx` 최소 실행에서도 `uv_os_get_passwd ENOMEM` 재현; 로컬 서버 연결 실패 포함. 전체 PASS 아님.
- 남음/next_start_here: 실행 환경의 tsx 사용자 정보 조회 오류를 해소한 뒤 `npm.cmd run check` 재실행. 전체 로그는 `%TEMP%/commission-f04-r4-check.log`, 재검사는 `%TEMP%/commission-f04-r4-env-recheck.log`. 운영 반영·커밋은 수행하지 않음.


### 2026-10-04 F04 수수료표 정렬 — 로컬 수정, 커밋은 Claude

- 목적/정본: 사용자 제공 F04 수수료표 A1:M191(10-04 사본); Data `fd252b2508d4ccda5ecf8de03b587c1f9910cda4`, 가지 `work/freepass-data/commission-f04-align-20261003`. academy:start READY. 원본 자료 복사·Git 쓰기·운영 접속 없음.
- 변경: 정책 `sales-commission-2026-10-04`(10-03 객체 보존), 오토플러스 EV150만/130만, 손오공 픽업 차량가액4%/3%, 빌린카/엘씨 구독60개월2.25%/1.75%, 아이카 EV 범위 제한, 원장 상품 표현 표준화, 카탈로그/Canonical 명시 근거 전달, 비공개 계약 일치 기반 개별 예외, F04 sourceRefs/응답 스키마. 마음카 NOT_APPLICABLE. 미확정 반올림·일반 손오공60 UNKNOWN.
- 판단: 개별 합의(160·163행) 금액은 비공개 기록에만(2026-10-05 공개 노출 정리). 일반60개월은 JSON의 +60만 판정보다 사용자 명시 HOLD 우선(→ 2026-10-05 AI 상황실 결정으로 +60만 확정). 아이카 개별은 지급만 확정; 청구 UNKNOWN. 뮤카는 별도 재원·VAT·ID 계약 필요로 범위 밖/HOLD(→ 2026-10-05 구현). 실명↔ID 및 191행 전수 대응표는 `docs/READ-RUNTIME.md` 수수료 절.
- 검증: 빌드 PASS, 변경 관련5개 테스트파일128 PASS, 대응표 행1~191 누락/중복0, git diff --check PASS. 전체 npm run check의 최종 숫자/환경 한계는 READ-RUNTIME 검증 기록 참조. Claude 검토는 FAILED/CLAUDE_PROCESS_FAILED(exit1), ANSWERED 없음.
- 남음: 전체 검사 환경 오류 및 Claude 독립 검토. Canonical에 없는 입력은 reasonCode 있는 UNKNOWN; 운영 근거 수집·재저장·배포 미실행. 별도 권한/승인을 만들지 않았다.
- next_start_here: Claude가 최종 diff·READ-RUNTIME 두 대응표·검사 결과를 읽고 정상 실행 환경에서 전체 check 및 독립 검토 후 커밋한다. Codex는 커밋하지 않았다.

### 2026-10-04 공급사 관계사 15탭·연월 허용 — 로컬 변경 / 전체 검사 HOLD

- 목적: 대표·AI 상황실의 관계사 탭 통합 및 일 미상 `yy.mm` 결정을 기존 공급사 시트 규격·계획기에 반영.
- 대상 revision: `6fdae3146c521a723e4206880ac8acd0ffe08987`, `work/freepass-data/supplier-sheet-drop-account-20261004` / 사용자 지정 PR #299. Git 쓰기·fetch·구글·운영 데이터 접속 없이 작업 트리만 수정. Academy READY.
- 변경: `sharedInputSheet`는 18개 코드의 `{code, tab, companyName}` 대응이며 물리 탭은 15개. 경진카·엘씨·스카이·마음카 숨김 보관 기록, 물리 탭별 계획·캡처·종합 중복 제거, 회사명 감사, 연월 TEXT 정규화와 서식 보존, 입력 불변 회귀. 운영 기록은 사용자 전달이며 재검증하지 않음.
- 검증: `npm.cmd run check:sheets` 87/87 PASS(공급사 전용 62개). 전체 `npm.cmd run check`의 architecture·standards 검사·data-access boundary·시트·build·runtime smoke 6·shadow 10·dashboard 21 통과. 최종 Vitest 1265 PASS / 9 FAIL / 14 SKIP(119파일 중 111 PASS / 4 FAIL / 4 SKIP). standards 자체 성숙도는 기존 PARTIAL/미해결 9개 유지.
- 남음: 전체 검사 실패는 iancar-source-capture / read-pilot / runtime-policy / vehicle-finder-route 4파일. `tsx` 초기화의 `uv_os_get_passwd ENOMEM`, `jq Permission denied`, 로컬 서버 ECONNREFUSED를 관측. `node:os.userInfo()` 단독으로도 ENOMEM 재현. 14 SKIP은 Firestore emulator 미설정 10개와 Windows workflow 4개. Claude 독립 검토는 `CLAUDE_PROCESS_FAILED`로 FAILED이며 PASS 아님.
- next_start_here: 로컬 diff와 공급사 런북의 최신 규칙·운영 기록을 검토하고 실행 환경 복구 후 전체 check 및 Claude 검토를 재실행한다. 이번 작업은 commit/배포/운영 적용을 포함하지 않는다.


### 2026-10-04 공동 입력시트 계좌번호 제외 — 로컬 수정 / 운영 미적용

- 목적/정본: 대표 결정으로 공동 시트 계좌번호만 제외. PR #295 기준 `d6262f11c90befacfdb63bfd015b95b53e83716c`, 가지 `work/freepass-data/supplier-sheet-drop-account-20261004`. academy:start READY. Git 쓰기·구글/운영 데이터 접속 없음.
- 변경: `2026-10-04-no-account` 74칸(A:BV), 이전 sales 75칸과 전환 규칙은 legacy 보존. `planLayoutChange`의 사진 링크 이동은 선택 사항이며 공급사 값 재쓰기 없이 제거 열을 오른쪽부터 삭제하고 종합 머리글·수식과 남는 열을 정리한다. 값 서식·폭·드롭다운 자유 입력 판정에서 계좌번호 제외.
- 검증: `npm.cmd run check:sheets` 82 PASS(공급사 57, 신규 3). `npm.cmd run check`의 정적 검사·빌드와 Node 검사 134 PASS; Vitest 1265 PASS / 9 FAIL / 14 SKIP → 전체 check 미통과. 실패는 tsx 진입 시 `uv_os_get_passwd ENOMEM`(최소 `node --import tsx -e`로 재현; CLI 7건 및 같은 tsx 서버의 로컬 연결 거부 1건), jq 실행 Permission denied 1건. 독립 Claude 검토는 `FAILED / CLAUDE_PROCESS_FAILED`, 답변 없음(UNAVAILABLE, PASS 아님).
- 남음/HOLD: 대표 전달상 기존 9곳 중 8곳 ERP 전용계좌 일치, 퍼시픽은 F01에 없어 대조 HOLD. 제거 전 값은 백업 사본 보존이라고 전달받았으며 이번에는 원문을 재조회하지 않았다. 입금계좌 정본은 ERP 파트너 회사정보(은행·계좌번호·예금주); 판매시트 전용계좌는 그 정본에서 채운다. 운영 적용·재조회 미실행.
- next_start_here: Claude가 diff와 검사 결과를 검토하고 커밋한다. tsx 사용자정보 조회/jq 권한이 정상인 환경에서 전체 check와 독립 검토를 마친다. 운영 적용 시 런북 현재 기준과 별도 승인 범위를 따른다.


### 2026-10-03 공급사 중계 job-name 호환 수정 — 로컬 검증 일부 HOLD

- 목적/대상 revision: `work/freepass-data/supplier-relay-jobname-fix-b-20261003`, `10a729f22799eda8b8f90f01ba993b10c6f09d27`. Academy READY. 네트워크·배포·push·커밋 없이 기존 구현 확장.
- 변경: `/verify`·`/schedule`이 허용 목록의 전체 경로 또는 설정 prefix와 일치하는 짧은 ID를 받는다. 다른 경로는 거부하고 영수증은 전체 경로로 유지한다. scheduleTime 소수 1~9자리 허용 후 파싱 전 밀리초 절삭. 거부 로그는 event/path/code/reason만 포함한다.
- 검증: 회귀 4건 추가, supplier-native 35/35 PASS, `npm run build` PASS. `npm run check`의 Vitest 결과 1241 PASS / 9 FAIL / 14 SKIP. 실패 4파일(iancar-source-capture, read-pilot, runtime-policy, vehicle-finder-route)은 단일 워커 재실행에서도 9건 실패. 자식 프로세스 `uv_os_get_passwd ENOMEM`, 로컬 서버 `ECONNREFUSED` 등으로 전체 check 통과는 HOLD.
- 남음/next_start_here: 경영지원실이 diff 검토 후 커밋. 실행 환경에서 위 4파일 및 전체 check 재검증 필요. 원격 Issue/PR 조회와 Claude 검토는 네트워크 금지로 미실행. 운영 반영·실호출 검증은 수행하지 않음.

### 2026-10-03 오더4 — PR #288 공급사 중계 일반화 / 운영 HOLD

- 목적: 이안카 전용 중계를 전 공급사 허용 목록·그룹 pending·경합 관측·무쓰기 검증으로 확장.
- 대상 revision: `work/freepass-data/supplier-native-fixes-20261003` / `f7f45a8849747741e61b375463d89dc0b0b3a41d`. Academy READY. 기존 relay/transport/server/tests를 COMPOSE_OR_EXTEND(별도 서비스 구현 추가 없음). 이 checkout만 변경, commit/push 없음.
- 변경: `src/api/supplier-relay.ts`, `src/api/supplier-relay-transport.ts`, `src/jobs/serve-supplier-relay.ts`, `docs/deploy/supplier-collect-relay-배포절차.md`로 이동. package script·기존 테스트2개·NATIVE 문서 갱신. 일반 서비스/SA/env/prefix, 코드 allowlist2항목, 그룹 pending CAS, 항목별 status CAS, dispatch 직후 겹침/취소 관측, POST /verify 읽기 전용. 옛 파일 없음.
- 경합 근거: ERP4 로컬 origin/main `094155bd8e03a4269654a45b2eac6237a7796ad1`, refresh L73–80 cadence 양보 / L84–88 job concurrency / L98–107 수동 전체 회차의 이안카 sync 제한. watchdog L20–22 별도 잠금, L61–70 repository_dispatch. 원격 contents API는 네트워크 차단으로 최신 검증 실패. hourly-all은 동등 dispatch 조합 부재로 HOLD.
- 검증: 관련 테스트51 PASS, build PASS. `npm run check`의 architecture/standards/boundary/sheets57/build/runtime-smoke6/shadow10/dashboard 통과, 최종 Vitest **1210 PASS / 9 FAIL / 14 SKIP** (Codex 샌드박스 환경 오류; Claude 정상 환경 재실행 exit0, Vitest 1219 PASS / 14 SKIP). 실패 파일: iancar-source-capture2·read-pilot4·runtime-policy2·vehicle-finder-route1. 관측 오류 `uv_os_get_passwd ENOMEM`, `jq Permission denied`, CLI 출력/exit 불일치, `ECONNREFUSED`. 기대값·환경 판정 완화 없음. 결과 JSON 재실행도 같은 수치. diff whitespace 검사 PASS.
- 독립 검토: Claude status RESET_REACHED였으나 호출 `FAILED / CLAUDE_PROCESS_FAILED`(본문·exit0 없음), 미검증. 합의/PASS 없음.
- 남음: 상태 파일은 경영지원실 결정으로 회차별 create-only 새 파일(status/<id>/<시각>-<key>.json)로 바꿔 덮어쓰기 권한 문제를 없앰(권한 추가 없음, 30일 수명 규칙은 배포 절차). hourly-all 동등 dispatch 조합 부재로 HOLD. 운영 활성 없음.
- next_start_here: 경영지원실 Codex 재검토 → #288 머지 → 승인된 운영 담당자만 배포 절차(/verify 무쓰기 검증 통과 후 Scheduler resume). Scheduler 검증 후 ERP4 cron 제거는 별도 승인.

### 2026-10-03 오더3 — 중계 concrete ports와 아이카/아이언 transport (운영 미실행)

- 목적/대상: PR #288 작업선 `work/freepass-data/supplier-native-fixes-20261003`, 시작 revision `b20cd2d6662a9587d87c66bd5af9b262de7d6c40`, 이 checkout만 수정. 로컬에서 `21f1511` ancestor 확인. 실 네트워크 금지에 따라 원격 main/Issue24/PR 재조회는 생략했다.
- 사전점검: Academy READY. reuse 검색 뒤 기존 relay 계약·GCS audit REST 패턴·rich-grid reader·SourceIntakeBatch/ingestion runtime 재사용 판정. CREATE_NEW_JUSTIFIED: 기존 append-only audit store에는 pending CAS가 없고 concrete 포트/명령이 없어서 composition 모듈만 추가했다.
- 변경: `supplier-relay-transport.ts` OIDC exact binding·기존 단일 Secret의 Actions PAT·GCS create-only/CAS pending·고정 GitHub fetch/UNKNOWN/무재시도, `serve-supplier-relay.ts` fail-closed 명령. 기존 `installationToken`은 `actionsToken`으로 변경. `collect-aica.ts` 기본 읽기 전용 counts/digest/issues 출력과 이중 승인/RAW_READY 경계, `iron-detail-reader.ts` 기본 비활성·robots 보수 검증·동시2·차량당1회. 새 Firebase app/persistence 경로 없음.
- 검증: build PASS. 전용 `supplier-transports`17 + `supplier-native`28 + `source-intake`17 = **62 PASS**. 두 진입점 import 시 network/listen 없는 smoke PASS. 전체 `npm.cmd run check`는 **exit1, Vitest 1202 PASS / 9 FAIL / 14 SKIP**(마지막 mock 2개 추가 전) (Codex 샌드박스 환경 오류; Claude 정상 환경 재실행 exit0, Vitest 1213 PASS / 14 SKIP). arch/standards/data-access boundary/시트57/build/read-runtime6/shadow10/dashboard21 통과. 기존 실패4파일은 iancar-source-capture2/read-pilot4/runtime-policy2/vehicle-finder-route1이며 `uv_os_get_passwd ENOMEM`, jq Permission denied, localhost ECONNREFUSED다. 실패/skip을 완화하지 않았다.
- 남음/HOLD: 정상 환경 전체 검사, 독립 검토(실 네트워크 금지로 외부 Claude 호출 미실행; 로컬 status만 확인), 실제 OIDC/GCS CAS·Secret/GitHub 응답 계약·권한 범위·image/startup·동시 writer admission, 아이카 FULL/fresh 증거 및 아이언 공개 규칙/실물 귀속. 실 공급사/GitHub 호출·운영 쓰기·IAM/Scheduler/Cloud Run/secret/var 변경·dispatch·ERP4 수정·commit/push 없음.
- next_start_here: `docs/NATIVE-SOURCE-COLLECTOR.md`의 「운영 반영 전 남은 단계」와 `tests/supplier-transports.test.ts` → 정상 환경 check/독립 검토 → 별도 승인된 운영 검증. 이번 결과는 CODED/로컬 TESTED이며 PERSISTENCE/DEPLOYMENT/CUTOVER VERIFIED가 아니다.

### 2026-10-03 오더2 — 직접 연동 공급사 Data native 수리 (운영 미적용)

- 목적/결정: ERP4 고정 엔진 최소 diff **미채택(Data native로 이관)**. 기존 `SourceIntakeBatch`/RAW 재사용, 두 번째 source store/writer 없음.
- 대상 revision: 이 checkout의 `work/freepass-data/supplier-native-fixes-20261003`, 기반 `5b1d430d7f6e465a7a6379de1a59754286025264`. GitHub connector로 Issue24 및 PR287 merged/main `21f1511878efc9fe8a9fc664142c3d2f552a1031` 확인. main의 추가 공동시트 dropdown 변경4파일은 이번 diff와 비중복. 다른 checkout 수정·commit/push 없음.
- 변경: `src/adapters/supplier-source-capture.ts` RP004 rich-cell RAW/사진 UNKNOWN/귀속 issue·PARTIAL, RP006 HTML RAW/비표준 기간 tuple/원·만원/보증금 UNKNOWN/gallery/지정 상세 1회 포트. `src/domain/source-intake.ts` 등록·grid 타입·공통 HOLD. `src/infra/aica-sheet-reader.ts` 최소 Sheets GET + 기존 Data ADC의 읽기 scope(기존 google-auth-library10.9.1 직접 의존성 선언). `src/api/supplier-relay.ts` Cloud Run용 factory·고정 입력·create-only receipt/원자 pending admission·UNKNOWN 무재전송. concrete 운영 포트/entrypoint 미연결.
- 문서: [native collector 오더2](NATIVE-SOURCE-COLLECTOR.md#supplier-direct-status)에 손오공 동일 기존 계정의 Secret Manager 단일 accessor/8시간 메모리 토큰 설계, 아이언·오토플러스 제공방식 문의 목록, 승인 후 Scheduler1 + private Cloud Run1 + 최소 IAM 절차를 기록했다. 문의 발송/생성/배포 없음.
- 검증: native28+공통17 = **45 PASS**, build/diff-check PASS. 전체 `npm.cmd run check` exit1, **Vitest 1,187 PASS / 9 FAIL / 14 SKIP** (Codex 샌드박스 환경 오류; Claude 정상 환경 재실행 exit0, Vitest 1196 PASS / 14 SKIP). 기존 4파일의 환경 오류(`uv_os_get_passwd ENOMEM`, jq Permission denied, local server ECONNREFUSED); 기대값 변경 없음. 아키텍처/standards/data boundary/시트52/build/smoke6/shadow10/dashboard21 통과. `claude:review` 실행 실패 → 독립 검토 UNAVAILABLE. 수정 전 Academy READY, reuse CREATE_NEW_JUSTIFIED PASS; 신규 인자 재조회는 본 작업 dirty 경고 HOLD(세부 native 문서).
- 남음/HOLD: 정상 환경 전체 검사·Claude 독립 검토; 실제 아이카 귀속/아이언 HTML과 원천 대사; native RAW persistence/Canonical/소비처 연결; 중계 durable receipt/OIDC/App transport wiring·경합/복구 검증; 운영 생성/배포 승인. 운영 Firestore/시트 쓰기·실제 공급사 요청·IAM/secret/var·dispatch·ERP4 수정 **0**.
- next_start_here: `docs/NATIVE-SOURCE-COLLECTOR.md` 오더2 검증 기록 → `tests/supplier-native.test.ts` → 정상 환경 check/독립 검토. 별도 승인 전 운영 포트를 연결하거나 Scheduler를 생성하지 않는다.

## 2026-10-03 직접 연동 공급사 5곳 점검

- 목적: 공동 시트 밖 RP031/RP012/RP006/RP023/RP004의 원천 누락·수집 누락을 구분하고 기간별 계산 입력과 15분 트리거 설계를 정리한다.
- 대상 revision: `work/freepass-data/supplier-direct-integration-20261003` / `e4dcee5446e70f7342f1bcdc25b170d8aca077d0`(GitHub main 재확인). ERP4는 `fe3eccc` Git 객체만 읽었다. 변경은 이 파일과 [NATIVE-SOURCE-COLLECTOR.md](NATIVE-SOURCE-COLLECTOR.md)의 `직접 연동 공급사 현황 — 2026-10-03` 절뿐이다.
- 확인: 운영 run37110200131의 단계 성공/시각과 이안카 syncedAt을 재조회. 아이언은 parser 사진 배열→mirror/Row 전달 단절 및 72/84/비표준 기간 손실 경로가 있다. 지정5대 원문 페이지는 robots 접근 실패/브라우저 차단으로 미확인, 원천 미제공으로 확정하지 않는다.
- 아이카 새 readback: 원본3개 재고 탭의 차량번호 셀 rich link와 F86 `아이카 82대` 차량번호를 대조. F86 링크40/82, 누락42 중 원본 링크 있음6/원본 같은 행에 링크 없음3/원본3탭 미매칭33. 6대의 전달 누락은 확인했으나 사진 귀속·33대의 원천 범위·동일 시점 원자 대사는 HOLD다. source/API 원문·차량별 링크는 Git에 복제하지 않았다.
- 설계: Scheduler→OIDC private Cloud Run 중계→기존 ERP4 workflow_dispatch 입력 재사용이 최소안. 기존 cadence 양보/동일 writer concurrency 유지, App Actions write와 secret 단위 accessor만 설계. at-least-once 중복/불명확 응답과 admission 경합 검증 필요. native Cloud Run writer는 legacy fencing 이전 활성화 금지. owner 변수만 전환하면 구 Data engine pin과 충돌한다.
- 검증: Academy READY. Codex 샌드박스 check는 환경 오류(uv_os_get_passwd·jq 권한·로컬 서버 연결)로 9 FAIL이었고, Claude가 정상 환경에서 같은 트리로 `npm run check` 재실행 → exit0, Vitest 1168 PASS / 14 SKIP, build PASS. `git diff --check` 통과. Claude(B3Q 공급사 연동 세션)가 문서 diff를 읽고 검토함 — 문서 전용 변경, 코드·운영값 변경0.
- 남음: 아이언 실제 요금/사진 증거, 아이카 누락·미매칭 대사, 5곳 term별 청구/지급 수수료·정책 효력 연결, native transport, Scheduler 실검증, 운영 Firestore/Sheets·IAM·Scheduler·var/secret·dispatch 변경0, ERP4 수정0, commit/push0.
- next_start_here: 위 native collector 절의 근거·최소 diff 제안·공급사별 필요한 것부터 검토한다. 원본 rich link를 보존하는 Data reader와 원천 기간 tuple 보존을 기존 RAW 계약으로 연결할 범위를 결정하고, 이 PR은 진단·설계 문서만 머지한다. 이번 결과를 운영 수리/15분 갱신 완료로 표시하지 않는다.

### 2026-10-03 수수료 확정 규칙·VAT 공급가액 — 미커밋 인계

- 목적: 대표 결정 및 같은 날 `commission-research.md` ①③④에 따라 기간별 계산에 확정 규칙 적용. 정본은 `sales-commission-2026-10-03`, 09-28 근거는 이력 보존.
- 대상 revision: `8cc49bb0921d036fa87185808a96661ae2967972`, `work/freepass-data/term-economics-precompute-20261003`. 사용자가 Git 쓰기를 금지했으므로 커밋·fetch·병합하지 않음. 운영 데이터 쓰기 및 비밀키 탐색 없음.
- 변경: 스타/스카이 재렌트 실계산, 퍼시픽 차량가액·계약 보증금 등급, 손오공 Q12 출처·형태·기간 가산, 원 반올림·VAT 분리, 아이언 선출고, 마음카 제외. 기간별 저장과 Canonical/Admin/Kakao 스키마 연동. 상세 입력과 ERP 차이는 `READ-RUNTIME.md` 수수료 연동 기준.
- 검증: 관련 5파일 88테스트 PASS. 최종 `npm.cmd run check`: 구조·규격·데이터 경계·build PASS, Node 테스트 104 PASS, Vitest 1186 PASS / 9 FAIL / 14 SKIP. 9개 실패는 tsx 실행 시 `uv_os_get_passwd ENOMEM` 계열 7개, jq 실행 권한 1개, 로컬 서버 `ECONNREFUSED` 1개. 별도 `node --import tsx -e`만으로 ENOMEM 재현. 전체 검사 PASS로 간주하지 않음. 로그: `%TEMP%/freepass-commission-check-final.log`.
- 남음: Claude 독립 검토 `FAILED / CLAUDE_PROCESS_FAILED`로 UNAVAILABLE. GitHub Issue #24/현재 PR 조회는 네트워크 차단. 배포·운영 재계산 없음. 계약 등급·Q12 근거 수집은 기존 자동 저장 호출에 없으므로 해당 상품 UNKNOWN 유지.
- next_start_here: Claude가 미커밋 diff와 조사표를 독립 검토하고 실행환경 제약 없는 곳에서 전체 check 재실행 후 커밋. ERP `settlement-fee-table.ts`는 이번 변경 대상이 아님.

### 2026-10-03 기간별 수수료 Canonical 선계산 / Admin 내부 읽기

- 목적/대상 revision: `work/freepass-data/term-economics-precompute-20261003`, 기준 `e4dcee5446e70f7342f1bcdc25b170d8aca077d0`. 지정 worktree만 수정, 운영 Firestore/시트 쓰기·push 없음.
- 재사용 판정: `reuse:check` 후보와 09-30 시안 확인. 기존 `resolve-offer-commercial-terms.ts`를 확장하고 Kakao의 고정 수수료 resolver·규칙을 호출한다(EXTEND_EXISTING). 시안의 UNKNOWN 변환 원리를 재사용하며 compatibility `internalPeriodFees` writer는 가져오지 않는다. 신규 저장소·파일 없음.
- 변경 A: 순수 `precomputeOfferEconomics`, 신규/원천 변경/가격 변경 세 CatalogStore 거래에서 계산값·revision snapshot·audit 동시 보존. 24개월 월50만원 → 청구57만원/지급48만원. 규칙 없음 UNKNOWN, 협의 COORDINATION_REQUIRED, 0원 ZERO, 입력 불변.
- 변경 B: Admin 기간 행에 양쪽 TermEconomicAmount와 provenance, 상태별 기간 수/economicsCoverage. 공개 projection 변경 없음. 저장 누락·중복·무효·계산 기준 불일치는 UNKNOWN, health도 불일치 차단. 자세한 계약은 [READ-RUNTIME](READ-RUNTIME.md#admin-내부-기간별-경제조건--2026-10-03).
- 검증: A 관련56 PASS, B 관련48 PASS. 전체 check의 architecture/standards/data-access/sheets/build/runtime-smoke/shadow/dashboard 통과(Node tests 합104 PASS). Vitest1174 PASS/9 FAIL/14 SKIP. 실패9는 OS userInfo ENOMEM, jq 권한 거부, 로컬 dev 서버 연결 실패이며 단일 worker 재검사도 동일(60 PASS/9 FAIL). 최소 node:os.userInfo 호출도 ENOMEM 재현. 외부환경 SKIP14는 검증 완료가 아니다.
- 남음/HOLD: Claude 독립 검토 `FAILED/CLAUDE_PROCESS_FAILED`(본문 없음, 미검토). GitHub main/Issue24/PR 읽기는 네트워크 제한으로 실패. 로컬 A 커밋 시도는 공용 Git 관리폴더의 index.lock 권한 거부로 실패해 A/B SHA 없음; 작업파일과 임시 A/B 패치로 보존. 운영 기존 Offer backfill·Admin release 재발행·배포 없음.
- next_start_here: 권한이 허용된 같은 worktree에서 diff와 A/B 패치를 확인하고 요청된 두 커밋 메시지로 로컬 커밋한다(push 금지). 제한 없는 검사 환경에서 위9건 및 Claude 독립 검토를 완료한다. 미등록 공급사·신차 기준액·협의는 새 사업 규칙 없이 UNKNOWN 유지.

### 2026-10-03 정본 전체 열 계획 / 전체 높이 읽기 / 마음카 제외 — 미커밋 로컬 변경

- 목적/대상: `work/freepass-data/supplier-sheet-canon-v1-20261003`의 `00a159ec9c4681ac7f4a1abf73d012e73aa6ae95` 위에서 요청된 3항목을 구현한다. Academy READY. 기존 규격·실행기·테스트·문서만 확장했다. Git 쓰기, Google/운영 데이터 접속·쓰기, 원본 스냅샷의 저장소 복사 없음.
- 변경: `planTabConsistencyFix`는 전체 열(2행~metadata rowCount) 요청을 만들며 같은 인접 열 요청을 묶는다. 값 쓰기 없음, 전체 높이 audit coverage HOLD 유지. 헤더/폭/고정/조건부 규칙 통일, 종합 validation 예외. `canonCaptureRequest`/`canonValueCaptureRequest`와 CLI는 운영자가 사용할 읽기 params만 생성한다. 실제 요청 실행 없음.
- 공급사 정본: 현재 18곳. 마음카 RP034는 `excludedFromSharedSheet`에 대표 결정(공동 시트 제외·숨김 보관·수수료 규칙 없음)을 고정했다. 기존 검증 관문을 재사용하는 `planExcludeSupplierTab`/`--exclude-supplier`는 종합 A2 수식 1개와 마음카 hidden 1개만 계획한다. 실제 숨김/종합 반영은 미실행이다.
- 검사: check:sheets 77 PASS(공급사 전용 52), 요청 높이 독립·부분 캡처·최소 fields·마음카 전환/대조 제외·원문/링크 보존·RGB 응답 정밀도 회귀 포함. 전체 check는 architecture/standards/data-access/sheets/build 및 Node 검사 통과 후 Vitest 1,159 PASS / 9 FAIL / 14 SKIP. 실패 4파일은 tsx의 `uv_os_get_passwd ENOMEM`(최소 import로 재현), jq 실행 권한 거부 및 tsx 서버 미기동에 따른 localhost 연결 실패다. 제품 코드 실패로 섞거나 전체 PASS로 부르지 않는다. Claude review는 `FAILED/CLAUDE_PROCESS_FAILED`로 독립 검토 UNAVAILABLE. GitHub read-only 조회도 네트워크 권한 차단으로 최신 Issue/PR 확인 불가.
- 요청 수: **가짜 회귀 입력**(공급사 rowCount 1,000, 종합 20,000, 조건부 규칙 없음)은 공급사 각 131 / 종합 75 / 총 2,433, 마음카 제외 계획은 별도 2. 실제 스냅샷 경로가 제공되지 않아 실제 파일의 `--fix-tabs` 탭별 요청 수는 미확인이다. 이전 인계의 부분 스냅샷 수치를 현재 계획 실측으로 대신하지 않는다.
- 남음: 실제 스냅샷 경로 확인 후 원위치에서 읽기만 하여 요청 수 집계, 독립 검토, 별도 운영자의 전체 높이 재조회/적용/readback. 20,000행 축소는 사용행+증가 여유와 spill 용량 확인 후 검토할 운영 제안이며 rowCount 변경 요청은 만들지 않는다.
- next_start_here: [공동 시트 런북 현재 기준](SUPPLIER-INPUT-SHEET-RUNBOOK.md#현재-기준--2026-10-03-양식-고정-이-절이-아래-2026-10-02-기록보다-우선) → diff 검토 → 승인된 로컬 snapshot의 `--fix-tabs` 요청 수(원문 출력 없이) → 향후 운영자가 전체 capture와 값 capture를 좌표로 합쳐 `--check-canon` 검증. Git 반영은 사용자 지정 담당자가 한다.

### 2026-10-03 공통 시트 정본 v1 — 로컬 구현/검사만

- 목적: 공급사 19탭+종합 75칸 값 규격과 반복 가능한 정본 검사. 대상 `work/freepass-data/supplier-sheet-canon-v1-20261003`, baseline `e6ec8368517180d4691442d2f9318df58db2c7db`, academy READY. 기존 실행기 확장, 신규 자산 없음.
- 변경: spec `valueFormats`/`canonVersion`/미정 2칸; 감사/정리/탭 차이/서식 전용 요청 함수 4개, CLI와 `check:supplier-sheet-canon`, 가짜 스냅샷 회귀 검사. 규격·사용법·칸별 관측 숫자는 `SUPPLIER-INPUT-SHEET-RUNBOOK.md` 현재 기준의 공통 시트 정본 v1 절.
- 실측(지정 로컬 snapshot 읽기만): 공급사 관측 셀 불일치 1,778 / 정리 가능 1,588 / 값 HOLD 190. 서식 차이 31,646. 모든 탭 부분 행 캡처, 종합 계산 결과 없음 → 전체 검증 HOLD. 원본 복사·Google/운영 접속·Git 쓰기 없음.
- 검증: 공급사 전용41 / check:sheets66 PASS, diff 검사 PASS. 전체 check는 build까지 통과, Vitest 9 실패/1,159 통과/14 skip(권한/로컬 런타임 환경 오류 상세는 runbook). Claude 검토 실행 FAILED/CLAUDE_PROCESS_FAILED — 독립 검토 미확보, PASS 아님.
- 남음: 미정 탁송비/정비, 원문 확인 필요한 190셀, 전체 범위·계산 결과 재조회 및 독립 검토, 별도 승인된 적용/readback. 커밋은 Claude 담당.
- next_start_here: runbook 공통 시트 정본 v1 → 코드 diff 독립 검토 → 전체 private capture로 `npm.cmd run check:supplier-sheet-canon -- <snapshot>`.


### 2026-10-03 이안카 전체15분 동기화 재개

- 목적/사용자 결정: 모든 ONE API 차량·상태·기간/거리별 요금·사진을15분마다 Data로 상품화하고 ERP/이안카 화이트라벨 및 기존 F01/F86 단일 발행기가 따라간다. 정책은2차이며 삭제·계약 변경은 하지 않는다.
- 대상: Data main `b9ebf26ec43bea5def82523d2a1ab9863fd5103b`, ERP main `f24ab8133073fad0eb3867613495167f120b147d`. 작업은 기존 photo-proxy 작업 트리에서 계속하며 `period-economics-main`/ERP `e-01-engine`의 미커밋15분 초안은 읽고 재사용했으나 원본은 변경하지 않았다. Academy 두 대상 READY, 기존 collector/transaction/sole workflow COMPOSE_OR_EXTEND.
- 변경: 기존 ONE collector `--sync [--apply-sync]`. 전체 목록+rates+모든 상세 사진 조회(목록사진0도 포함), 마지막 목록 ID/차번 재조정, source/photo 관측15분 검사. 기존 phase-one 거래에 사진 배열/관측 ID와 미관측 비공개 HOLD를 함께 반영한다. hidden 재고 사진 메타데이터도 보존하지만 공개 사진 read gate는 유지한다. fresh source 실패는 쓰기0·마지막 정상 상태 유지. 새 writer나 local scheduler는 없다.
- 안전/복구: 기존 typed backup/restore/CAS 재사용. production 실행은 고정 비공개 bucket의 `iancar-one/{runId}/backup.json`을 generation0 생성·byte readback한 뒤에만 transaction한다. 원문 source도 private backup에 포함. 계약락/삭제락·ID/차번 충돌은 HOLD. 미관측 역사 원문/기존 withdrawal은 보존하며 이미 HOLD한 문서는 반복 덮지 않는다.
- 검증: 최종 전체 check1,168 PASS/14 외부환경 SKIP, 전용89 PASS/build PASS. ERP 지도/YAML 구조 검증 PASS(게시 전 placeholder 차단 회귀 추가). 광역 Claude REVIEW_TIMEOUT은 제외하며 좁은 writer 재검토는 B1/B2/B3 해결 ANSWERED/exit0. Collector는 abort/allSettled/429 우선 처리와2worker 제한을 보완했고 독립 최종 ANSWERED/exit0, bounded eventual 모델에 동의했다. Photo freshness는 product builder와 transaction 직전에서 강제한다. 전체 운영 반영/native15분 증거와 분리한다.
- 현재 원천 HOLD: `2026-10-03T02:07:38Z` 실제 공식API HTTP200/private,no-store;115대·syncedAt `2026-10-03T01:43:25.268Z`·stale=true. no-cache GET도 동일하다. 오래된 원천을 현재로 위장하거나 freshness gate를 해제하지 않는다. 이 회차 business write0.
- 후속 원천 회복: source syncedAt `2026-10-03T02:29:46.020Z`, capture completed `02:38:14.957Z` 전수115/2페이지/issues0, AVAILABLE108/UNAVAILABLE5/PREPARING2, observed rates2760, 사진62대/2824장. Private capture `8e7c57c6-e1be-43be-bb5e-1ef918f09094.json`, digest `d37c88a500ecc43ce7850ec8e83804f26ac7dfc91d53798319e50333b2b3bfb8`. DRY_RUN matched109/created6/absenceHeld11/open108/delete0/contractChanges0. 실제 적용이 아니다. 기존 canonical run37090314687이 ingest 진행 중이므로 겹쳐 쓰지 않았다. 다음 apply에는 신선도/동시성을 새로 확인한다.
- ERP workflow 검토 반영: hourly Data 실패가 다른 공급사 게시를 막지 않도록 warning+redacted HOLD receipt; extra 회차 실패는 자기 게시만 차단; shared writer job에 들어가기 전 busy admission으로 시간당 pending 보호; manual 전용 적용 인자/target 분리. API 복구 dispatch도 같은 Data 원천을 재조회한다. 공개 Data 저장소이므로 cross-repo credential 추가 없음. 보완 시트는 기존처럼 관측 참조이며 중앙 원자의 authority가 아니다. 검토의 extra 시트 게시 금지 제안은 사용자15분 소비처 반영 목적/발행시각 규격과 달라 채택하지 않는다.
- 운영 HOLD: 기존 writer `github-inventory-writer`에는 이안카 Secret 단일 읽기/비공개 backup prefix create+read가 없다. 해당 최소 IAM 변경만 사용자에게 async 요청했다. IAM·flag·dispatch·운영 시트 쓰기 미실행. ERP draft Data SHA placeholder는 정확한 검증 commit으로 교체 전 게시하지 않는다.
- next_start_here: 좁은 Claude 검토 및 최종 전체 check → 정확한 Data main SHA/ERP pin+지도 검증 → 최소 IAM 승인 후 허용 범위만 설정·재조회 → fresh source manual cycle 및 ERP/화이트라벨/F01/F86 readback →15분 flag 활성/native 회차 성공·freshness 증거. supplier stale가 지속되면 공급사 API 갱신 상태부터 복구한다.

## 2026-10-02 공급사 수집 공통 규격 / 개별 RAW 어댑터

- 목적: 손오공·이안카·웰릭스의 공통 수집 결과 규격과 공급사별 원천 해석 경계를 코드로 고정하고 기존 PR270에 통합한다.
- 대상: main `71e9f7a`와 PR270 기존 Work를 이어받았다. primary checkout의 dirty 문서 두 개는 보존했다. 최신 사진/ONE 변경과 기존 공급사 관리 기록을 모두 보존하여 main을 병합했다.
- 변경: 기존 `SourceIntakeBatch`/원천 저장소를 재사용. 공급사 등록·transport kind/scope·source binding·freshness·fingerprint/coverage 공통 검사와 안전한 요약. 이안카 두 collector에 공통 관측 보고 연결. 새 손오공 bucket/list/detail와 웰릭스 tab/header/cells RAW 어댑터는 재사용 검색 및 CREATE_NEW_JUSTIFIED/Academy READY 뒤 추가했다.
- 검증: build/architecture 및 전체 check 1,159 PASS/14 외부환경 SKIP, Sheets25 PASS, delivery-owner13 PASS 뒤 혼합 empty-bucket 회귀를 추가했다. 공급사 원문 의미·중복 UID/차번·원천 실패·누락 상세·부분 범위·모든 버킷 시각 회귀를 포함한다. Claude 중복 identity 우려는 adapter.read 반환 전 검사까지 보강했고, 미래 버킷 반례는 각 upstream 시각 검사로 수정했다. 전체 empty는 HOLD. 교차 버킷 제품관측은 보존하되 차량 수로 세지 않는다. 최초 실행기 FAILED 및 광역 REVIEW_TIMEOUT은 PASS가 아니다. Claude 최종 ANSWERED/GO; exact publication revision과 최종 CI는 이 Work PR270에서 확인한다.
- 남음: 새 손오공/웰릭스 native transport·CLI·스케줄은 미연결. injected reader로 실제 공급사 metadata/schema와 full coverage를 검증한 뒤 연결해야 한다. 이안카 enriched terms UNKNOWN coverage는 그대로 HOLD. 운영 pin/인증/원천·DB·시트 쓰기/배포 변경 없음; RAW_READY는 정본·게시·삭제 승인이 아니다.
- next_start_here: `docs/NATIVE-SOURCE-COLLECTOR.md` 공통 계약 → `src/adapters/supplier-source-capture.ts` 읽기 포트 → 승인된 공급사 transport 연결·원천 실조회 검증. 기존 단일 writer를 보존하고 operational cutover는 별도 검증한다.

## 2026-09-30 손오공 차량사진 전달

- 목적: 기존 reference 응답에서도 차량 사진을 직접 열어볼 수 있도록 사진 목록과 상태를 전달한다.
- 대상: `main@f77e581b01c61544bb877fec21e4b0a2ae1607e5` 기반 `work/freepass-data/sonogong-photos-20260930`; 원래 checkout의 dirty 감사 문서 두 개는 보존했다.
- 변경: 기존 reference builder/schema에 optional `vehiclePhotos` 추가. HTTPS 사진 순서·쿼리 의미를 보존하고 URL 인코딩 후 같은 URL만 중복 제거한다. 대표 URL, 보완 링크 개수, URL 존재/링크만/미제공/해석실패 상태와 거부 개수를 구분하며 네트워크 검증 상태는 `NOT_CHECKED`다. 서류 사진과 불투명 폴더 주소는 제외한다. internal-ai는 기존 공유 builder/schema를 통해 같은 필드를 받는다.
- 검증: build와 관련 41 tests PASS. architecture/standards/data-access/sheets/runtime-smoke/shadow/dashboard PASS. 기본 병렬 전체 검사에서 기존 runtime-policy 5초 timeout 1건; 제한을 변경하지 않고 `vitest --maxWorkers=2` 재실행 1,045 PASS / 14 SKIP. 운영 snapshot의 손오공 판매 가능 41대 중 대표사진 36대 HTTP 200/image, 링크만 2대, 미제공 3대. 원본 805장 전부의 접근·차량 동일성 검증은 수행하지 않았다. ERP.com 표본에서 20장 갤러리·확대·다른 사진 전환을 실제 확인했다.
- Claude: 읽기 전용 답변과 exit 0을 확인했다. ANSWERED receipt는 실행기가 출력하지 않아 형식상 검토 PASS로 세지 않는다. 한글 파일명 URL로 전체 route 503을 재현한 뒤 인코딩 수정과 route 회귀검사로 해결했다. 해석실패 count·불투명 폴더 비노출 제안을 반영했다. 필드형태/투영누락 우려는 같은 운영 snapshot dry-run의 손오공 41대·사진 805장·거부 0·전체 schema PASS로 확인했다. canonical media HOLD는 유지한다.
- 남음: 운영 배포·카톡 consumer adoption, 링크만/미제공 차량의 원본 보완, 독립 검토 형식 receipt. 기존 ERP 화면은 직접 이미지가 표시되므로 프록시 allowlist 변경은 이번 범위에서 하지 않았다.
- next_start_here: 해당 PR의 최신 검토와 CI를 확인하고, 운영 반영 승인 후 reference 배포와 Kakao 소비자 schema/readback을 진행한다. 사진 URL 제공을 전체 사진 검증 완료로 표시하지 않는다.

### 2026-10-01 이안카 전량 ONE API 수집 성공 — 표시 범위 선택 전

- 목적/대상: 사용자의 ERP·F01·F86 실제 최신화 요청, Data main `56c3e848338814d708ad24f49ef484b9ee5af361`에서 기존 ONE adapter 확장(COMPOSE_OR_EXTEND). Academy READY 확인. 운영 쓰기·삭제·workflow 변경은 하지 않았다.
- 원천 검증: source `2026-10-01T04:24:36.800Z`(서울13:24), 111대/2페이지, 상세·availability·차량별 rates 전량 및 종료 목록 대사 성공, issues0/stale=false. 2,664개 관측 요금(24조합×111대). source digest `c5f82558cd85be824df6329c0a4a0ac9eefd66d57668ee2cfd8377ea85e5a675`. private evidence `.codex/private/freepass-data-iancar-one-captures/e62ca53c-1237-4ed0-811e-3f4838df502d.json` 보존/readback. 이 관측이 모든 미제공 요금의 부재를 확정하지는 않는다.
- 식별 대사: 현재 RP031301문서와 exact plate match89/신규22/원천 미관측212; 다른 공급사 차번호 충돌0. 현재301문서 모두 비노출. 원천 상태 AVAILABLE103/RESERVED1/PREPARING2/UNAVAILABLE5. 사진 참조 보유57대이며 사진 전체 가져오기/게시 완료가 아니다.
- 실제 표시 차이: 1·3·5개월은 월2,000/3,000/4,000km; 12·24·36·48·60개월은 연20,000/30,000/40,000km. 111대 전부 장기 기간별 보증금이 달라 단일 장기보증으로 축약하면 안 된다. 사용처 전체 형식 확장(추천)과 기존 형식에 안전히 담기는 장기 조건만 우선 적용 사이를 사용자에게 질문했다. 선택 전 6개월 요금을 만들거나 월 약정거리를 연으로 둔갑시키지 않는다.
- 수집 개선: 순차3worker는 최신화 경계에 걸렸다. 독립3GET 병렬×3worker(최대9) 읽기 시도에서 전량 성공. 독립 Claude ANSWERED/exit0는 병렬 검증 유지에 동의했으나 burst 위험을 지적했다. 최종 코드는2worker(최대6), endpoint/worker allSettled 및 실패 후 새 차량 배정 중단으로 보수화했다. 성공한 live 회차는 최대9 버전이며 최종6 버전의 live 전량 성공으로 확대하지 않는다.
- 검증/남음: 전용31 PASS/build PASS/diff 검사 통과. 전체 테스트1104PASS/14SKIP은 마지막429회귀 추가 전 결과다. 최종 코드 독립 재검토 ANSWERED/exit0는 drain에 동의하고 worker 간429가503에 가려지는 오류를 지적했다. 외부 worker에도429 우선 판정과 Retry-After7초 보존 회귀를 추가했다(수정 후 독립 재검토 미실행). 형식 선택 후 기존 mapper/publisher를 확장하고 dry-run 변경 건수·원본 백업·사용자 직전 실행 승인·ERP/F01/F86 readback까지 수행해야 한다. source 수집 성공은 소비처 반영 완료가 아니다.
- 소비처 현재 원문: 커넥터 metadata/cells 새 조회로 F01 sheetId668539469/F86 sheetId2029374993, 양쪽 `10.01 11:17 상품리스트 211대`의 A1:BQ1 69열 동일 확인. 기존 열은1/6/12/24/36/48/60개월 및 단일 단기/장기보증이며 새3/5개월·월/연 거리별 보증금을 모두 표현할 수 없다. 이번 셀 수정0이며 기존 서식/구조 보존.
- next_start_here: 위 private evidence로 관측 요금/기간별 조건을 분석하되 실제 적용 전 새 fresh window에서 다시 수집한다. 예약→계약중/선점, 원문 RESERVED와 실제 계약 생성 없음 유지. 기존 RP031 old-Sheet ingest exclusion은 계속 유지하며 snapshot withdrawal guard는 검증된 새 API publication 증거로만 교체한다.

## 2026-10-01 이안카 온라인·로컬 구현 동기화

- 최신 사용자 결정/연결: 제공한 기존 키 그대로 사용 승인. `freepasserp5/freepass-data-iancar-one-api` version 1 enabled 등록 및 공식 API 실제 클라이언트 조회 exit 0 확인. 전체 108 / AVAILABLE 101 / UNAVAILABLE 4 / PREPARING 2 / RESERVED 1, 상세/재고/요금/사진 샘플 성공. 상세 증거와 다음 미완료 경계는 [ONE API 실제 연결 확인](IANCAR-ONE-API.md)에서 확인한다. 아래 키 미주입·재발급 경계는 이 결정 이전 이력이며 현재 blocker는 Canonical mapping/writer/consumer 검증이다.

- 목적: 온라인 main의 공식 ONE API 구현(PR #269)을 기존 로컬 Work에 통합한다. 다음 원천 수집 시작점은 `docs/IANCAR-ONE-API.md`와 `npm run source:iancar:one`이며 아래 로그인 transport 기록은 과거 준비 이력이다. `/api/inventory` 및 로그인 수집을 운영 fallback으로 활성화하지 않는다.
- 키 위치 확인: 사용자가 온라인 채팅 `기타 접속 여부 확인`에 제공한 키를 확인했다. 키 값은 파일/Git/로그에 복제하지 않았다. 현재 Data GitHub secret, ERP bridge secret 이름, `freepasserp5` Secret Manager metadata, 로컬 process/user/machine 환경변수에는 공식 ONE 키 binding이 확인되지 않았다. 채팅 노출 키는 재발급 후 서버 비밀 저장소 주입이 필요하다.
- 남음: 새 키의 안전한 runtime binding, 실제 목록/상세/재고/요금/사진 read-only 검증, reviewed Canonical mapping, ERP/운영시트 readback. 코드 동기화는 운영 전환이 아니다.
- 검증: `origin/main@e6db81c67368cb4353c07f64aa0560d6ac0b857a`의 ONE adapter/job은 로컬과 diff 0. ONE API 10 + direct source 10 + capture/availability 35 = 관련 테스트 55 PASS, build/architecture/data-access-boundary/diff-check PASS. 실제 collector는 키 미주입 `EANCAR_ONE_API_KEY_REQUIRED`로 중단됨을 확인했으며 외부 API/운영 데이터를 조회하거나 수정하지 않았다. 기존 노출 키 재사용 여부 또는 재발급 키 binding이 다음 승인/입력 경계다.

## 2026-09-30 운영 시트 반영 승인 — ERP 로그인 접근 HOLD

- 사용자 직접 승인: `운영시트도 바꿔 얼른`. 이안카 범위 반영 승인은 받았으며 같은 수정 승인을 다시 요청하지 않는다. Academy operations READY, 대상 `430b43c`.
- 현재 원본 재조회: `이안카_프리패스`의 `이안카` 60행 / `이안카 재렌트` 59행, 두 탭 metadata/CellData 전체 기존 범위 확인. 수식/chip/dataValidation 0. 실제 status는 배차가능 118 / 상품화 진행중 1. F01 상품리스트 433, F86 이안카 223은 현재 출력이며 원천 정합성 PASS가 아님.
- 실제 blocker: supplier `/api/inventory` HTTP 403. 기존 연결의 credential은 ERP bridge GitHub secret에만 있으며 이 PC의 process/user/machine env 및 연결 worktree의 정해진 계정 파일에서 찾지 못함. Chrome 신규 supplier 페이지는 로그인 세션 없음. 비밀번호 추출/공개 로그/공개 artifact 우회 금지.
- 아직 수행하지 않음: 운영 Sheet/Firestore 쓰기, 원본 백업 생성, publisher 재발행. 원본 ERP를 못 읽은 상태에서 새 값이나 출고불가를 추정하지 않았다. 기존 collector의 partial-inventory absence→출고불가 및 clear/rewrite 경로를 그대로 실행하지 않는다.
- next_start_here: 사용자에게 Chrome supplier 로그인 화면 인계. 로그인 후 인증된 현재 원본을 확보하고 필드·기간·약정거리·관측 범위를 고정 → source/Sheet/중앙 신규·변경 대사 → private backup → 해당 수정 범위만 patch → 중앙/시트/ERP 실제 readback. 쓰기 전에 각 대상 원본을 새로 읽는다. source hostname 이동은 관측 사실이며 credential을 새 host로 전송하기 전 actual endpoint/권한을 검증한다.

## 2026-09-30 이안카 공급사 ERP 직접 수집 — 운영 전환 미완료

- 목적: 사용자의 ERP 원천 변경 지시를 실행 경로에 반영. Sheet를 재고 원천으로 읽거나 신규 차량을 기존 등록 목록으로 제외하지 않는다.
- 대상 revision: `origin/main@f77e581b01c61544bb877fec21e4b0a2ae1607e5`; 기존 isolated worktree 재사용, Work `work/freepass-data/iancar-erp-source-20260930`. 기존 ERP authority Work/PR #233은 main 병합됨과 unique-ahead 0 확인; 현재 transport 목적의 open PR 없음. 원래 checkout의 사용자 변경 보존. Academy READY, COMPOSE_OR_EXTEND.
- 변경: 기존 Iancar capture adapter에 인증 ERP transport/엄격 parser/RAW batch 추가. 기존 source job에 `--iancar-erp --dry-run`과 승인된 RAW intake 경로 연결. 기존 DataAccessGateway/SourceIngestionStore 유지. 모든 관측 차량과 원본 응답 보존, 기존 차량 필터 없음.
- 안전 경계: inventory 응답은 available/reserved 부분집합이며 fleet 전체가 아님. PARTIAL coverage로 absence/retire 금지. 누락 요금 UNKNOWN/HOLD, Sheet fallback 없음. stale/미래/1시간 초과는 INCOMPLETE. credential/응답 body 노출 및 redirect 금지.
- 검증: build/architecture/data-access-boundary/sheets/read-runtime-smoke/shadow/dashboard PASS. 최종 전체 Vitest 1,055 PASS/14 SKIP, Iancar 20 PASS(기존 store intake/replay, 실제 job gate, 지연 재생 포함). standards 실행은 PASS이나 역량 상태는 기존 PARTIAL. Claude 첫 검토 REVIEW_TIMEOUT(PASS 아님); 좁힌 검토 ANSWERED에서 credential 격리/부분 범위/요금 UNKNOWN에 동의, wall-clock completeness 재판정 반례 1건 발견. capturedAt 고정·판정 일치 검사·지연 재생 회귀검사로 수정하고 재검토 요청. 실제 ERP 인증·수집·운영 저장 검증으로 확대하지 않는다.
- 남음/HOLD: 운영 bridge의 Sheet 원천/pin은 아직 변경되지 않음. supplier credential은 ERP bridge GitHub secret에만 확인됨; 로컬/중앙 Secret Manager에는 없음. LIVE_READ/PERSISTENCE/CANONICAL_MAPPING/DEPLOYMENT/CUTOVER 미검증. 코드 준비를 운영 변경 완료로 보고하지 않는다.
- next_start_here: [Iancar capture의 Direct ERP intake](IANCAR-SOURCE-CAPTURE.md) → 안전한 credential binding 및 실제 ERP dry-run → 원문/현재 중앙 등록과 신규·변경 후보 대사 → exact reviewed writer/publication 범위 승인 → 소비처별 readback. ERP API만으로 기존 fleet 차를 출고불가/삭제하지 않는다.
- Claude 최종 좁은 재검토: 본문·exit 0·ANSWERED, 기존 completeness blocker 해결 및 잔여 blocker 없음. capturedAt/판정을 함께 위조하는 악의적 caller까지 helper가 인증하지 않는다는 비차단 의견은 기록한다. helper를 공개 untrusted 입력 API로 사용하지 않으며 기존 인증 job/append-only RAW 경계를 유지한다. wall clock을 재도입하는 제안은 불변 재생을 깨므로 반영하지 않는다. 운영 승인·계정 인증·원천 최신성의 증거로 확대하지 않는다.
## 2026-09-30 이안카 원본 ERP 직접 수집 우선 도입

- 사용자 지시: ERP4 수집기를 FreePass Data의 장기 수집 정본으로 재사용하지 않는다. Data가 공급사 원본을 직접 읽는 단일 소유 구조로 바꾼다. 영업자 원천↔ERP5↔F01/F86↔화면 불일치를 정상 PASS로 보고하지 않는다.
- 변경: 기존 Data SourceIntakeBatch/RAW/SourceHead만 재사용하는 이안카 원본 ERP 직접 API 수집 adapter, 신선도·범위·차번·예약 검사, ERP5와 차량번호 양방향/상태 대사 선택 명령 및 합성 회귀검사를 한 작업선에 추가. 요금 API 미확인으로 가격·Canonical·발행은 HOLD.
- 상태: PREPARED 코드이며 실제 공급사 자격증명/운영 실행·배포·컷오버는 아직 검증되지 않았다. 기존 ERP4 고정 엔진은 여전히 과도기 의존성으로 남아 있어 운영 단일화 완료가 아니다. 신규 중복 운영 writer를 켜지 않는다.
- next_start_here: [원본 직접 수집 및 영업자 정합 종료 기준](NATIVE-SOURCE-COLLECTOR.md) → 이안카 원천 실제 읽기/ERP5 비교 → 다른 활성 공급사 직접 adapter → 단일 실행기 전환·권한 분리·전 소비처 readback.

## 2026-09-30 Data 수집·배달 실행 소유권 구현

- 목적: 연결 지도의 실제 실행을 Data가 맡게 하는 검증 가능한 이관 경로. 운영/IAM/시트 고위험이며 이번 packet은 준비 코드다.
- 대상: `work/freepass-data/delivery-owner-20260930`, base `f77e581`. 기존 checkout의 문서 두 건은 보존한 별도 worktree. Academy READY / COMPOSE_OR_EXTEND.
- 변경: frozen engine adapter, 기본 shadow workflow, 매 단계 owner/old IAM/키/drain 확인, private before backup readback, 단일 snapshot SHA 고정, 실패 시 downstream 중단과 redacted attempt receipt. 신규차 import/자동 retire/CANONICAL ACTIVE는 범위 밖 HOLD.
- 검증: 신규 Node 회귀검사와 전체 architecture/standards/data-access/sheets/build/runtime/shadow/dashboard 검사. 기본 전체 Vitest의 기존 runtime-policy 5초 timeout은 `--maxWorkers=2` 전체 재실행으로 1,043 PASS / 14 SKIP. 상세 CI/commit은 PR 참조.
- Claude: 광역 호출 REVIEW_TIMEOUT 후 좁힌 설계 자문/준비 검토와 두 실제 파일 독립 검토 ANSWERED/exit 0. destructive retire·백업·credential drain·rollback 지적 반영. cross-repository Actions token을 별도 최소 권한 secret으로 분리하고 failureCode/exitCode와 durable pre-effect checkpoint/readback을 보강했다. pinned parity script의 shadow `--write-receipt`는 실제 Firestore write임을 확인해 제거했다. Main-only shadow와 ADC는 의도된 보안/실행 경계로 유지한다. 운영 검증 완료를 뜻하지 않는다.
- 남음: 전용 WIF/SA/환경/시크릿, private bucket, token-mint 음성테스트, shadow·supplier field coverage, 전체 workbook backup, rollback drill, consumer별 실제 readback, 운영 recovery watchdog 이관. owner 변수는 미설정이며 기존 ERP4 writer는 그대로 유지했다.
- next_start_here: [이관 실행 절차](DATA-DELIVERY-OWNER-ROLLOUT.md)의 admission/activation과 recovery 게이트. 코드 준비를 운영 최신화 이관 완료로 표현하지 않는다.
- 2026-09-30 사용자 main 병합 지시 / 독립 GPT: exact `8f541064`의 runner·workflow·tests·rollout·governance diff와 회귀 11/11을 검토해 owner 미설정 PREPARED 병합을 막는 재현 가능한 치명 오류 없음으로 판단했다. SA 직접 IAM 조회는 project-level/custom token 권한·다른 credential의 완전 fence 증거가 아니므로 운영 전 음성테스트와 권한 전수 확인은 HOLD다. Shadow는 DB→projection 자기대사이며 공급사 전체/신규 재고/정책 본문/소비처 사용 증거로 확대하지 않는다. PR #261 CI exact-head 통과 후 main 병합하고, 운영 변수·IAM·ERP4 기존 실행은 변경하지 않는다. 사진 PR #260은 별도 필수 검토 HOLD를 유지한다.

## 2026-09-30 내부 AI API와 무보증 오인 전수감사

- 목적: 내부 AI 전용 read API 분리, 손오공/픽업 무보증 금지, 애매한 보증금 `미입력`/`확인중` 표시. 데이터·권한 고위험: 운영 쓰기/배포 없이 read-only + 준비 변경.
- 대상 revision: `origin/main@db788eb654c30f2f0970263f4904fa9a837dc504`, branch `work/freepass-data/internal-ai-deposit-audit-20260930`. 원래 checkout의 사용자 문서 변경은 보존했다.
- 재사용: 기존 consumer gateway, Kakao typed projector/commission schema, 고정 Firebase reader, private capture/inspect job을 확장(COMPOSE_OR_EXTEND). 신규 evidence helper/analysis/schema는 기존 자산에 없던 waiver 판정·비공개 전수진단·별도 내부 identity 계약을 보완하며 원천 reader/writer나 두 번째 정본을 만들지 않는다. Academy READY 확인.
- 원본: 2026-09-30T01:54:45.805120Z read-only transaction 캡처 products 1,717 / policy 82 / partner 64, independent COUNT FULL. digest `390b58b5a10de3a9ffb2d62d38d8b4b3abf2f0b82cf0fdb213066b1037fd6354`. F01/F86 현행 visible 탭 23개를 정확한 metadata/range로 읽음(운영 수정 없음).
- 관측: Son 47/Pickup 162 현행 Sheet에는 `무보증` 문자열 없음. RP012 ogong 38 + pickup 162는 유료기간 원천 deposit=0 + 보증금 규칙. 별도로 오플 35도 규칙 + 0. 전 유료기간 raw=0인데 waiver evidence가 없는 후보 842(노출 239); 후보에는 금액 미해석/조건 미확정이 포함되므로 모두 확정 오류로 쓰지 않는다. RP012 usedrent 원문 양수는 보존.
- 변경: 내부 `internal-ai-<project>` + 명시 capability `internal-ai-reference`만 허용. 토큰 공유/외부 권한/다른 capability는 거부. 별도 route/schema/reader와 감사. Canonical mapper v4는 숫자 0을 waiver 증거로 승격하지 않음. Reference API는 typed depositState + depositStatusLabel 제공. 기존 inspect job에 private deposit-audit/readback 추가.
- 검증: 초기 Claude 광역 검토 REVIEW_TIMEOUT(PASS 아님); 좁힌 독립 검토 ANSWERED. gateway 권한 격리에 합의, 양수+규칙 덮어쓰기·잘못된 waiver 값·identity 누락·sibling 검증 불일치는 수정/회귀검사 반영. 표시 라벨과 supplier-wide ban은 검토 중 이미 반영된 최신 변경으로 재검증한다. 최종 테스트/검토 영수증은 이어지는 기록과 PR에서 확인.
- 남음/HOLD: 신규 내부 키 발급·운영 grant/배포 없음. ERP `lib/domain/product.ts:noDeposit`의 all-zero heuristic 및 상세/기간 facet/공유/시트 publisher는 아직 이 계약으로 전환되지 않음. F01/F86 직접 쓰기·예약 pin 변경 없음. 원문 금액 누락/모순의 확정은 공급사 근거 필요. private audit의 price 누락/관련 decode failure는 별도 확인.
- next_start_here: [READ-RUNTIME](READ-RUNTIME.md)의 내부 AI/보증금 절 → [캡처 실행](ERP5-SOURCE-CAPTURE.md)의 보증금 전수감사 → 같은 digest private audit. consumer별 단위·비해당 기간을 확인해 표시 adapter 연결 후 정확한 승인 범위로 배포/발행하고 각 consumer readback을 기록한다. Sheet 빈칸 전체 치환 금지(비해당 기간도 있음).
- 최종 로컬 검증: architecture/standards/data-access/sheets/build/runtime-smoke/shadow/dashboard PASS; Vitest `--maxWorkers=2` 1,043 PASS / 14 SKIP(외부/emulator). 관련 검사 217 PASS. Claude ANSWERED 최종 좁은 검토에서 앞선 blocking 5건 해소 확인; 잔여 반례인 부정 waiver flag/대여료 없는 sibling/마스킹 assertion도 추가 가드·회귀검사로 보강. 운영 승인으로 확대하지 않음.
- 같은 캡처 reference dry-run: 682개 상품 / 기간별 보증금 있음 3,792 · 무보증 27 · 미입력 58 · 확인중 53. 손오공/픽업 ZERO 0. 원문 유료기간 10,557의 감사는 KNOWN 2,264 / ZERO 174 / UNKNOWN 8,119; 선택된 reference는 확인된 계산식을 해석하므로 이 두 모수를 혼동하지 않음. 보증금 관련 필드 decode 실패 0 / price 자체 누락 57. 원문 감사 결과는 동일 run의 UUID별 `deposit-audit-*.json`에 배타 보존·재읽기됨.

## 2026-09-30 프리패스 수수료와 연동 상대별 선택 규칙

- 목적: 사용자 직접 결정 `프리패스 수수료 = 지급수수료`를 실행 규칙과 계약에 고정한다.
- 대상 revision: `origin/main@a49dab2606f1273f5d8ad54c6c012fc8f9ca8549`에서 이어받은 `work/freepass-data/commission-audience-20260930`.
- 변경: 기존 `OfferTermEconomics`를 재사용(`COMPOSE_OR_EXTEND`)해 영업채널 기본 `channelPayoutFee`, 공급사용 `supplierBillingFee`를 선택하는 helper를 추가했다. 반환값에 상대편 수수료·마진·원천 참조가 없다. 기존 내부 Kakao API 계약은 유지한다.
- 검증: architecture/standards/data-access/sheets/build/runtime-smoke/shadow/dashboard PASS. 기본 병렬 Vitest는 기존 runtime-policy 5초 timeout 1건; 제한 변경 없이 `npx vitest run --maxWorkers=2` 전체 1,014 PASS/14 SKIP(외부·emulator 검사). 수수료 회귀검사 3건 PASS. 최종 commit·CI·Claude 검토는 PR 영수증에서 확인한다.
- Claude: 본문·exit 0·ANSWERED 확인, PREPARED 범위 병합 차단 없음. 기본 audience 중복정의와 문서 제목 계층 지적은 반영했다. 기존 field 이름은 이미 Canonical 계약이므로 유지하며, helper는 I/O 없는 도메인 선택 규칙으로 유지한다. 운영 API의 서버 grant·상대 ID scope 연결 전 외부 공개 금지에 합의했다.
- 남음: helper는 PREPARED이며 운영 API/전용키 scope 연결은 미구현이다. 신규 공급사·채널 등록이나 배포를 수행하지 않는다.
- next_start_here: `docs/READ-RUNTIME.md`의 수수료 연동 기준 → `src/domain/catalog.ts`의 `projectCounterpartyCommission`. 신규 외부 API는 서버 등록 audience와 상대 ID scope를 함께 강제한 뒤 연결한다.

## 2026-09-30 정책 의미 사전·읽기 진단 / main 통합

- 목적: 상품·정책의 값/단위/기준액/주기/자격/예외를 이해하고, 읽기 실패와 의미 손실을 드러내며 사용자 지시에 따라 main에 합친다.
- 대상 revision: 공개 main `7fdfc4e` 기반. 이전 로컬 감사 작업은 비공개 증거와 로컬 보존 ref에 유지한다. 공개 이력에는 원천 위치·공급사별 세부 조건·상품 식별자를 포함하지 않는다.
- 변경: 기존 commercial 문서에 72개 항목 의미 사전과 전달/갱신 경계 기록. 기존 capture reader에는 count-only 정책 진단과 합성 회귀검사 추가. 반환 사실·decoder·운영값·writer·schedule은 변경하지 않는다.
- 관측: 나이별 조건이 공개 API에서 빠지는 경우, 기본값 보충, 원천 문자열 연령의 numeric reader 미해석, 변동 수집의 신규차 제외, DB 내부 정책 참조 정리와 원천 본문 동기화의 차이를 확인했다. 자세한 증거는 제한된 로컬 감사 자료에서만 재조회한다.
- 검증: 같은 ERP capture에 대해 진단 추가 외 기존 결과 동일. 기본 병렬 전체 검사에서 기존 runtime-policy 테스트가 5초 timeout 2회였고, 제한을 변경하지 않고 `npx vitest run --maxWorkers=2`로 전체 1,011 PASS/14 SKIP. 해당 runtime 검사도 약1.9초에 통과. architecture/standards/data-access/sheets/build/runtime-smoke/shadow/dashboard 단계 PASS. 표준 역량 PARTIAL 및 skip된 외부/emulator 검사는 계속 미완료다.
- 남음: 원천 충돌과 정책 효력·단위 해석, 나이별 공개 계약, 신규 재고/정책 본문 갱신, 전 소비처·실제 계약 readback. main 병합은 운영 정책값 수정이나 배포 완료가 아니다.
- next_start_here: 아래 문서의 추가 감사 경계에서 소비처 연령별 조건과 source freshness를 각각 좁혀 검증한다. 기존 dirty checkout을 보존하고 실제 운영 변경은 해당 승인·원천 증거 경계를 따른다.

## 2026-09-30 Estimate writer permanent synthetic canary

- 목적: 전용 Estimate writer를 ON으로 전환할 때 Quote v2와 Share Envelope의 실제 저장·멱등 재시도·재조회를 한 배포 영수증에서 증명한다.
- 대상 revision: `origin/main@5e1be5f3244be6472ce3693fef100c960c227be6`, branch `work/freepass-data/estimate-writer-canary`.
- 변경: ON 배포에 실행별 고유 synthetic canary를 추가했다. 두 불변 자산 모두 `CREATED → EXISTING`, 동일 `persistedAt`, 동일 snapshot hash readback을 만족해야 배포가 통과한다. 토큰과 전체 payload는 출력하지 않는다.
- 재사용 판정: 기존 Estimate cutover probe는 ACTIVE master에 의존해 writer 저장 경계를 독립 검증할 수 없다. Canonical artifact 계약·digest는 재사용하고 writer-only probe만 `CREATE_NEW_JUSTIFIED`로 추가했다.
- 검증: 전용 테스트, 전체 check, Claude 독립 검토, PR CI 후 main 병합 및 운영 `write_mode=on` 실행 영수증을 확인한다.
- 남음: ACTIVE Estimate master release 부재와 실제 agent/admin Firebase 인증은 별도 HOLD이며, synthetic persistence PASS로 소비자 전체 cutover를 선언하지 않는다.
- next_start_here: main exact revision의 ON workflow에서 영구 synthetic 증거를 생성하고 Quote/Envelope ID·hash·persistedAt을 재확인한다.

### 2026-09-30 first ON run readback

- 운영 run `36591019208`은 첫 Quote transaction에서 `503 QUOTE_REPOSITORY_WRITE_FAILED`로 실패했고 자동 OFF 복귀가 PASS했다. 현재 Ready revision은 `freepass-data-estimate-writer-00005-hfd`, write mode `off`, traffic 100%다.
- 원인: custom role에 entity get/list/create/update만 있고 Firestore `beginTransaction` 필수 권한 `datastore.databases.get`이 없었다.
- 보정: 삭제·metadata·범용 Datastore User 권한 없이 `datastore.databases.get` 한 개만 추가하고 exact permission 검사를 5개로 고정한다.
- next_start_here: 보정 PR을 main에 병합하고 custom role readback이 정확히 5개인지 확인한 뒤 ON workflow를 재실행한다.

### 2026-09-30 ON activation complete

- 목적: 전용 writer의 실제 transaction 저장·멱등 재시도·불변 readback을 main exact revision에서 증명한다.
- 대상 revision: `main@fb75539356144dabe377d1170faedd22f8fd0346`, workflow run `36592266901`.
- 변경: custom role은 `datastore.databases.get`과 entity create/get/list/update 정확히 5개이며 보유자는 전용 runtime SA 1개다. 삭제 권한은 없다.
- 검증: run PASS. Quote `q_128d815c9c6657710776eaf7` / hash `128d815c9c6657710776eaf713b3665c50687fe841776beaa603158bd4f220f6` / persistedAt `2026-09-29T15:44:10.442Z`; Envelope `se_c0652432f3fc963ace9489d6` / hash `c0652432f3fc963ace9489d6710a2bdfbf70894646a9a8799254ad36b06043d2` / persistedAt `2026-09-29T15:44:11.644Z`. 두 자산 모두 CREATED→EXISTING 동일 persistedAt과 exact hash readback을 통과했다.
- 운영 readback: `freepass-data-estimate-writer-00006-76q`, image digest `sha256:6986cbd096540fd24229397843cbb234288a16fa8ecd0a18e6c2b87cbfff1b50`, write mode `on`, traffic 100%, secret version 3.
- 남음: ACTIVE Estimate master release 부재와 실제 agent/admin Firebase 인증은 계속 HOLD다. 이 writer persistence PASS를 전체 Estimate 소비자 cutover 완료로 확대하지 않는다.
- next_start_here: Estimate 쪽 실제 인증 사용자가 생기면 role/UID allowlist를 보존한 채 사용자 흐름 write readback을 별도 수행한다. master는 ACTIVE projection을 만들기 전까지 503 HOLD를 유지한다.

## 2026-09-29 Estimate dedicated writer runtime activation

- 목적: read runtime 권한을 넓히지 않고 Estimate Quote/Share Envelope 불변 저장을 전용 private Cloud Run 경계로 운영한다.
- 대상 revision: FreePass Data `303cfec88f8de29f9a4c18896f7f0f71e377585b`; FreePass Estimate `cbbfb8218b9d8e2b4ceb78cce7f0be8eba5561a5`.
- 변경: 전용 writer 수동 배포 workflow와 runbook을 추가했다. runtime SA·consumer secret·Vercel caller를 read runtime과 분리하며 secret은 숫자 version으로 고정한다. 최초 배포는 write OFF, 활성화는 authenticated canary 직전에만 ON이다.
- 검증: workflow 정적 검사, 전체 test/build, Claude 독립 검토, PR CI를 완료한 뒤 운영 bootstrap을 실행한다.
- 남음: GCP 최소권한 IAM/secret/WIF bootstrap, Estimate Vercel env/deploy, 영구 synthetic canary의 CREATED→EXISTING/readback 증거.
- next_start_here: 두 저장소 PR을 main에 병합하고 전용 서비스를 write OFF로 배포한 뒤, 인증 readback과 Estimate write allowlist를 확인하고 ON canary를 실행한다.

## 2026-09-29 Estimate immutable artifact persistence proof

- 목적: FreePass Estimate가 발행한 Quote v2와 Share Envelope를 FreePass Data가 계산·업무 의미를 가지지 않고 불변 저장하는 경계를 Issue #55 완료 조건에 맞게 감사한다.
- 대상: `origin/main@7bc4810c63988920f31467997319bb55975c76ed`, branch `work/freepass-data/estimate-artifact-proof`; 소비자 대조는 FreePass Estimate `main@df6b970564042715cdc84864ed828069884e49ec`.
- 변경: write receipt에 최초 서버 저장 시각 `persistedAt`을 추가하고 재시도에도 같은 시각을 반환한다. Quote 식별성은 생성 시각이 아닌 contract/id/version/snapshot/revision 증거로 판정해 같은 내용의 재발행을 멱등 처리한다. Estimate와 동일한 locale-independent code-point canonical JSON digest를 사용한다.
- 불변성: Share Envelope v1은 content-derived `se_<snapshotHash 24자>` ID와 version 1만 허용하고, 최대 100개 Quote 참조로 제한한다. 수정 계보 계약 없이 기존 공유 링크의 내용을 바꾸는 version 2 저장은 fail-closed다.
- 신규 계약: 기존 Estimate master/read 스키마와 Admin/Sheet receipt는 Quote·Envelope 영수증의 식별성·저장 시각·FOUND/NOT_FOUND 합성을 표현하지 못해 write/read receipt JSON Schema 4개를 `CREATE_NEW_JUSTIFIED`로 추가했다. Gateway는 반환값을 Ajv로 검증하고 부정확한 영수증을 503으로 차단한다.
- 검증: 전용 gateway 10 PASS, JSON Schema 29개 strict compile 및 표준 검사 15 PASS, TypeScript build PASS. 실제 Firestore Emulator에서 생성 시각이 다른 동시 멱등 재시도는 `CREATED + EXISTING`과 동일 `persistedAt`으로 수렴했고, 서로 다른 두 next revision은 단 하나만 저장됨을 2 PASS로 재현했다.
- Claude: 1차 독립 검토는 저장 시각, emulator/concurrency, `createdAt` 재발행 충돌, Envelope 가변 계보, locale digest, 참조 상한, 스키마 누락을 찾아 `HOLD`로 판정했고 변경에 반영했다. 2차에서 찾은 `Date.parse`/RFC3339 비대칭과 identity 화이트리스트 위험도 추가 보정했고, 최종 재검토는 치명·중대 잔여 0건 `PASS`다.
- 남음: 현재 운영 read runtime IAM은 영업 데이터 update를 허용하지 않으므로 `FREEPASS_DATA_ESTIMATE_ARTIFACT_WRITE=on`, writer IAM, 배포, 실제 소비자 round-trip은 별도 직전 승인 전까지 HOLD다. GitHub Actions의 emulator 자동 기동도 별도 automation 승인 없이 추가하지 않았다.
- next_start_here: 전체 `npm run check`와 Claude 최종 diff 재검토를 통과시킨 뒤 PR/CI/main 병합. 그다음은 Estimate 운영 writer runtime·IAM·round-trip 활성화 패킷을 별도 승인 경계에서 진행한다.

## 2026-09-29 Admin workflow execution / semantic ownership boundary

- 목적: FreePass Data가 Admin의 Firebase 접근·감사·트랜잭션 실행 경계라는 사실과 각 업무 사실의 semantic owner를 분리한다.
- 대상: `origin/main@e6cb0309c02863ebba5483be3e03f213b24ccddd`, branch `work/freepass-data/admin-workflow-ownership-boundary`.
- 정본 교정: `FREEPASS_DATA_SETTLEMENT`은 2026-09-28 결정과 운영 readback이 있는 최신 정산 사실 권위이므로 유지한다. Application/Contract/e-sign 업무 의미는 계속 FreePass Admin이 소유한다.
- 변경: 모든 Admin workflow resource에 semantic owner와 write-through 정책을 전수 등록했다. Catalog 원천(`products`, `policies`, `vehicleMaster`, `partners`)은 compatibility read만 허용하고 이 범용 gateway의 쓰기는 거부한다. 신규 commit은 v2 영수증에서 `FREEPASS_DATA_ACCESS_GATEWAY / EXECUTION_GATEWAY`와 관여한 semantic owner들을 분리해 기록하며 기존 v1 영수증 재시도 호환은 보존한다.
- 신규 계약: 기존 Admin Catalog read schema와 Sheet delivery receipt는 명령 실행·업무 소유권 영수증을 표현하지 못해 `contracts/admin-workflow-receipt-v2.schema.json`을 `CREATE_NEW_JUSTIFIED`로 추가했다.
- 검증: 전체 `npm run check` PASS(Vitest 993 PASS / 12 SKIP), 표준 schema 25개 compile, Admin workflow/data-domain 전용 12 PASS. Claude 설계 검토의 원자성·v1 digest·정본 충돌 지적을 반영했고 최종 및 감사 보강 재검토 PASS다. FreePass Admin `origin/main@dcfb1dd` 소비자는 commit 응답을 opaque record로 받아 v1 schema/authority 문자열을 고정 검증하지 않는다.
- 남음: 서로 다른 owner가 참여하는 원자적 Admin command는 부분상태를 만들지 않도록 허용한다. command별 허용 owner 조합은 실제 업무 command inventory를 먼저 고정한 뒤 좁힌다. 운영 write 활성화·배포는 별도 승인 사항이다.
- next_start_here: 전체 검사와 Claude 최종 diff 검토 후 PR/CI/main 병합. 이후 Estimate immutable artifact 저장 경계를 같은 방식으로 감사한다.

## 2026-09-29 Catalog Health 계약 게이트 정합

- 목적: Catalog Data Health 생산자·JSON Schema의 `1.1.0`과 cutover/read-runtime 검사기의 오래된 `1.0.0` 기대값 불일치를 제거한다.
- 대상: `origin/main@624c9bbe486c553e3170419bd78be6bad0bcc193`, branch `work/freepass-data/health-contract-boundary`.
- 변경: 두 운영 검사기가 `contracts/catalog-data-health-v1.schema.json`의 고정 contract/schema version을 직접 읽고, 고정 문자열이 없으면 fail-closed한다. read-runtime과 cutover 모두 폐기된 `1.0.0`을 거부하는 회귀검사를 추가했다. `check:standards`를 Core CI에 포함하고 DATA-HEALTH 문서를 `1.1.0`으로 맞췄다.
- 검증: 전체 `npm run check` PASS(Vitest 990 PASS / 12 SKIP), read-runtime 6 PASS, shadow/cutover 10 PASS, standards 15 PASS. Claude 1차 검토 HOLD 2건을 반영했고 재검토 PASS로 합의했다.
- 남음: 운영 배포와 cutover는 수행하지 않았다. 오래된 local branch/worktree는 미병합·dirty 여부를 개별 확인하기 전 삭제하지 않는다.
- next_start_here: `admin-workflow` 범용 쓰기와 `FREEPASS_DATA_SETTLEMENT` authority를 제품 소유권 경계에 맞게 분리한다.

## 2026-09-29 ISO 4217 KRW-only schema enforcement

- 목적: 합의한 표준 구현 순서의 두 번째 단계로 Catalog V1 통화 계약을 실제 검사기에 연결한다.
- 대상: `origin/main@ab76fe2b71b5cd8d379be4ca65b76b43474e71d7`, branch `work/freepass-data/iso4217-contract-check`.
- 변경: 모든 JSON Schema의 `currency` property를 전수 순회하고 local `$ref`를 해석해 현재 Catalog V1 허용 통화인 ISO 4217 `KRW` const만 허용한다. 프로필의 ISO 4217을 `HOLD → AUTOMATED`로 승격했다.
- 검증: 통화 제약 제거를 잡는 음성 fixture 포함 표준검사 15 PASS. 전체 `npm run check` PASS(Vitest 990 PASS / 12 SKIP). 직전 RFC3339 검토에서 Claude 공식 호출이 축소 범위까지 연속 300초 timeout이어서 이번 저위험 후속에는 재호출하지 않았고 PASS로 세지 않았다.
- 남음: 다중통화 minor-unit registry는 별도 unresolved capability로 유지한다. SHA-256은 실제 검사기 구현 전까지 HOLD다.
- next_start_here: SHA-256 integrity field 검사기를 세 번째로 구현하고 기존 느슨한 digest/checksum 계약을 정리한다.

## 2026-09-29 RFC 3339 schema enforcement

- 목적: 합의한 표준 구현 순서의 첫 단계로 canonical temporal 계약을 실제 검사기에 연결한다.
- 대상: `origin/main@44b8db958ed7970ccf06b83a97984da3277510b2`, branch `work/freepass-data/standards-required-checkers`.
- 변경: schema property 이름이 `At` 또는 `Time`으로 끝나면 local `$ref`, `anyOf`, `oneOf`, nullable 구조를 따라 RFC 3339 `date-time` 또는 의도적으로 명시한 `date` 형식만 허용한다. Control Tower의 누락된 `generatedAt`은 `date-time`으로, 정산 영업일자는 기존 `YYYY-MM-DD` 의미를 보존해 nullable `date`로 고정했다. 프로필의 RFC 3339만 `HOLD → AUTOMATED`로 승격했다.
- 검증: 음성 fixture 포함 표준검사 14 PASS, 정산 호환성 4 PASS, 전체 `npm run check` PASS(Vitest 990 PASS / 12 SKIP). Claude는 최신 AI Core 공식 실행 경로로 광범위/축소 검토를 각각 호출했으나 둘 다 300초 `REVIEW_TIMEOUT`; PASS로 세지 않았다.
- 남음: ISO 4217과 SHA-256은 실제 검사기 구현 전까지 HOLD다. 그 외 profile의 unresolved capability도 그대로다. 운영 쓰기·배포·cutover는 수행하지 않았다.
- next_start_here: ISO 4217 검사기를 두 번째로 구현하되, 현재 Catalog V1의 KRW-only 범위를 계약과 회귀검사로 고정한 뒤 `HOLD → AUTOMATED`로 승격한다. 이후 SHA-256을 진행한다.

## 2026-09-29 standards conformance false-positive closure

- 목적: 국제표준 적합성 프로필의 `AUTOMATED` 표시를 실제 검사와 일치시키고 거짓 완료를 차단한다.
- 대상: `origin/main@dd2fc207f4018dd585244ff0a18b357bde8293f4`, branch `work/freepass-data/standards-conformance-v2`.
- 변경: 미구현 RFC 3339·ISO 4217·SHA-256 검사를 `HOLD`로 정정했다. JSON Schema 2020-12는 strict Ajv 컴파일에 연결했고, 모든 `contracts/*.json`을 schema 또는 명시적 instance 계약으로 분류한다. `AUTOMATED` 검사기 미등록/미실행, `COMPLETE` 상태의 HOLD 표준·미해결 capability, 승인근거 없는 NOT_APPLICABLE을 모두 fail-closed한다. strict 컴파일이 찾은 기존 schema 문맥 오류도 의미 변경 없이 보정했다.
- 검증: 표준 게이트 24 schema compile, 3 instance accounted, 음성 fixture 포함 13 PASS. 전체 `npm run check` PASS: Vitest 990 PASS / 12 SKIP, Sheets 24, read runtime 5, shadow 10, dashboard 21. Claude 1차 검토가 COMPLETE/HOLD·checker 결속·strict 사각지대를 찾아 반영했고, 2차 검토는 치명 결함 없음 및 PARTIAL 판정에 합의했다. `unresolvedCapabilities` 차단은 기존 코드와 신규 fixture로 재확인했다.
- 남음: RFC 3339, ISO 4217, SHA-256은 실제 전수검사 구현 전까지 HOLD다. OpenAPI/RFC9457/VIN/vehicle media/privacy/CloudEvents/consumer cutover도 계속 HOLD다. 운영 쓰기·배포는 수행하지 않았다.
- next_start_here: RFC 3339 검사기를 먼저 구현해 `HOLD → AUTOMATED`로 승격하고, 같은 방식으로 ISO 4217과 SHA-256을 진행한다.

## 2026-09-30 상품·접수·계약·정산 운영 감사와 사용자 관리 범위

- 목적: 사용자가 요청한 GPT/Claude 공동 검증에 접수·계약·정산 데이터 관리까지 포함한다. 기존 연결 지도 `docs/BUSINESS-DATA-CONNECTION-MAP.md`의 2026-09-30 절에 실측과 관리 경계를 확장했다. 두 번째 원장을 만들지 않는다.
- 대상 revision: 읽기 정본 `origin/main@af602856fa9f906747c4957d130482adad118bbd`; local baseline `cf06993d5df3876a863f8c379abeb1916e5b9ab8`. 로컬 문서 2개만 변경했으며 commit/push/배포하지 않았다.
- 검증: ERP4 run `36593017154` 원자↔F01/F86 차이 0, Data run `36595437447` publication HOLD/consumer BLOCKED 8. 인증 live compatibility 200(상품 1,717/정책 82/파트너 64), Canonical catalog 503 NO_ACTIVE_RELEASE. Admin read는 계약 121/정산 472/환수 23, 정산 code 중복 0. 정책 문자열 주행거리 미해석과 timestamp 포함 정책 탈락은 합성 입력으로 재현했다.
- Claude: 첫 광범위 호출 무응답 종료, 비식별 집계 재검토는 본문·exit 0·ANSWERED 확인. 부분 대사로 전체 정상 보증 불가에 합의했다. 서로 다른 집계 축을 빼서 오류 대수를 산출하는 제안은 채택하지 않았다.
- 남음: 원천별 최신성/누락, 실제 예약 간격, 변환기 한계, ACTIVE release, 소비처별 실제 사용 증거, 계약-정산 안정 키, 테스트/삭제 구분, 정산 금액과 실제 입출금 원문 대사, 운영 runtime과 main의 보안 경계 차이. 472건은 금액 검산 완료가 아니다.
- next_start_here: 연결 지도의 최신 감사 절에서 확인된 key/decoder/runtime 문제를 각 수정 패킷으로 분리한다. 운영 값을 추정 보정하거나 빈 event collection을 업무 이력 부재로 확정하지 않는다. runtime `admin-00004-lwg`는 기존 write ON이나 최신 main의 Catalog 범용쓰기 차단 전 revision이므로 배포 차이를 우선 검토한다.
- 2026-10-03 기록 이관: 위 내용은 `C:/dev/freepass-data` 로컬 미커밋 상태로 남아 있던 것을 내용·숫자 변경 없이 최신 main에 옮겨 커밋했다. 관측 시점 판정은 2026-09-30 그대로다.

## 2026-09-29 platform standards conformance baseline

- 목적: FreePass Data 전체를 국제표준 기반 공통 Canonical 규격으로 확장하되, 미구현 영역을 숨기고 완료 선언하지 못하게 한다.
- 대상: `origin/main@0c9e377af01e57ecdf6b5a13f5de388a28137e92`, branch `work/freepass-data/platform-standards-v1`.
- 변경: `contracts/freepass-data-standards-profile.v1.json`에 적용 표준, 내부 필수 capability, 미해결 capability를 기계 판독 가능하게 등록했다. `check:standards`는 모든 JSON Schema 계약의 Draft 2020-12 선언과 고유 HTTPS `$id`를 검사하고, 미해결 capability가 남은 `COMPLETE` 선언을 거부한다.
- 검증: 24개 schema, 9개 표준 항목 검사 PASS; 전용 Node test 3 PASS; build 및 기존 검사 PASS. 전체 Vitest 첫 실행은 기존 runtime-policy 5초 제한에서 1건 timeout, 해당 파일 단독 재실행 5 PASS.
- 남음: OpenAPI 3.1, RFC 9457, ISO 3779 VIN, 차량 미디어, 개인정보 수명주기, CloudEvents, 다중통화, 공급사 필드 커버리지, 전 소비처 cutover readback은 명시적 HOLD다. 운영 쓰기·배포·cutover는 수행하지 않았다. Claude 독립검토는 응답 지연으로 `UNAVAILABLE`이다.
- next_start_here: `contracts/freepass-data-standards-profile.v1.json`의 `unresolvedCapabilities` 순서대로 각각 계약·런타임·회귀검사를 구현하고 하나씩 제거한다. 다음 우선순위는 `VEHICLE_MEDIA_ASSET_CONTRACT`와 `ISO_3779_VIN_VALIDATION`이다.

Status: **READ-ONLY OPERATIONS v1.0 / CONSUMER HANDOFF**
Official project name: **프리패스 데이터 / FreePass Data**
Repository: `freepass-creator/freepass-data`
Handoff base when closure work started: `28d46e1f8d14a3a08d86586dae535838e4d123cd`
Branch: `main`
Date: 2026-09-28

## 2026-09-29 RP021 빌린카 정책 원본 정합·연결 보정

- 정본: `[F67 사용중] 빌린카 프리패스 재고` (`1036j-xoQtu-nzWOcfky8MmtSRrvPhRls16E7n49iFVA`),
  `운영정책` sheetId `654905320`, `A1:BS5`.
- 원본의 `pol_freepassstd` 1건과 `POL-0035`, `RP021_S01`, `RP021_S02`는 서로 다른 4개 정책이다.
  S01과 S02는 추가주행료·연령하향료가 달라 합치지 않는다.
- 활성 RP021 상품 47대의 원천 정책 UID는 모두 `pol_freepassstd`이다. 35대는 이미
  `FP-RP021-RENT`에 연결됐고, 나머지 12대는 같은 UID를 보존하고도 `policy_code`가 비어 있다.
- `FP-RP021-RENT`는 원본보다 주행거리·추가주행료·연령하향료·보상한도가 drift된 상태다.
  원본 표준은 연 20,000km, 1만km당 10만원, 만 26세 이상, 만 21세까지 하향, 하향료 10만원,
  보험료 포함이다.
- Firestore `POL-0040`은 원본에 없고 연결 상품도 없는 `POL-0035` 중복 drift로 판정했다.
- 적용기는 정책 5건·상품 47건을 private backup하고 update-time 사전조건을 걸어,
  정본 정합·12대 연결·미사용 중복 퇴역을 한 transaction에서만 실행한다.
- 로컬 검증: `npm run check` 990 PASS / 12 SKIP.
- main: PR #238, merge `9c3848eb2f20783c3cbcb8eee68a0e631e1bcd9f`; Core CI와 Canon Guard PASS.
- 운영 보정: exact main revision에서 run
  `2026-09-29T09-12-45-763Z-39915592-4ee9-479f-9d1b-2536163acaea` 실행. private backup 후 12대를
  `FP-RP021-RENT`에 연결했고, 활성 RP021 47/47 전체가 같은 정본 정책을 참조함을 새 조회로 확인했다.
- readback: `FP-RP021-RENT`는 연 20,000km, 1만km당 10만원, 만 26세 이상,
  만 21세까지 하향·하향료 10만원, 보험료 포함이다. S01/S02는 각각 15/20만원과 5/10만원을
  그대로 보존했고, `POL-0040`만 `POL-0035`의 미사용 중복으로 퇴역했다.
- ERP.com: 기존 미연결 `08주6722` (`/q/6e3ur7v9fg`)에서 요금 기준,
  보험 보상한도·면책금, 이용조건이 모두 원본과 같게 노출되는 것을 확인했다.
- Claude 읽기 전용 독립 검토는 status available 후 호출했으나 응답 본문 없이 멈춰 `UNAVAILABLE`이며 PASS로 세지 않았다.

next_start_here: 빌린카 원본에서 새 상품이 입력될 때 `정책UID`를 잃지 않고 정본 코드로 변환하는지 계속 감사한다. S01/S02는 비용이 다른 별도 정책으로 유지한다.

## 2026-09-29 RP023 오토플러스 운전자 연령 정책 교정

### RP023 전 상품 정책 연결 통일

- 2026-09-29 사용자 결정으로 활성 RP023 오플구독 155대는 정본 정책 `POL-0047`로 통일한다.
- 기존 복구기를 확장해 활성 RP023 정확히 155건, 모두 `오플구독`인지 쓰기 전에 fail closed로 검사한다.
- 정책 2건과 상품 155건을 private backup한 뒤 update-time 사전조건을 걸은 한 transaction으로
  정책 교정과 상품 참조 연결을 적용하고, 155건 전수 `POL-0047` readback을 필수로 한다.
- 삭제 상품과 다른 공급사는 대상이 아니며, 필드를 추정해 보정하지 않는다.
- 로컬 검증: 개별 7 PASS, `npm run build` PASS, `npm run check` 987 PASS / 12 SKIP.
- Claude 읽기 전용 독립 검토는 status available 후 호출했으나 응답 본문 없이 멈춰 `UNAVAILABLE`이며 PASS로 세지 않았다.
- main: PR #236, merge `4ab2a88b0a38909f01a8b117b0bcedd09931e7ac`; Core CI와 Canon Guard PASS.
- 운영 보정: exact main revision에서 run
  `2026-09-29T08-32-37-965Z-a763a548-6b7a-4140-9ce5-046a63ea3fae` 실행. 사전 155건을 전수 검사하고
  기존 `POL-0047`이 아닌 89건을 연결했으며, 적용 후 155건 모두 `POL-0047`임을 새 조회로 확인했다.
- 상세 화면 readback: 기존 미연결이었던 출고가능 `07어4389` (`/q/jems2ua8au`)에서
  `기준 연령 만 26세 이상`, `기준 주행거리 연 30,000km`, `보험료 포함`, `연령 낮추기 불가`와
  보험 보상한도·면책금이 노출되는 것을 운영 ERP.com에서 확인했다.

next_start_here: RP023 활성 상품이 155건에서 변경되거나 오플구독이 아닌 자료가 들어오면 이 일회성 보정은 fail closed한다. 새 RP023 상품 입력 경로가 기본값으로 `POL-0047`을 받는지는 별도 회귀 검사 대상이다.

- 사용자 결정: 오플구독 기본 대여료 조건은 `만 26세 이상`, 상품별 약정 주행거리, 보험료 포함이며 운전자 연령 하향은 불가다.
- 운영 원인: `POL-0047`이 과거 공통정책 복제 과정에서 `만21세`와 `age_lowering_cost=10만원`을 함께 물려받았고,
  `FP-RP023-RENT`에도 하향 가능 연령 없이 비용만 남아 있었다.
- 변경: RP023 정책 불변조건을 추가하고, 하향 가능 연령이 없는 정책의 `age_lowering_cost`를 소비자 월대여료 조정항목으로
  노출하지 않는다. 운영 보정은 두 정책만 대상으로 수정 전 private backup, update-time 사전조건, 한 transaction,
  필수 기본조건 readback을 요구한다.
- main: PR #230, merge `eb55de9298f1fba77e3f70d695aaab19f8a4f3c2`; Core CI와 Canon Guard PASS.
- 운영 보정: main exact revision에서 run
  `2026-09-29T04-44-30-502Z-42019aec-9cd2-4fa9-85bf-76c6b1542a68` 실행. `POL-0047`과
  `FP-RP023-RENT` 모두 기본연령 `만 26세 이상`, 연령하향 `불가`, 연 30,000km, 보험료 포함이며
  `age_lowering_cost`가 없음을 새 조회로 확인했다.
- 차량번호 readback: `309고5544`는 RP023 오플구독 → `POL-0047`이고 동일 조건 및 본문
  `운전연령하향: 불가`를 확인했다. 운영 수정 전 private backup이 생성됐다.
- 검증: 로컬 전체 984 PASS / 12 SKIP 뒤 기존 `runtime-policy` 5초 timeout 1건은 단독 5 PASS;
  GitHub Core CI PASS. Claude 독립 검토는 응답 본문이 없어 UNAVAILABLE이며 PASS로 계산하지 않았다.

next_start_here: RP023의 정책 미연결 상품은 별도 정책 연결 근거 없이 자동 연결하지 않는다. 연결 여부와 연령 정책 정확성은
분리하며, 미연결 상품을 이번 보정에서 추정 수정하지 않는다.

## 2026-09-28 vehicle-name evidence repair

- 기존 parity 결과를 현재 Firestore 원문 차명·연식·차량번호와 다시 결합했다. 마스터명 일괄 치환과
  상품별 판정을 분리하며, F03 후보명이 원문에 명시되고 유효기간이 겹치는 경우만 repair한다.
- exact plan: master 41건 / product 116건. 적용 후 독립 product parity로 확인된 나머지 product 84건은 원문에 세대가 없거나, 원문과
  정제값·연식이 충돌하거나, 현재 F03 후보에 최신 세대가 없어 HOLD다.
- apply는 exact source digest 승인, 수정 전 private backup, 한 Firestore transaction의 expected-value
  precondition, Data Access 감사, 수정 후 전체 readback을 모두 요구한다.
- 검증: 신규/관련 테스트 6 PASS, TypeScript build PASS, 전체 check 중 977 PASS / 12 SKIP 후
  기존 `runtime-policy` 5초 timeout 1건은 단독 재실행 5 PASS로 확인했다.

next_start_here: HOLD 84건은 현재 Google Sheets OAuth scope 복구 후 최신 F03 재조회와 공급사 원문
보강 전에는 추정 수정하지 않는다.

- production apply 완료: run `2026-09-28T06-11-51-115Z-741269dd-94d8-440d-8e5f-6d246456b316`.
  `vehicle_master` 41건 + `products` 116건을 수정 전 private backup 뒤 단일 transaction으로 적용했고
  157건 readback이 모두 일치했다.
- post-apply 전체 감사: errors 0, product HOLD 84, digest
  `6f581fa84145590bd283968ab9297620455e20a0a5e70bef8029e11906f40cd4`.
- `G80 DH`, `올 뉴 K3 BD` 잔존은 0건이다. HOLD는 자동 보정하지 않았다.

Post-apply audit에서 master 이름이 먼저 정정된 뒤 stale product가 기존 master-issue 전파 검사에서
빠지는 경우를 발견했다. product를 master 상태와 독립적으로 F03 reference에 직접 대조하도록 보강하며,
정정되지 않은 product는 `PRODUCT_REFERENCE_NAME_MISMATCH` HOLD로 계속 노출한다.

## 2026-09-28 vehicle-name reference parity gate

- 정본 비교 기준은 F03 `차종마스터`의 엔카 표시명이다. 세대코드를 일괄 삭제하지 않고 F03의 정확한
  표시명(`K5 DL3` 등)은 그대로 보존한다.
- 전체 입력 스냅샷(F03 1,668행 / Firestore `vehicle_master` 1,816건 / `products` 1,717건)을
  읽기 전용으로 대조했다. 명백한 세대코드 접미사 drift는 master 41건·현재 product 93건이고,
  기간 또는 명칭이 모호한 항목은 master 187건·product 105건으로 HOLD다.
- `G80 DH -> G80`, `올 뉴 K3 BD -> 올 뉴 K3`는 명백한 drift에 포함되지만 이 두 사례만을 위한
  예외 코드는 두지 않았다. 모든 제조사·모델에 동일한 reference parity 규칙을 적용한다.
- 재현 명령: `npm run audit:vehicle-name-parity`. 입력은
  `VEHICLE_NAME_REFERENCE_JSON`, `VEHICLE_NAME_MASTER_JSON`, 선택적
  `VEHICLE_NAME_PRODUCT_JSON`으로 고정하며 불일치/HOLD가 있으면 exit 2로 닫힌다.
- snapshot digest: `832c9db20f77f99ae4002e5a1eb35ab34866646e2512dae37319115272b62e68`.
- 검증: `npm run check` PASS (Vitest 976 PASS / 12 SKIP 포함). 이 packet은 audit 계약이며
  운영 Firestore 값을 자동 수정하지 않았다.

next_start_here: 명백한 41개 master/93개 product 후보는 source evidence와 plate-level readback을
붙인 별도 dry-run repair로 처리한다. HOLD 187개 master/105개 product는 이름을 추정하거나 세대코드를
일괄 삭제하지 말고 F03 행·연식·원천 상품명을 추가 대조한다.

## 2026-09-28 F86 font durability lock

- 기계 정본 `contracts/f01-f86-sheet-spec.v1.json` v1.1에 F86 글꼴을 `Malgun Gothic` 9pt 기울임으로 고정했다.
- `scripts/sheet-presentation.mjs`는 F86의 모든 보이는 판매/공급사 탭에서 실제 사용 범위 전체를 검사하고,
  불일치가 하나라도 있으면 해당 범위에 글꼴·크기·기울임만 다시 적용한다. 값·수식·색·굵기 등 다른 서식은 건드리지 않는다.
- F01은 기존 글꼴을 보존하고 이 F86 전용 규칙을 적용하지 않는다.
- 검증: sheet contract 24 PASS, TypeScript build PASS. 전체 `npm run check`와 GitHub CI 후 `main` 병합한다.

next_start_here: 운영 발행기는 이 계약의 exact main revision을 사용해야 한다. 운영 시트 재적용은 별도 승인과
백업/readback 절차를 거치며, 코드 병합만으로 live Sheet write 완료라고 표현하지 않는다.

## 2026-09-28 Kakao reference facts packet

`work/freepass-data/kakao-facts-20260928`에서 Kakao 전용 typed `REFERENCE_ONLY` 계약을 구현했다.

- 요청 원문: `kakao-ops@ee9dea7`의 `docs/handoffs/FREEPASS-DATA-요청-20260928-보증금-색상-수수료.md`
- source base: `main@41919776437890413200902d13b112c017aaeb14`
- route: `GET /v1/consumers/kakao-ops/catalog-reference`
- 기간별 계산 보증금, 명시적 ZERO/UNKNOWN, ERP5 외장색상, ERP4 정본/F04 사본 기반 청구·지급·예상수익 상태를 제공한다.
- 기존 Canonical `/catalog`의 fallback이 아니며 응답은 `authority=REFERENCE_ONLY`, `publicationDecision=HOLD`다.
- 로컬 private capture 전수검증: source 1,659 / projected 685 / terms 4,223 / exterior color 678;
  deposit KNOWN 4,037 / ZERO 36 / UNKNOWN 150.
- 검증: 최신 `main@cc4c8e6` 통합 후 이안카 일회성 정책 적용 경로를 기존 Data Access Gateway로 감싸고
  `npm run check` 전체 PASS: architecture/data-access/build, node route/sheet/shadow/dashboard 60건,
  Vitest 958 PASS / 12 SKIP. 운영 Firestore 쓰기는 실행하지 않았다. Claude 읽기 전용 검토는 다시 요청했으나
  응답 없이 멈춰 `UNAVAILABLE`이고 PASS로 계산하지 않는다.
- publication: PR #222에 통합 결과를 추가해 새 HEAD CI를 재검증한 뒤 `main` 병합한다.
- 운영 HOLD: PR merge, read runtime deployment, `kakao-ops` 전용 secret 등록, 운영 PC readback,
  Kakao 계산 제거는 아직 실행하지 않았다. 운영 배포와 consumer 변경은 별도 승인/후속 작업이다.

next_start_here: PR #222 병합 후에도 read runtime 배포, `kakao-ops` 전용 secret 등록, 운영 PC readback과
Kakao 계산 제거는 별도 승인/HOLD로 유지한다.

## 2026-09-28 READ-ONLY OPERATIONS v1.0

G1 중앙 read runtime 운영 기반은 완료됐다.

- canonical main: `ff591ef835179439828f81aa5b4f605356964c84`
- successful deployment: GitHub Actions run `36327937895`
- Cloud Run: `freepass-data-read`, `asia-northeast3`
- Ready revision: `freepass-data-read-00011-4sw`
- immutable image digest: `sha256:90d2b9da9361da3facd774eadf19a412ad6cc712f36f7575a566e4d226dd013c`
- unauthenticated `/health`: HTTP 403
- WIF-authenticated `erp-com/catalog-compat`: HTTP 200 and contract readback PASS
- runtime identity: `freepass-data-read-runtime@freepasserp5.iam.gserviceaccount.com`
- business data는 `datastore.viewer`로만 읽지만 Data Access 감사 이벤트 append를 위해 custom
  `datastore.entities.create` 권한이 있다. Firestore IAM은 collection 단위로 이를 제한하지 못하므로
  감사 collection 경계는 application code로 강제한다. Canonical/source/projection mutation 권한은 없다.
- deploy identity는 프로젝트 전체 `run.admin`이 아니라 이 Cloud Run service의 `run.admin` +
  `run.invoker`만 가진다.
- deploy WIF는 별도 pool이며 numeric owner `256007744`, repository, `main` branch와 정확한
  `deploy-read-runtime.yml@refs/heads/main` 조건을 모두 고정한다.

로컬 Codex와 Claude의 공통 GCP 실행 경로는 native gcloud configuration `freepass-data`다.
계정은 `dudguq@gmail.com`, project는 `freepasserp5`다. 키 파일을 복제하거나 문서에 credential을
남기지 않는다. 세션 확인은 `gcloud config configurations activate freepass-data` 후
`gcloud config list`로 하며 재인증 실패는 우회하지 않고 HOLD한다.

다음 시작점은 G2 소비 프로젝트의 Preview `OBSERVE` 연결이다. 이는 FreePass Data v1.0 기반
완료와 분리된 소비자 작업이며, 사용자 GO 전 `FREEPASS_DATA_READ` cutover는 금지한다.

## 2026-09-27 closure entrypoint

FreePass Data를 계속 확장하지 않고 운영 기반을 닫는 현재 계획과 무료 ChatGPT/Codex 작업 분담은
[`PROJECT-CLOSURE-AND-FREE-CHAT-HANDOFF.md`](./PROJECT-CLOSURE-AND-FREE-CHAT-HANDOFF.md)를 따른다.

첫 운영 게이트였던 IAM-protected Cloud Run bootstrap과 실제 readback은 위 2026-09-28 증거로 닫혔다.
과거 run `36317333170`의 fail-closed 기록은 bootstrap 전 상태이며 현재 상태로 사용하지 않는다.

커밋 `28d46e1`의 `activate`는 배포 workflow 활성화를 뜻하며 Cloud Run 배포·consumer cutover 완료가 아니다.

## 2026-09-26 FreePass Data internal consolidation

Project-local data-layer cleanup only:

- central target Firebase binding must flow through `src/infra/firebase-target.ts`;
- source evidence collection names and source document-ID encoding are shared through `src/infra/firestore-layout.ts`;
- source-run CURRENT / STALE / INELIGIBLE promotion policy is centralized in Domain `decideSourceHead`;
- ingestion uses the responsibility-specific `SourceIngestionStore`; Canonical mutations remain behind `CatalogStore`;
- FreePass Data owns Estimate master-data facts/projection only, not the Estimate pricing/issued-quote engine;
- preview UI remains reference-only and is not a product UI authority.

Company-wide branch/PR lineage governance belongs in AI Core and is intentionally not duplicated here.

## 2026-09-25 F01/F86 SSOT bridge stabilization checkpoint

**FreePass Data owns shared data facts and release evidence; FreePassERP.com/F01/F86 are consumers/transports.** Consumer-side pricing/deposit/status interpretation을 새로 만들지 않는다.

### Verified in this work packet

- Data-owned read-only bridge가 `products + policy + partner`를 한 Firestore transaction에서 읽는다.
- 정상 공동 준비는 `--workbook=ALL`: 한 capture/release/manifest가 F01/F86 handoff를 함께 만든다.
- Firestore document-path ID와 payload `_key` 불일치는 fail closed 한다.
- source observation time과 publication time을 분리한다.
- bridge는 `depositRuleViolations`를 전달하고 0이 아니면 publication을 막는다.
- 운영 publication evidence에서 products 1,659 / policy 81 / partner 64, registered 1,659 / unavailable 967 / open 692, common drift 0, `depositRuleViolations=0`가 확인됐다.

### Runtime compatibility / HOLD

예약 production workflow는 ERP4 main 자체가 아니라 별도 pinned publication engine을 사용할 수 있으므로, main PR CI만으로 production-pin parity를 주장하지 않는다.

다음 단일 실행 목표:
1. live **read-only** Data bridge를 `--workbook=ALL`로 준비한다.
2. exact source readTime/release/manifest/digests를 보존한다.
3. 동일 handoff를 pinned F01/F86 publication engine shadow에 소비시킨다.
4. 같은 source state의 legacy output과 rendered F01/F86 vehicle key/business cell을 비교한다.
5. rendered parity + delivery/readback receipt가 유효해진 뒤에만 legacy snapshot source cutover를 검토한다.

계속 HOLD:
- production Sheet writer switch
- live Sheet write from FreePass Data
- Canonical ACTIVE Catalog cutover

## 2026-09-22 publication-readiness gate

상시 ERP5 감사에 기계 판독 가능한 공개 판정 게이트를 추가했다. `FULL / COMPLETE`는 원천 관측 범위이며
Canonical 쓰기나 ACTIVE release 허가가 아니다. source digest
`b0930c6999a092c28263db7a3c8a8390ef9aa9d661c8a290e085f2cb3881cd6d`를 run `35696297683`에서 재검증한 결과 원천 1,659건과
candidate 1,659건이 일치했고, 1,659건 모두 HOLD, 검토 완료 0건, ACTIVE 허가 `false`다. 현재 사유는
`MAPPING_HOLD_PRESENT`, `NO_CANDIDATES_READY_FOR_REVIEW`, `REVIEW_APPROVALS_NOT_INCLUDED`,
`CANONICAL_RELEASE_NOT_BUILT`다.

다음 시작점은 검토 증거로 mapper/policy HOLD를 줄인 뒤 별도의 reviewed Canonical import/release 명령을
만드는 것이다. 일부만 전체 카탈로그로 공개하지 않는다. Kakao는 전용 토큰으로 비어 있지 않은 검토된
ACTIVE release를 운영 PC에서 읽기 전까지 OBSERVE/HOLD다.
수동 workflow 전체는 GCS 저장·readback까지 성공했지만 native `schedule` 이벤트는 아직 0건이다.

## 2026-09-22 continuous-audit durability checkpoint

- `freepasserp4` production writer native schedule run `35705106480` succeeded on
  2026-09-22 17:29 KST. It collected current sources, reconciled the settlement-ledger
  intake/cancel vehicle locks, rebuilt ERP5, published one fixed snapshot to F01/F86,
  and completed cell-level audit. Published inventory was 707 vehicles; F01/F86 missing,
  residual and differing-cell counts were all zero.
- The same run read 1,659 ERP5 product atoms and the existing settlement ledger state
  (`접수` 80 plates, `취소` 31 plates; 30 cancellation candidates after excluding
  re-intake). It found zero new locks and zero unlocks because ledger and atoms already
  matched. Forty ledger plates were absent from the current atom; they were reported as
  evidence and were not invented or force-added to inventory.
- `main@d63d051`에서 권한을 실행 증거 계정과 `latest.json` 전용 계정으로 분리했다.
- run `35693167169`, `35693329115`가 연속 성공했고 각 실행별 GCS 객체의 create-only 업로드와
  byte-for-byte readback, 포인터 generation 조건 갱신을 통과했다.
- 최신 관측은 products 1,659건, policy 81건이며 의미 매핑 1,659건은 계속 HOLD다.
- 실제 `schedule` 이벤트 성공과 비어 있지 않은 ACTIVE `erp-public` release는 별도 미완료 게이트다.
- Kakao Ops는 `kakao-ops` 전용 token과 `catalog-reference`, `settlement-ledger-read` 최소 권한으로
  운영 등록·API 왕복을 완료했다. ERP.com의 `erp-com` 토큰은 재사용하지 않는다.

## 0. Start here now — source control tower

FreePass Data must know each registered source by identity, ownership, collection, complete record count,
field structure, last successful observation, immutable digest and change from the prior observation. A request
to “bring FreePass data” must resolve to this inventory and its private raw evidence without rediscovery.

The current monitored source is `freepasserp5` Firestore `(default)`:

| Source | Role | Last verified full count | Structure evidence | Authority |
| --- | --- | ---: | --- | --- |
| `products` | ERP5 product/inventory Atom | 1,659 | 508 recursively observed field paths | read-only monitoring; Canonical write HOLD |
| `policy` | ERP5 policy source | 81 | full raw capture retained privately; semantic approval incomplete | read-only monitoring; Canonical write HOLD |
| `catalog_products` | FreePass Data Canonical target | 0 | no active Canonical population | write/cutover HOLD |
| `catalog_offers` | FreePass Data Canonical target | 0 | no active Canonical population | write/cutover HOLD |
| `catalog_policies` | FreePass Data Canonical target | 0 | no active Canonical population | write/cutover HOLD |
| `projection_active` | active consumer release pointer | 0 | no active release | consumer cutover HOLD |

The 1,659/81/508 values are the last verified observation, not eternal constants. Every successful observation
must carry `readTime + sourceDigest + collection counts + field-path count + delta`. Count equality alone does
not prove equality. Added, changed, missing-from-source and inventory-state transitions are retained as HOLD
evidence; none independently authorizes deletion, delisting or Canonical mutation.

The read-only monitor is `.github/workflows/erp5-continuous-audit.yml`. It reuses the FULL same-transaction
capture, field profiler and prior-capture delta to emit `source-inventory.json` plus private immutable evidence.
It is active on `main` with repository-scoped GitHub OIDC, the read-only service account
`github-data-auditor@freepasserp5.iam.gserviceaccount.com`, and the private versioned evidence bucket
`freepasserp5-data-audit-evidence`. First successful run `35689380147` wrote and read back `latest.json`.
Follow-up run `35689500302` loaded that pointer and proved the recurring delta path: 1,659 unchanged,
added/changed/missing/inventory transitions all 0. Both observations covered 1,659 products, 81 policies and
508 product field paths in one read-only transaction. Canonical and destructive writes remain unauthorized.

The only production refresh writer is `freepass-creator/freepasserp4`'s
`.github/workflows/erp5-ssot-refresh.yml`: 24 supplier sources → ERP5 Atom/policy reconciliation → fixed snapshot
→ F01/F86 publication and audit under one concurrency boundary. Its watchdog recovery run `35687135474`
completed source collection, freepasserp5 update, F01/F86 publication and cell-level audit on 2026-09-22.
FreePass Data continuous audit remains read-only and must not become a second writer.

Immediate next step: the ERP4 writer native `schedule` path is now observed. Observe the first native `schedule`
event for the FreePass Data read-only monitor; manual/workflow recovery success is not native schedule-delivery
proof for that separate workflow. Continue field-semantic decisions for the
1,659 product records while retaining each FULL observation and delta in the private evidence bucket.

## 1. Last verified live read evidence — 2026-09-21 22:44 KST

Read-only Firestore counts from the explicitly bound `freepasserp5` project:

- legacy `products`: 1,659
- legacy `policy`: 81
- `catalog_products`: 0
- `catalog_offers`: 0
- `catalog_policies`: 0
- `projection_active`: 0

Current verdict: `HOLD_MISSING_CANONICAL_OR_RELEASE`. No Canonical write, release
activation, deployment, IAM mutation, or consumer cutover was performed.

The latest private source capture has digest
`c28202a0f8f920e04b9e1940ab0d93d2d806f57d9f543e481506b62026f77c8b`
at Firestore readTime `2026-09-21T13:44:58.865660Z`. It contains all 1,659
products and 81 policy documents, with 0 decode failures and 0 normalized plate
duplicates. All 1,659 products remain mapping HOLD because business semantics are
not fully confirmed. Policy-link analysis found 1,342 exact review candidates and
317 unset references; exact matching is evidence for review, not write approval.

Next start here: define and review the authoritative mapping decisions for mileage,
deposit, price keys, Sonogong classification and policy facts. Generate a dry-run
Canonical candidate set with per-record HOLD reasons before proposing any Firestore write.

## 2. Do not restart or recreate the project

This repository already exists and contains the Catalog V1 executable baseline plus
the authenticated read runtime, Data Health, ERP5 read-only capture/mapping analysis,
deployment preparation, shadow comparison and fail-closed cutover gate.

Do **not** create a replacement repository and do **not** redirect this work to `JPK ERP5/jpkerp5`.

Legacy Firebase identifiers may still appear as source/target identifiers. They are identifiers, not the official project name.

## 3. Locked boundaries

- Approved implementation scope: **CATALOG V1 ONLY**
- FreePass Data owns the server-side data-platform boundary, not Sales/Admin/Estimate business workflow meaning.
- Consumer apps must not treat internal Firestore collection paths as their public contract.
- Canonical writes fail closed when revision/authority/persistence validation cannot be performed.
- RTDB: **no new usage**. Existing traces are migration debt only.
- GitHub Actions / deployment automation: **do not add or enable without separate authorization**.
- Production Firebase binding, IAM change, writer cutover, schedule activation, and real-data writes remain separately authorized operations.

## 4. What is already implemented on this branch

The branch baseline includes:

- TypeScript / Node 22 modular monolith
- Catalog JSON Schemas
- VehicleModel / VehicleAsset / Product / Offer / PriceTerm / Policy domain
- memory + Firestore repository adapters
- revision conflict protection
- idempotency receipt
- append-only audit + transactional outbox
- worker lease/retry/dead-letter behavior
- ERP public projection + release activation
- Fastify API baseline
- legacy `freepasserp3` read-only adapter
- conservative legacy normalizer
- source run / RAW / normalized candidate persistence
- guarded legacy product ingestion job
- explicit target Firebase binding requirement
- shadow migration/comparison contract
- default-deny Firestore rules baseline + indexes
- fail-closed public projection for incomplete deposit terms
- tests covering catalog mutation, ingestion, normalizer and shadow behavior

## 5. Highest-value next work

### Consumer read preparation — 2026-09-21

See [Consumer read pilot](CONSUMER-READ-PILOT.md) for the observed ERP/F01/F86
read paths, remaining live-evidence gates, and `npm run pilot:check` offline
three-way comparison. This is local preparation only; no production cutover.
Preserve existing dirty Console/output-contract changes and the separate Admin PR #12.

### P0 — Field Authority Registry ✅

Implemented baseline: `src/domain/authority.ts`, command enforcement, authority evidence in receipt/audit, and regression tests.

Minimum dimensions:

- domain / aggregate / field path
- semantic owner
- allowed command(s)
- allowed writer/service identity class
- approval requirement
- conflict policy
- override policy
- effective-time policy
- source refresh behavior

Do not reduce this to a single `SOURCE_WINS`-style enum.

### P1 — Field-level lineage ✅

Catalog V1 now has RAW → normalized → canonical → projection lineage, exact Release manifests, source-run safety, reviewed canonicalization, queryable Canonical Revision History, and controlled Manual Catalog Source/Command.

Reviewed source-change update for existing canonical bindings is implemented.

Duplicate/out-of-order delivery behavior is implemented.

Writer ownership-transfer enforcement is implemented as a non-production semantic boundary.

Next implementation focus: authenticated service/user identity and IAM enforcement, then the ERP.com shadow/read pilot.

Minimum evidence:

- source_id
- source_record_id
- source revision/digest
- normalizer/mapper version
- canonical entity + revision
- field path
- source value / normalized value / canonical value
- override/correction reference when applicable

### P2 — Acceptance tests

Promote the architecture-v2 review test matrix into executable tests, starting with:

- [x] idempotency key reused with a different payload must conflict — implemented in PR #3
- [ ] stale revision must fail without losing the operator input
- [x] incomplete deposit/price pair must not be published
- [x] partial projection/evidence build must not replace last-known-good ACTIVE release
- [x] current reviewed candidate canonicalization must pin accepted source head
- [x] changed source fingerprint must require explicit re-review
- [x] reviewed source refresh must apply only the exact current diff set
- [x] structural/identity source changes must block partial refresh
- [x] stale review must fail when any pinned Canonical revision changed
- [x] source supplier code must be compared through binding mapping, not Canonical supplierId
- [x] missing critical lineage must block Canonical promotion
- [x] canonical create/change must append a queryable revision snapshot
- [x] direct manual entry must create immutable source evidence before Canonical commit
- [x] manual entry idempotency replay must not duplicate source evidence
- [x] ACTIVE Release must carry exact Canonical input revisions and digests
- [x] projection fields must resolve to source lineage or Canonical Revision History
- [x] source collection failure/incomplete coverage must not be interpreted as mass deletion
- [x] late older source run must not replace the accepted current head
- [x] duplicate / out-of-order event behavior
- [x] old writer blocked after ownership transfer (design + non-production enforcement test)

### P3 — Security/IAM review

Writer ownership transfer semantics are implemented, but runtime writer identity is not yet cryptographically authenticated.

Next:
- authenticate service/user identity
- bind execution writer to verified runtime identity rather than request metadata
- keep Firestore default deny
- define consumer read boundary before any production cutover

### P4 — ERP.com pilot consumer

Only after P0-P3 contracts are stable:

`LEGACY → SHADOW → FREEPASS_DATA_READ`

Do not perform writer cutover in the same step.

## 5. 2026-09-22 AI Core audit — Codex/Work immediate packet

This section is the current cross-project handoff from the AI Core/Data Hub audit.

Audit subject revision observed: `fea18ce15f523d41a9382e7ae79e702a58d3afae`.

### P0-A — Production runtime must fail closed

Current code defaults `FREEPASS_DATA_DRIVER` to `memory` and seeds demo catalog data. This is acceptable for local/test, but production must never silently boot with memory/demo data.

Required:
- introduce an explicit runtime environment/mode;
- production must require an explicit persistent driver;
- production must refuse memory/demo seeding;
- split liveness from readiness;
- readiness must verify target data binding, required ownership/security state and a readable last-known-good ACTIVE release;
- do not report production-ready merely because the HTTP process is alive.

Primary files:
- `src/bootstrap.ts`
- `src/api/server.ts`
- `.env.example`

### P0-B — Separate the serving plane from projection building

Current API startup calls `buildErpPublicProjection(...)`. This couples the read-serving process to a fresh projection build.

Target:
`Canonical -> Builder/Worker -> validated Release -> ACTIVE pointer -> Read API -> Consumer`

Required:
- remove mandatory projection rebuild from API startup;
- API read path must serve the last-known-good ACTIVE release;
- builder/worker owns projection/release creation;
- a failed new build must not make an already valid ACTIVE release unavailable;
- add regression coverage proving read availability survives a failed new projection build.

Primary files:
- `src/api/server.ts`
- `src/application/catalog.ts`
- `src/worker.ts`

### P0-C — Harden Catalog writer ownership

Writer ownership transfer is implemented, but absent stored ownership currently resolves to the implicit `SHARED_MIGRATION` compatibility state.

Required:
- keep implicit shared migration only for explicitly declared non-production migration mode;
- after production cutover, missing/corrupt ownership state must block Canonical writes;
- runtime writer identity must eventually come from verified auth/IAM, not request semantics;
- ownership recovery/restore behavior must be testable.

Primary files:
- `src/domain/writer-ownership.ts`
- `src/application/writer-ownership.ts`
- Firestore ownership persistence/tests.

### P0-D — Enforce exact Firebase target binding

`FIREBASE_PROJECT_ID` has no default, which is directionally correct, but the runtime must positively verify the expected target before production activation.

Required:
- require explicit target project ID in persistent mode;
- fail readiness on missing/unknown target;
- bind service identity/environment/project evidence into readiness;
- no production writer activation from a loosely inherited Application Default Credential context.

### P0-E — Fix F01/F03 authority drift before consumer cutover

Live sheet observation on 2026-09-22:

F01:
- title: `[F01 사용중] 프리패스 상품리스트`
- visible current tabs included `상품리스트 09.21 18:13 · 385대`, `손오공상품 · 58대`, `픽업구독 · 221대`, `오플구독 · 54대`.
- hidden `이 시트는` content still describes the old flow where the sales sheet/product master effectively feed ERP as operational truth.

F03:
- title: `[F03 사용중] 차종마스터 신규`
- `SSOT 운영기준` correctly says FreePass Data VehicleModel/VehicleAsset is Canonical SSOT and F03 is reviewed source/reference only.

This is an authority-description conflict.

Required:
- F01 must be classified as projection/operational view, not Canonical authority;
- F03 remains reviewed source/reference;
- update the generator/source that writes F01's `이 시트는` text rather than hand-editing the generated tab;
- do not let sheet display labels become machine identity.

Cross-repo source:
- `freepass-creator/freepasserp4/lib/domain/sheet-identity.ts`
- `freepass-creator/freepasserp4/scripts/publish-sheet-identity-tab.mts`

### P0-F — Fix machine key vs display-label coupling

Current `freepasserp4/lib/domain/sales-published-tabs.ts` expects prefixes:
- 상품리스트
- 손오공구독
- 픽업구독
- 오플구독

Live F01 currently exposes `손오공상품 · 58대`.

Because the selector uses prefix matching, code paths using that contract can omit the live Sonogong tab.

Required:
- define a stable machine key (for example `subscription_sonogong`) independent from the visible tab title;
- keep human labels free to change without changing identity;
- add compatibility mapping for current/legacy labels;
- add tests with the live current labels before changing production sheet generation;
- do not rename live tabs as the first fix unless parity impact is measured.

### P1 — Refresh AI Core / DevCenter observation evidence

DevCenter Data Hub evidence currently pins an older FreePass Data revision (`bd75b604...`). The audited FreePass Data head is five commits ahead and includes reviewed source changes, projection delivery idempotency and writer ownership hardening.

Required after P0 code changes:
- regenerate/re-evaluate Data Hub revision-bound receipt on the exact new head;
- refresh consumer/recovery evidence without hiding remaining IAM/backup HOLDs;
- register/update the FreePass Data Project Capsule so AI Core can resolve repository, SSOT, commands, deployment boundaries and blockers without rediscovery.

### Required execution discipline

- Do not perform production Firebase writer cutover, live sheet mutation, IAM change, deploy automation activation or RTDB reintroduction as part of this packet.
- Work in the owning repository for each concern. Do not copy project SSOT into AI Core.
- Make the smallest isolated changes and preserve exact revision evidence.
- Run repository checks/tests after each isolated change.
- Leave exact commit/test/result/remaining-HOLD evidence in this handoff and GitHub issue #24.

### Suggested implementation order

1. P0-A runtime fail-closed.
2. P0-B serving/build separation.
3. P0-C/P0-D ownership + binding hardening.
4. Cross-repo F01 authority/identity correction with tests.
5. Exact-head Data Hub receipt refresh.
6. Only after those pass: ERP.com shadow-read parity pilot.

## 6. Coordination rule

## 6. Coordination rule

### Local working copy — 2026-09-21

The integrated work is on `codex/local-runtime-baseline` in `C:\dev\freepass-data`. Resolve and record the
current HEAD at the start of every continuation; the baseline above is provenance, not a floating latest pointer.
See [Local development](LOCAL-DEVELOPMENT.md) for Windows setup, validation,
and the separate API/worker memory-store limitation. These branch changes are not a production rollout.
Before relying on any numbered PR mentioned in older sections, re-read its current state and head revision.

Before each new change:

1. read `docs/IMPLEMENTATION-STATUS.md`
2. read this file
3. verify current `main` revision
4. check open PRs/branches for overlapping work
5. make the smallest isolated change
6. leave an updated next-start-here note when the work packet ends

### 운영 사고 메모

- [2026-09-21 손오공 픽업구독 축소와 거짓 합격 방지](INCIDENT-2026-09-21-STALE-UPSTREAM-FALSE-PASS.md): 하류 `원자 → F01 → F86` 일치만으로 원천 정합성을 합격 처리하지 않는다. 현재 원천 관찰부터 차량번호·상태를 양방향 대조한다.

This file exists so another session can continue without re-discovering or re-creating the project.
# 2026-09-28 Iancar policy/source recovery

- Source SSOT: `이안카_프리패스` tabs `이안카`, `이안카 재렌트`; 119 unique plates.
- F54 backup: Drive file `1LwgzNLWI9hENYeJ5q7TTQ5wkyyFDVpowUJO0fTFpiNk`.
- F54 policy split: `RP031_S01..S04` = 5/10/15/25만원; matched inventory counts 62/35/18/4.
- Firestore apply run: `2026-09-27T16-37-05-835Z-766258c0-376b-4225-9691-f87303bb953e`; local private rollback evidence retained.
- Publication preparation/apply: GitHub Actions runs `36333911144` / `36333983363`.
- Readback: F01 `09.28 01:38 상품리스트 441대`, F86 `이안카 223대`; exact 119 source plates checked, policy-field errors 0.
- HOLD: six historical Iancar rows outside the 119-row current source remain source-absent and were not guessed or rewritten.
- `next_start_here`: merge or supersede the scoped ERP4 publisher branches only after reviewing `e6727ff0` and the production pin strategy; do not restore the old policy-field omission.
# 2026-09-28 기간별 상품 경제조건 — 청구·지급 수수료 / 보증금 산식

- 목적: 상품 Offer의 각 `termKey`마다 기간별 보증금 산식, 공급사 청구 수수료, 영업채널 지급 수수료를 명확히 보존한다.
- 대상: `work/freepass-data/period-economics-20260928`, latest `origin/main` 위로 rebase.
- 경계: Data는 계약 전 상품 기준표와 근거를 소유한다. 계약별 예외·확정액·VAT·인센티브·환수·청구/수금/지급 사건은 기존 Admin/정산 원장이 계속 소유한다.
- 변경: `Offer.internalEconomicsTerms`에 기간별 `depositCalculation`, `supplierBillingFee`, `channelPayoutFee`를 추가했다. Catalog Health의 `OFFER_ECONOMICS_COMPLETENESS`가 기간 누락·미확정·산식 불일치를 `BLOCKED`로 처리한다. 금액 상태, 계산식, 원천 참조를 분리하며 공개 ERP/화이트라벨 projection에는 노출하지 않는다.
- 검증: `npm run build` PASS, `npm test` 944 PASS / 12 SKIP, Sheets 24 PASS, read-runtime 5 PASS, shadow 10 PASS, dashboard 21 PASS, 내부 수수료 공개 비노출 회귀검사 PASS.
- 남음: 현재 기준 HEAD의 기존 `src/jobs/apply-iancar-policy-sync.ts` Firestore 직접 접근 때문에 `npm run check` 전체 묶음은 `check:data-access-boundary`에서 HOLD. 실제 상품 수수료 원천을 구조화하여 채우는 운영 write는 수행하지 않았다. Claude 독립 검토는 응답 없이 장시간 대기되어 UNAVAILABLE로 기록한다.
- next_start_here: `src/domain/catalog.ts`의 `OfferTermEconomics` → `src/application/resolve-offer-commercial-terms.ts`의 `auditOfferEconomicsTerms()` → `tests/offer-commercial-terms.test.ts`.

## 2026-09-28 청구·지급·예상수익 직접 결정 반영

- 목적: 공급사에서 받을 기준 수수료와 영업채널에 줄 기준 수수료를 같은 `termKey`에서 별도로 계산하고, 공급가액 기준 예상수익을 `청구 - 지급`으로 제시한다.
- 대상: `work/freepass-data/commission-margin-20260928`, base `34129457349f073306e081a1e7acd98ef31782c3`.
- 사용자 결정: 청구와 지급은 같은 상품·기간 기준을 사용하지만 서로 다른 금액/비율이다. 오플구독은 기간과 무관하게 공급사 청구 1,000,000원, 영업채널 지급 800,000원이다.
- 정본 수정: F80-F85 지급표가 아니라 ERP4 `lib/domain/settlement-fee-table.ts`가 코드 정본이고, F04 정산원장 `수수료표!A1:J180`은 그 사본이다. 정책 provenance를 이 구조로 교정했다.
- 변경: Kakao REFERENCE_ONLY 기간행에 `supplierBillingFee`, `channelPayoutFee`, `expectedGrossMargin`을 추가했다. 기존 `salesCommission`은 호환 alias로 유지한다. 표준 재렌트 12/24/36/48/60개월, 오토플러스, 스위치플랜, 아이카 정액 예외를 양쪽 계산하며 공급가액 기준 예상수익은 `청구 - 지급`이다. 손오공 구독·스타·아이카 1개월·퍼시픽처럼 정본이 사람 판단으로 표시한 규칙은 금액을 발명하지 않고 `COORDINATION_REQUIRED`로 둔다. 분납/일시납 시점 규칙도 정책 스냅샷에 포함한다.
- 검증: `npm run check` 전체 PASS — Vitest 971 PASS / 12 SKIP, Sheets 24 PASS, read-runtime 5 PASS, shadow 10 PASS, dashboard 21 PASS. 이후 F04 실조회 `수수료표!A3:J152` 150개 규칙을 다시 검산해 자동산출 122행·사람판단 28행·수치 불일치 0건을 확인했다. 모든 표준 공급사 코드×12/24/36/48/60개월 양쪽 금액과 오플·스위치·아이카 예외를 회귀검사한다.
- 남음: 신차 선출고는 차량가액과 선출고/매칭 구분이 입력에 있어야 자동계산할 수 있다. `RP034 마음카`는 F04 코드 정본에 규칙 행이 없으므로 통화 여부와 별개로 금액을 추정하지 않는다. Claude 독립 검토는 호출했으나 응답 없이 대기되어 `UNAVAILABLE`이며 PASS로 세지 않았다. Canonical write·ACTIVE release·운영 배포는 수행하지 않았다.
- next_start_here: F04 정본에 마음카 규칙이 추가되면 공급사 코드 `RP034` 회귀검사와 함께 반영 → 실제 상품 `Offer.internalEconomicsTerms` 적재 dry-run → 정산 소비자 대조.

### 2026-09-28 main 병합·운영 조회 활성화

- main/배포 revision: `20e83e2d5d1ec3b101bfa64388cb5b7a6ebc55a5`; Cloud Run `freepass-data-read-00013-cvq`.
- 운영 등록: Secret Manager `freepass-data-consumers` version 3에 기존 11개 등록을 보존하고 `kakao-ops`를 고유 token으로 추가했다. 권한은 `catalog-reference`, `settlement-ledger-read` 두 개뿐이다.
- 운영 readback: 인증된 `GET /v1/consumers/kakao-ops/catalog-reference` HTTP 200, schema `freepass-data.kakao-catalog-reference/v1`, projected 745, `REFERENCE_ONLY/HOLD`, commission digest 존재.
- 정산 readback: 인증된 `POST /v1/consumers/kakao-ops/settlement-ledger/read`에 존재하지 않는 exact code를 조회해 HTTP 200, schema `freepass-data.settlement-ledger/v1`, count 0, authority `FREEPASS_DATA_SETTLEMENT`, digest 존재를 확인했다.
- Google Sheet: F04는 게시 사본이며 이번 작업에서 셀을 수정하지 않았다. `수수료표!A3:J152` 150행을 읽기 전용 재조회하여 자동 122행·사람판단 28행·수치 불일치 0건을 확인했다.
- 배포 증거: GitHub Actions run `36369156521` PASS. 미인증 요청 403, 기본 ERP 인증 readback 200.
- next_start_here: Kakao Ops 운영 PC에는 Secret Manager의 token을 안전한 로컬 자격증명 경로로 주입하고, 응답의 `REFERENCE_ONLY/HOLD`를 유지한 채 기존 자체 수수료 계산을 제거한다.

# 2026-09-28 정산원장 소비자 읽기 계약

- 목적: FreePass Data 정산원장을 Admin, Kakao Ops와 명시적으로 등록된 소비자가 동일한 계약으로 안전하게 조회한다.
- 대상: `work/freepass-data/settlement-ledger-sync`, base `cc4c8e6`.
- 변경: `freepass-data.settlement-ledger/v1` 계약과 인증·감사된 `POST /v1/consumers/:consumerId/settlement-ledger/read`를 추가했다. `settlement-ledger-read` capability는 Admin workflow write 권한과 분리된다.
- 검색: 차량번호/정산코드/접수일/청구월 등 exact filter, 또는 `영업자+고객명` 동시 filter. 무필터/사람 단독 검색/100건 초과는 fail-closed다.
- 경계: 정산 사실의 기준은 `FREEPASS_DATA_SETTLEMENT`다. Admin은 승인된 업무 command를 수행하는 애플리케이션이며 별도 정본이 아니다. 소비 앱은 `settlement_rows`를 재계산하거나 두 번째 원장으로 복제하지 않는다. 미입력은 `null`이다.
- 검증: 최신 `origin/main` 병합 후 `npm run check` 전체 PASS. Vitest 962 PASS / 12 SKIP, Sheets 24 PASS, read-runtime 5 PASS, shadow 10 PASS, dashboard 21 PASS. Claude 독립 검토는 두 차례 응답 없이 대기되어 UNAVAILABLE로 기록한다. 운영 토큰 등록·배포·Kakao Ops 실제 호출은 다음 검증 단계다.
- next_start_here: `src/domain/settlement-ledger-view.ts` → `src/application/settlement-ledger-view.ts` → `src/api/consumer-gateway.ts` → `tests/settlement-ledger-view.test.ts`.
# 2026-09-30 공급사 재고 관리 기준

- 목적/변경: 사용자 지시로 직원의 공급사별 차량번호 기반 일일 관리 업무와 시스템 자동 대사·영구 등록대기 요구사항을 `docs/BUSINESS-DATA-CONNECTION-MAP.md`의 「공급사 차량 재고 정합성 관리」에 반영했다.
- 대상: 현재 origin/main 기반의 문서 변경. 기존 작업 폴더의 미커밋 문서는 보존했다.
- 검증: 관리 항목 6개, 0대/소규모 포함, 기본연령/하향 분리, 예외 담당자·기한, 원천 성공 시각과 수정 시각 분리, 승인 및 재조회 경계를 확인한다.
- 남음: 자동 관리 기능 구현·운영 데이터 수정·배포는 이번 문서 저장에 포함되지 않는다.
- next_start_here: 운영 pin `e6727ff04fcf98380701fa6360c36f313e0e321f`의 `scripts/ingest-supplier-to-firestore.mts` 임시 `tmp/등록대기.json` 경로와 `scripts/ingest-all-suppliers.mts`의 하위 로그 축약부터 검토하여 기존 SourceIngestionStore/원천 영수증 경계에 연결한다. 세 번째 저장 경로를 만들지 않는다.

## 2026-10-02 Iancar API photo deployment and publication

- Purpose: supplier API photo references -> canonical RP031 products -> ERP/white-label galleries and existing F01/F86 plate hyperlinks, without a new inventory/photo writer.
- Data code/runtime: `620c10f62874947ee012482cd8ef5c1b576b1c78`; deployment run `36952993173` SUCCESS, Cloud Run `freepass-data-read-00015-649`, private IAM preserved. Supplier secret is pinned server-side only. ERP deployed `10786a9`; final CI-only fixes continue on main (`53e1d90a57631bd0b67d9e9e44f42af3f807bfa6`).
- Publisher engine: immutable tag `iancar-photo-engine-20261002`, exact revision `fe3eccc0173cb581e71a5a963bb7f28d3715b14f`. The existing ERP5 workflow owns Sheet publication; schedule remains hourly, not a verified 15-minute inventory cutover.
- Source evidence: public products 109; fresh API photo capture `photos-f896cfbe-9c88-44db-b642-52d62ebdc8ac` observed 2026-10-02 01:55:39Z..01:58:32Z. 102 successful details: 50 nonempty lists / 2,249 photos, 52 empty lists; seven HTTP404 are unresolved, not zero/deletion. Earlier 52-car / 2,348-photo observations are superseded, not a fixed fleet count.
- Actual photo-only atom apply/readback: run `3a40956e-d168-41f8-b6b8-6dfbd068657d`, digest `b9567c2610101472e6ec8990f28d7866087ddbde3b1ead6ab3a391dac6ba549f`, 102 rows, inventory/price changes and deletes all zero. Typed originals and rollback evidence remain private. Empty lists preserve original photos; positive-to-zero restores owned originals rather than dead proxy slots.
- Actual rollback drill: one product / 50 photos, run `2fd462a4-b23b-4cfa-83cd-9c820494aab4`; typed backup, apply readback, restore plan and restore readback all verified before the full batch.
- Verification: Data build, architecture/access boundaries, 1,144 passing / 14 skipped tests; ERP typecheck/build and 102 public-contract cases passed. Independent Claude source review returned GO after correcting positive-to-zero and photo-only rollback drift. The later narrow Core-pin follow-up timed out and is not counted as a pass.
- Production readback: authenticated supplier-backed manifest for `10하8128` returns 50; actual ERP white-label gallery shows 1/50 -> 2/50 and loaded images. All 50 nonempty products' first images eventually returned valid metadata-stripped JPEG; three initial 503s succeeded on bounded sequential recheck. This is representative-byte verification, not all 2,249 bytes or visual plate verification.
- Source caveat: first photo of `10하8128` visually shows a different plate; next photo shows current `10하8128`. Possible prior registration/photo history is not a proven wrong-vehicle conclusion. Supplier owns photo ordering/association; no silent photo substitution or OCR identity claim.
- Completed publication: canonical prepare `36953691942` SUCCESS; frozen snapshot `20261002021154956-c3085e59dae2`, captured `2026-10-02T02:11:54.956Z`, verified 109 public RP031 products / 50 proxy galleries / 2,249 URLs before apply. Exact ready-run ALL apply `36954572369` SUCCESS, including full atom/F01/F86 parity and plate-photo-link audits.
- Native Sheets readback: F01/F86 leading title `10.02 11:11 상품리스트 316대`, F86 supplier `이안카 109대`. All 50 expected RP031 photo links matched separately in F01 leading C, F86 leading C and F86 supplier D (150/150, zero discrepancies). Example `10하8128`: F01 C177, F86 C169, supplier D68 -> `https://freepasserp.com/q/4ab2zndgcx`; exact supplier cell was re-read after browser inspection, unchanged. Real native F86 screen and the short-link product gallery were verified.
- Final ERP revision: `53e1d90a57631bd0b67d9e9e44f42af3f807bfa6`, Vercel status SUCCESS and production `/api/version` sha `53e1d90`; CI `36954202676` SUCCESS. Exact engine/Core receipt alignment guard passed; existing offline server-only shim is now used by the whitelabel regression runner, without changing application auth/runtime isolation.
- Remaining: seven source404 records and 52 empty API photo lists are not supplier website-absence proof; existing originals/identity/inventory/rates are retained. Representative old-plate photo requires supplier clarification. Admin receives absolute canonical photo URLs, but its rendered UI is not verified. No claim of all 109 vehicles having supplier photos or of a new 15-minute inventory/photo-metadata writer.
- next_start_here: use private typed backup run `3a40956e-d168-41f8-b6b8-6dfbd068657d` for audited photo-only rollback if needed; seek supplier clarification for unresolved IDs/representative history, then repeat fresh photo evidence -> expected-plan apply -> exact-ready canonical publication. Preserve unrelated dirty worktrees and all unresolved source rows.

### 2026-10-02 행 간격 교정
자동 행 높이가 긴 정책 때문에 과도해져 CLIP(자르기) + 21px 고정으로 복원한다. 원문과 정책값은 그대로 보존한다. 긴 내용은 셀 선택 후 수식 입력줄에서 확인한다. 최신 규격이 이전 WRAP/AUTO_FIT 지시를 대체한다.

### 2026-10-02 긴 원문 좌측 정렬
옵션·점검사항·세부 차명·사진링크·정책 설명 15열은 본문 좌측 정렬. 헤더 가운데, 숫자 오른쪽, CLIP과 21px 간격 유지. 원문 값 변경 없음.

### 2026-10-02 차량번호 사진 링크 복원
- 사진링크·정책코드 열은 삭제하지 않고 숨긴다. 공급사 원본과 대조한 110개 사진 연결을 차량번호에 복원. 공급사 원문 값 변경0, 종합210행 유지. 기존 사진 열 없는 공급사는 사진 열을 삽입하고 기존 차량번호 수식의 사진 주소3개를 보존했다.
- FILTER/HSTACK은 링크 메타데이터를 없애므로 종합은 A:G와 I:BV를 동일한 원문 projection의 CHOOSECOLS로 분리하고 H열의 직접 HYPERLINK 배열을 사용한다. BV 사진용 차량번호는 숨김 보조 열이며 종합 schema74열. 사진 없는 번호에는 링크를 만들지 않는다. 원본 번호와 사진 URI의 행별 일치, 전체 오류0, 빈 supplier를 검증한다. 최초 사진 열 추가는 명시적 migration 뒤 fresh metadata/header를 다시 읽는다.
- 실행기는 공급사 번호 문자열을 수식으로 바꾸지 않고 textFormat.link만 적용한다. 기존 번호 수식/리치텍스트는 보존, URL 충돌은 HOLD. 새 차량번호에 원문 링크를 붙여넣는 입력은 가능하지만 신규 사진 URL의 별도 자동 수집/writer는 미연결이다.
- Claude ANSWERED/exit0: 분리 배열 행 정합성과 hyperlink readback을 핵심 검사로 반영. 별도 전체 staging 탭 제안은 두 배열이 동일한 식을 공유하고 실측 row/link parity를 검증하므로 추가하지 않았다. 넓은 첫 검토의 REVIEW_TIMEOUT은 PASS로 계산하지 않았다.

### 2026-10-02 옵션 열 너비 축소
사용자 요청으로 입력시트 옵션 열을 857px에서 240px로 축소한다. 전체 종합·공급사 탭에 적용하며 CLIP, 좌측 정렬, 21px 행 높이, 원문값은 유지한다. 운영 F01/F86 너비는 바꾸지 않는다.

### 2026-10-02 회사명 표시 규칙
사용자 직접 지시로 입력된 행의 회사명은 탭 약칭 그대로 채운다. 회사명 이외 필드의 effective 값으로 입력 유무를 판정하고 0/false는 값으로, 빈 수식 결과는 미입력으로 본다. 빈 행과 회사명만 있는 행은 건드리지 않는다. 기존 공급사코드/법인 master의 권위는 바뀌지 않는다. 실행 전 동시 편집 재조회 대조, 210행 회사명 채움, 종합210행 및 회사명-탭명 불일치0, 나머지 원문 변경0, 사진 링크 변경0, 재계획 회사명 추가 수정0 확인. Claude ANSWERED/exit0의 빈 행·필드 마스크·동시 편집·재실행 검사를 반영했다. 새로 추가한 차량은 동일 실행기로 재계획할 때 회사명도 갱신하며 신규 자동 writer는 미연결이다.

### 2026-10-02 하허호식 정책 값 표시
- 하허호 원본 시트의 보험 표시를 직접 대조한 뒤 COMPACT_VALUES_PRESERVE_UNITS로 통일했다. 반복 항목명/콜론/줄바꿈을 빼고 원문 금액·비율·조건을 짧게 표시한다. 자차는 보상한도 / 수리비 비율 / 최소~최대 면책금, 개인/법인 범위와 한쪽만 있는 최소·최대는 짧은 의미 표기를 유지한다. 같은 화폐 단위만 범위 끝에 한 번 붙이고 금액 계산·환산은 하지 않는다. 전체 원천72항목 archive는 그대로 보존한다.
- 기존 이관값 변경은 rewriteImportedPolicyPresentation.runId를 명시하고 이전 셀 note의 원천 탭·행·코드 및 기존 verbose값이 fresh 원천과 정확히 맞을 때만 허용한다. 소유권/값 불일치는 HOLD. 새 값과 기존 note 및 전체 원문 설명을 atomic userEnteredValue,note mask로 쓴다.
- 공급사 원본16개를 metadata의 전체 행 범위로 재조회, source/destination 동시 변경 없음 확인 후173행의 설명 칸1207개를 교정했다. 표시 불일치0, 원문 설명 note 누락0, 나머지 값 변경0, 사진 링크 변경0, 종합210행/오류0, 재계획 추가 쓰기0. 기존 정책코드 없음33행은 그대로 HOLD.
- Claude ANSWERED/exit0: 비율 기준·최소최대·0/없음 구분·원문 보존·소유권 guard를 반영했다. 전체 항목명을 화면에 남기자는 의미 보존 문제는 사용자의 짧은 표시 지시에 맞춰 필요한 수리비/개인·법인/최소·최대만 유지하고 세부는 note와 archive에 보존했다. 단위/범위/소유권/재실행을 포함한 Sheets 테스트45개와 build 통과.
