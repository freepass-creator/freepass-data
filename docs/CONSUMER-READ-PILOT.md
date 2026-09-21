# 프리패스 데이터 읽기 연결 준비

상태: **로컬 준비 / 운영 연결 HOLD**. 확인일: 2026-09-21.
사용자 요청: ERP·시트가 프리패스 데이터를 참조하도록 전환 준비.
이번 범위: 경로 조사, 오프라인 3자 비교 검사, 전환 순서. 배포·IAM·원천/시트 쓰기·예약 변경 없음.

## 확인한 기준과 실제 코드 경로

- FreePass Data: `C:\dev\freepass-data`, `codex/local-runtime-baseline`.
  시작 HEAD `89efed2`; 조회한 원격 main `fea18ce15f523d41a9382e7ae79e702a58d3afae`.
  작업 중 다른 작업에 의해 HEAD `8aaa861`로 전진한 것을 관측했다. 기존 미커밋 변경을 보존했고 이 준비 도구는 별도 신규 파일로 작성했다.
- ERP: `C:\dev\freepasserp4`, 관측 HEAD `31c4504b8712dcbd6ec56673a76156bc227b5d65`, 관측 시 clean.
  아래 내용은 이 로컬 코드의 증거다. 배포 revision·실제 환경변수·실행 회차는 재검증 전 UNKNOWN.
- 열린 PR #12의 Admin projection 구현과 겹치지 않도록 기존 API/Projection/Console 구현은 변경하지 않았다.

| 대상 | 현재 로컬 코드 경로 | 연결 준비의 빈틈 |
|---|---|---|
| ERP.com 상품 | ERP repo `app/api/products/route.ts` → `lib/server/whitelabel-erp5-catalog.ts` → ERP5 Firestore `products`, `policy` | FreePass Data 클라이언트·필드 매핑·shadow 연결 없음 |
| ERP 상품 시트/내부/재고 | `app/api/products/sheet/route.ts`, `app/api/shop/inside/route.ts`, `app/api/ops/inventory/route.ts`가 같은 ERP5 reader 사용 | 대표 경로 하나만 바꾸고 전체 전환이라 할 수 없음 |
| F01 | `.github/workflows/erp5-ssot-refresh.yml` → `capture-sales-publish-snapshot.mts --erp5` → `make-sample-sheet-google.mts --main` | 현재 ERP5 스냅샷 소비, FreePass Data Release 소비 아님 |
| F86 | 같은 workflow → `build-channel-supplier-sheet.mts --채널=하허호 --apply --snapshot=...` | Release 연계와 실제 소비 readback 필요 |
| 시트 엔진 | 위 workflow checkout `cf940df642edf315adbc6da2b4134fbad53da160`, concurrency `erp5-inventory-publish` | 로컬 최신 코드와 별도 pin. 기존 writer와 잠금을 유지한 연결 설계 필요 |
| FreePass Data 입력 | `src/adapters/legacy-freepasserp3.ts` | sourceId가 `freepasserp3/firestore/products`로 고정. 현재 ERP5 입력 매핑을 검증하지 않고 환경변수만 바꿔 쓰면 출처가 틀려짐 |
| FreePass Data 출력 | `src/api/server.ts`의 `/v1/views/erp-public/products` | Release metadata는 있으나 source head/전체 source coverage와 consumer receipt API가 없음 |

`npm run dev`는 메모리 데모다. Firestore API 서버도 시작하면서 projection을 생성하므로
운영 자격증명을 넣고 서버를 실행하는 행위를 읽기 전용 조사로 취급하지 않는다.
가격 쓰기 경로의 인증/IAM 미완료 상태를 해결하기 전 서버를 외부에 공개하지 않는다.

## 이번에 만든 실행 가능한 준비 도구

```powershell
npm run pilot:check -- C:\private\read-pilot-evidence.json
```

