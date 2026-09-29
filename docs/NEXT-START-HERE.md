# FreePass Data — NEXT START HERE

## 2026-09-30 Estimate writer permanent synthetic canary

- 목적: 전용 Estimate writer를 ON으로 전환할 때 Quote v2와 Share Envelope의 실제 저장·멱등 재시도·재조회를 한 배포 영수증에서 증명한다.
- 대상 revision: `origin/main@5e1be5f3244be6472ce3693fef100c960c227be6`, branch `work/freepass-data/estimate-writer-canary`.
- 변경: ON 배포에 실행별 고유 synthetic canary를 추가했다. 두 불변 자산 모두 `CREATED → EXISTING`, 동일 `persistedAt`, 동일 snapshot hash readback을 만족해야 배포가 통과한다. 토큰과 전체 payload는 출력하지 않는다.
- 재사용 판정: 기존 Estimate cutover probe는 ACTIVE master에 의존해 writer 저장 경계를 독립 검증할 수 없다. Canonical artifact 계약·digest는 재사용하고 writer-only probe만 `CREATE_NEW_JUSTIFIED`로 추가했다.
- 검증: 전용 테스트, 전체 check, Claude 독립 검토, PR CI 후 main 병합 및 운영 `write_mode=on` 실행 영수증을 확인한다.
- 남음: ACTIVE Estimate master release 부재와 실제 agent/admin Firebase 인증은 별도 HOLD이며, synthetic persistence PASS로 소비자 전체 cutover를 선언하지 않는다.
- next_start_here: main exact revision의 ON workflow에서 영구 synthetic 증거를 생성하고 Quote/Envelope ID·hash·persistedAt을 재확인한다.

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