구현: `src/migration/read-pilot.ts`, CLI: `src/jobs/check-read-pilot.ts`.
입력 타입: `ReadPilotInput`; 합성 입력 구조 예시는 `tests/read-pilot.test.ts`의 `fixture()`.
실제 입력은 비공개 로컬 경로에 보관하고 Git에 넣지 않는다.
기존 `compareShadow`는 변경하지 않았다. 기존 comparator의 MATCH를 이 준비 도구의 검사 결과로 대체 해석하면 안 된다.

입력은 하나의 consumer·동일 source revision·동일 scope에 대한 다음 **독립적인 세 관측**이다.

1. `upstream`: 최신 원천의 전체 비교 행 및 원천 관측 증거.
2. `legacy`: 현재 사용처가 실제 소비한 결과를 동일 비교 단위로 펼친 전체 행.
3. `freepass`: FreePass Data Release를 동일 비교 단위로 펼친 전체 행 및 Release metadata.

각 관측은 sourceId/sourceRevision/scope/observedAt/complete/evidenceRef,
mapperVersion/expectedRowCount/rows를 제공한다. expectedRowCount는 배열 길이를 복사해
만들지 말고 독립적인 전체 수집/페이지 종료 증거에서 얻는다. upstream을 하류 사본으로 만들면 검증이 아니다.
각 원천별 최신화 정책의 `maxAgeMs`를 명시하며 편의상 유효기간을 늘려 통과시키지 않는다.
여러 source가 있으면 원천별로 독립 검사하고 필수 원천 하나라도 HOLD이면 전체 HOLD다.

행 단위는 productId + offerId + termKey다. 차량·공급사 식별, 계약기간, 상품구분,
상태·노출 여부, 월요금, KRW, 보증금 상태/금액, 연간 주행거리를 전부 비교한다.
termKey는 반납/인수 등 서로 다른 요금 조건을 보존해야 한다. vehicleId의 모델/실차
식별 매핑은 검토로 고정한다. 새 ID를 임의 발급하거나 차량번호를 외부 프롬프트에 넣지 않는다.
행 순서 차이는 허용하지만 중복 키, 공백을 붙인 ID, 알 수 없는 필수값, 누락·추가 행은 허용하지 않는다.
대여료·보증금·주행거리의 null을 0으로 바꾸지 않는다. 무제한 주행처럼 이 v1이 표현하지
못하는 조건은 HOLD 후 계약을 확장한다. KNOWN 보증금은 양수, ZERO는 0, NOT_APPLICABLE은 null이다.

출력:

- exit 0 / `SNAPSHOT_MATCH`: 제출된 세 관측의 비교 범위만 일치.
- exit 1 / `MISMATCH`: 원천 대비 각 사용처의 누락·추가·필드 차이.
- exit 2 / `HOLD`: 불완전/오래된/미래 관측, revision/scope 불일치, 중복, 증거/필수값 누락 또는 입력 오류.
- 모든 결과에 `cutoverAuthorized: false`. 출력에는 원문 값 대신 키 해시와 달라진 필드명을 기록한다.

**이 도구는 증거 수집기·서명 검증기·운영 승인기가 아니다.** 제출된 evidenceRef의 원본을
열거나 Release dataDigest를 원문 응답과 대조하지 않는다. freshness/revision/complete는
제출된 주장이다. evidenceDigest는 입력 JSON의 직렬화 해시이며 원문 증거의 진위를 보증하지 않는다.
필드 매핑이 조건을 빠뜨렸거나 source scope 자체가 잘못되면 이 검사만으로 찾을 수 없다.
승인된 수동 정정 때문에 원천과 다른 값도 자동 면제하지 않으며, 정정 명령/lineage를 별도 검토한다.
정책·옵션·보험·수식·서식 등 이 비교 계약 밖 의미는 별도 대조해야 한다.

## 다음 작업 순서와 해제 조건

| 순서 | 작업 | 완료 증거 / 현재 상태 |
|---|---|---|
| 1 | 실제 배포 ERP revision, source 프로젝트, reader 설정, 운영 workflow pin/최근 실행 확정 | 현재 로컬 코드만 확인: 운영 UNKNOWN |
| 2 | ERP5 및 최신 공급사 원천 읽기 전용 수집기, 정확한 ID/기간/상태 매퍼 준비 | 원문·전체 수집 증거와 독립 검토 필요: HOLD |
| 3 | FreePass Data 저장 프로젝트·권한·실행 주체 확정, read-only 공개 경계와 쓰기 인증 분리 | IAM/배포는 대상과 범위를 확정한 별도 승인 필요: HOLD |
| 4 | 실데이터 RAW → Candidate → 검토된 Canonical → ACTIVE Release 생성 | 원천/정정 lineage, full coverage, source revision, digest 원문 대조 필요: HOLD |
| 5 | ERP 기존 결과 유지 상태에서 server-side shadow 읽기 | timeout/오류는 사용자 경로에 영향 없이 HOLD, 기존 출력과 매핑 비교 및 실제 UI 검증 필요 |
| 6 | F01/F86을 동일 승인 Release에 연결하는 기존 writer 변경안 | 기존 pin/잠금/쓰기 게이트 유지, 원본 백업·새 readback·화면 검증·consumer receipt 필요 |
| 7 | 사용처 하나씩 읽기 전환 | 독립 검토·실행 증거·마지막 정상 Release/복구 검증·직전 사용자 승인 필요 |

새 예약/이중 writer를 만들지 않는다. 원본 시트는 downstream 출력으로 재생성하되
사용자가 관리하는 원천/정제 시트는 보존한다. RTDB fallback은 영구 금지다.
읽기 전환과 쓰기 주체 전환은 별개다. Admin/Sales/Estimate의 추가 경로 전수 확인은 이 ERP·F01·F86 첫 준비 범위 밖이며 연결 완료라고 표시하지 않는다.

## 검증과 독립 검토

- 최종 `npm run check`: architecture 검사, TypeScript build, Vitest 98건(새 pilot 40건 포함),
  Sheets Node 테스트 20건 통과. 이번 변경의 `git diff --check` 통과. ERP 저장소는 변경하지 않았다.
- 로컬 회귀: 3자 일치, 두 하류의 동일 오답, 양쪽 동일 누락, 기간 누락/추가, 중복/빈 결과,
  최신성·revision·scope, 보증금 모순, 미확인 주행거리, 필드 차이, CLI exit 및 Firestore 미기동.
- Cursor 읽기 전용 설계 검토: 원천과의 3자 비교/전체 범위/중복/UNKNOWN 차단에 동의.
  동일 오답과 비노출 행 누락 반례를 검사에 반영했다.
  ID 자동 정규화·차량/공급사를 모두 키에 넣자는 제안은 반영하지 않았다. 원본 ID를 변경하지 않고,
  같은 offer의 잘못된 차량/공급사는 별도 정상 키가 아닌 값 불일치로 잡는 것이 이 계약에 맞다.
- Cursor 코드 검토: 배열의 문자열 강제변환으로 enum 검사를 우회하는 결함을 찾아
  consumerId/depositState/digest의 문자열 타입을 엄격하게 검사하도록 수정했다.
  불가능한 날짜 및 nullable mileage 타입 불일치도 수정/시험했다.
  월요금 0 금지 제안은 채택하지 않았다. 계약의 명시적 0과 미확인값은 다르며,
  이 검사기는 원천에 실제로 있는 0을 보존한다. null/빈 문자열은 여전히 HOLD다.
  중복 키가 조용히 살아남는다는 우려는 중복을 HOLD하는 회귀시험으로 반증했다.
- Claude 시도: 주간 사용 한도로 UNAVAILABLE.
- Gemini 시도: 인증 단계 403 서비스 비활성화로 UNAVAILABLE. 검토 통과가 아니다.
- 운영 원천/배포/UI 검증, 실데이터 매퍼 및 Release 진위 검증은 아직 수행하지 않았다.

이 문서는 연결 준비 인수인계이며 운영 전환 완료 증거가 아니다.
