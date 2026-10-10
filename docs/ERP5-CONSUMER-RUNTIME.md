# freepasserp5 중앙 연결과 소비처 전환 상태

## 2026-10-09 현행 연결 안내 — 아래 날짜별 과거 관측과 구분

- 중앙 저장 대상은 `freepasserp5` Firestore이며 서버 연결은 `src/infra/firebase-target.ts` 한 곳이다. RTDB 경로는 폐기·사용 금지.
- 공통시트 입력은 `shared-sheet-daily.yml`로 지정 최신 파일의 현재 공급사 탭만 읽는다. 종합·과거 개별 시트 fallback은 금지한다. 원본/이력은 보존한다.
- ERP.com/등록 화이트라벨의 현행 호환 조회는 소비처별 인증을 사용하는 `/v1/consumers/{consumerId}/catalog-compat`, 사진은 그 아래 `/products/{productId}/photos[/{index}]`다. 공개 차량 자격을 재확인하며 사진 원본주소·공급사 토큰을 브라우저에 전달하지 않는다. 이번 코드의 UNKNOWN 보증금 계약은 null + 미확인이며 기존 배포의 표시 반영은 별도 확인한다.
- `/catalog`는 검증된 Canonical ACTIVE 전용이다. 호환 조회가 성공해도 Canonical 전체 전환을 선언하거나 `/catalog` 실패를 숨겨 대체하지 않는다. Admin/Estimate/Kakao도 각자 기존 등록 계약을 유지한다.
- pre-ONE `data-owned-refresh.yml`/`data-delivery-owner.mjs` 실행은 **폐기·사용 금지**다. 현행 ERP writer를 이 오래된 실행기로 옮기지 않는다.
- 2026-10-09 직접 관측: `freepass-data-read-00015-649` READY, ERP.com 공개 사진 샘플 3개 JPEG 200. 동시에 최근 사진 요청 100건 중 503 8건과 25초 timeout도 관측했다. READY/샘플 성공은 전체 소비처·앨범 안정화 완료가 아니다.
- 아래의 2026-09 관측, 전환 전 표, 초기 Cloud Run 미활성 기록은 **역사 관측**이며 현재 운영 상태로 사용하지 않는다. 전체 화이트라벨/Admin/Estimate readback 및 원천→소비처 현재성은 미검증 상태를 유지한다.
## 공통 시트 → ERP 연결 준비 — 2026-10-06

공통 시트의 입력값·서식·드롭다운·행 수를 변경하지 않고 기존 RAW/후보 → 검토된 Canonical → ACTIVE release → 인증 API를 사용한다. PR #397의 12탭/15코드 범위를 전제로 한다. absent 3탭은 HOLD이며 기존 재고 삭제/판매완료 근거가 아니다. 차량·기간 대사는 기존 `pilot:check`의 원천/기존 소비처/Data 3자 비교를 사용한다([읽기 대사](CONSUMER-READ-PILOT.md)); 단순 HTTP 200이나 대수 일치를 cutover로 인정하지 않는다.

현행 공급사 관리 권한은 `supplier-input-presentation/2026-10-06.3`의 `supplierManagement`다. 공통 입력 관리값을 옛 공급사 시트와의 차이만으로 되돌리지 않는다. API/홈페이지 직접 공급사 경로는 해당 기존 정본을 유지한다. 종착역은 기존 수집·저장·release·consumer 경계를 완성하는 것이며 별도 ERP 원천 writer나 중복 Canonical을 추가하지 않는다. 기존 브리지의 종료는 consumer readback·rollback·대체 경로 보존 후에만 판정한다.

ERP 코드의 실제 환경변수 이름은 `FREEPASS_DATA_BASE_URL`, `FREEPASS_DATA_ERP_COM_TOKEN`, `FREEPASS_DATA_ERP_COM_READ_MODE`다. 축약 `ERP_COM_TOKEN`/`ERP_COM_READ_MODE`를 새 설정으로 만들지 않는다. private Cloud Run 호출은 기존 Vercel OIDC → `FREEPASS_DATA_GCP_WIF_AUDIENCE` → `FREEPASS_DATA_GCP_CALLER_SERVICE_ACCOUNT_EMAIL` → ID token 경로를 사용한다. 사용자 계정 비밀번호·새 키 파일은 필요하지 않다. 배포된 설정·IAM·토큰 검증은 현재 로컬 코드 확인과 별개다.

기존 `scripts/check-read-runtime.mjs`는 `READ_RUNTIME_CHECK_COMPAT_ONLY=1`에서 인증된 `/catalog-compat`만 검사한다. consumer identity/authority/project/관측시각/map/독립 collection count를 검증하고 원문·토큰 대신 대수만 출력한다. Health/ACTIVE release가 없는 상태에서도 호환 transport를 진단할 수 있으며 결과는 항상 `canonicalReleaseVerified=false`, `cutoverAuthorized=false`다. optional partners/users는 응답에 있으면 검사하지만 필요한 collection의 포함 여부는 ERP의 요청 범위와 추가 대사해야 한다. 관측시각 유효성은 최신성 검증이 아니다.

`READ_RUNTIME_REQUIRED_COMPAT_COLLECTIONS=products,policies,partners,users`처럼 ERP 요청 범위의 필수 collection을 지정하면 누락을 실패로 처리한다(기본 products,policies). Canonical 검사도 non-empty data, 해당 consumer, `erp-public`/`1.0.0`/`CANONICAL_ACTIVE`, release/manifest/input/data digest metadata를 요구한다. 이 점검은 gateway의 실제 digest 무결성 검증이나 3자 parity 대사를 대체하지 않는다.

```powershell
# 승인된 secret 공급 경로에서 환경변수를 프로세스에 주입한다. 값을 명령/로그에 적지 않는다.
# READ_RUNTIME_URL = FREEPASS_DATA_BASE_URL
# READ_RUNTIME_CONSUMER_ID = erp-com
# READ_RUNTIME_TOKEN = FREEPASS_DATA_ERP_COM_TOKEN
# READ_RUNTIME_CLOUD_RUN_ID_TOKEN = 기존 신원으로 발급한 audience-bound ID token
$env:READ_RUNTIME_CHECK_COMPAT_ONLY = '1'
$env:READ_RUNTIME_CHECK_CATALOG = '0'
node scripts/check-read-runtime.mjs
# ACTIVE release/Health 검사 단계는 별도로 실행한다.
$env:READ_RUNTIME_CHECK_COMPAT_ONLY = '0'
$env:READ_RUNTIME_CHECK_CATALOG = '1'
node scripts/check-read-runtime.mjs
```

운영 순서:

1. PR #397과 이 연동 후속의 exact-head 검토·통합을 확인한다. 기존 `shared-sheet-daily.yml`의 WIF/전용 계정/비공개 증거 경로를 재사용한다. 해당 workflow는 이미 존재하므로 새 수집 writer/예약을 만들지 않는다. 현행 main의 run·pin·감시 결과를 확인한 뒤 승인된 `dry-run`에서 fresh capture/기존 Canonical/source head/writer ownership을 대사한다. 이 세션은 workflow를 실행하거나 변수를 바꾸지 않았다.
2. dry-run의 planDigest/target/specDigest·HOLD·실제 writer를 고정하고, 기존 운영 백업과 last-known-good ACTIVE를 보존한다. 운영 적재·writer 전환이 필요한 경우 각각 별도 승인 경계를 따른다. 로컬 `--memory` 계획은 운영 계획을 대체하지 않는다.
3. 승인된 계획 apply·Canonical 가격/수수료 되읽기·lineage 확인 후 기존 projection/READY/ACTIVE 게이트로 게시한다. ingestion 성공만으로 release가 발행되지는 않는다. UNKNOWN 수수료를 0으로 바꾸지 않는다.
4. 위 호환 transport와 Canonical API를 각각 조회한다. 기존 ERP `OBSERVE`는 compatibility transport이고 `FREEPASS_DATA_READ`는 아직 consumer 구현에서 fail-closed다. 공개 필드 coverage·기간별 조건·실시간 계약락·화이트라벨별 권한·rollback 증거가 없으면 스위치를 바꾸지 않는다.
5. 동일 release와 원천 범위로 `pilot:check`를 실행하고 ERP.com 실제 목록/상세/API readback을 남긴다. 각 화이트라벨/Admin/F01/F86은 개별 증거가 필요하며 ERP.com만으로 전체 완료를 선언하지 않는다.

현재 PC에는 PATH 및 표준 설치 위치에서 gcloud 실행기, 표준 Roaming 경로의 `freepass-data` configuration/ADC, 관련 consumer 환경변수가 관측되지 않았다. 운영 인증은 **HOLD_ENVIRONMENT_AUTH_UNAVAILABLE**이며 기존 WIF가 실패했다는 판정은 아니다. 10-06 private capture 171행을 memory로 재실행한 결과 38행 HOLD, 675개 공급 기간/675개 선계산 항목 일치, 각 수수료 측 UNKNOWN214였다. 이는 오프라인 미리보기이며 PERSISTENCE/DEPLOYMENT/CUTOVER 증거가 아니다.

2026-09-21 사용자 직접 지정: 중앙 저장용 Firebase 프로젝트는 **freepasserp5**.
Firestore `(default)`, `asia-northeast3`를 실조회했다. RTDB는 사용하지 않는다.

## 코드에 반영한 연결

- `src/infra/firebase-target.ts`가 두 저장 어댑터의 유일한 대상 연결을 만든다.
- `FIREBASE_PROJECT_ID`를 명시해야 한다. production은 `freepasserp5`만 허용하며 emulator를 거부한다.
- 이미 만들어진 `freepass-data-target` 앱의 프로젝트가 다르면 중단한다. 기본 Firebase 앱이나 ADC 프로젝트 추정으로 우회하지 않는다.
- production은 메모리 데모 실행을 거부한다. API 부팅이 Firestore Release를 생성/활성화하지 않는다.
- 기존 개발 API 전체는 memory에서만 실행할 수 있다. Firestore 조회도 인증 없는 개발 경로로 우회할 수 없다. 운영 명령은 서비스 신원과 권한 검증이 완성될 때까지 차단한다.

## 독립된 소비처 읽기 서버

2026-10-07 보증금 판정 추가 계약: `catalog-compat/v1`의 기존 `products.price[key]`에 `depositState`(KNOWN/ZERO/UNKNOWN), `depositStatusLabel`, `depositEvidenceReason`를 응답에서 파생한다. `meta.depositEvidenceVersion`은 `catalog-compat-deposit/1`. 기존 기간/거리 key와 rent는 보존하고, UNKNOWN의 `deposit`은 null, 문구는 **보증금 확인 필요**다. 소비처는 금액만으로 상태를 추정하지 않는다. 원문 저장값·DB는 변경하지 않는다.

일반 상품은 `assessDepositEvidence`를 재사용한다. 이안카는 기존 승인 발행기가 저장한 `iancar_phase_one` typed 조건과 동일 차량/발행 schema/digest 형식/갱신 시각(기존 15분 신선도)/가격/최저거리 alias를 모두 대조한 경우만 확인된 금액과 0을 전달한다. digest 형식 검사는 비공개 RAW 재해싱이 아니며, 원문 근거를 응답에 새로 추가하지 않는다. 누락·충돌·미등록 발행 경로·오래된 근거는 UNKNOWN이다. 이 코드 변경은 운영 배포·ERP 화면 반영 증거가 아니며, Canonical의 이전 ACTIVE와 새 보류 원천의 현재성 연결은 별도 HOLD다.

`npm run serve:consumers`는 읽기 전용 서버다. worker, 시드, command endpoint, 게시 기능이 없다.
서버 환경에 `FIREBASE_PROJECT_ID=freepasserp5`, `FREEPASS_DATA_DRIVER=firestore`, 서비스의 ADC/workload identity,
`FREEPASS_DATA_CONSUMERS_JSON`을 설정한다. 운영에서는 `NODE_ENV=production`도 명시한다.
기본 바인딩은 localhost다. 배포 인프라의 TLS/서비스 접근 정책 검토 후에만 HOST를 변경한다.
이 읽기 서버는 NODE_ENV 누락에도 다른 프로젝트, memory, emulator를 거부한다. 런타임 객체에는 읽기 메서드 두 개만 제공하며 IAM의 읽기 전용 설정도 별도로 필요하다.

등록된 backend는 `GET /v1/consumers/{consumerId}/catalog`에 소비처 전용 Bearer를 보낸다.
토큰은 Secret Manager 등 서버의 비밀 저장소에서 공급하고 브라우저/Sheets 셀/로그에 넣지 않는다.
다른 소비처의 토큰을 재사용하거나 요청자가 projection을 선택할 수 없다.
허용된 public schema, ACTIVE 상태, manifest 및 input/data digest를 확인하고 실제 사용한 release ID를 응답한다.
정상 응답에는 `authority=CANONICAL_ACTIVE`를 포함한다. 소비자는 이 값이 없는 응답이나
`REFERENCE_ONLY` 보조 자료를 공식 ACTIVE release로 취급하지 않는다.
현재 빈 release도 거부한다. 정상적인 전체 품절에 따른 빈 게시 허용은 별도 증거 계약이 필요하다.
이는 데이터 무결성 검사이며 최신성·가격 의미·소비처 parity 검증을 대체하지 않는다.

| 소비처 | 이번 코드 | 운영 상태 |
| --- | --- | --- |
| ERP.com | `erp-com` 서비스 등록 및 ERP public read 계약 | 기존 ERP5 직접 읽기 유지, 전환 전 |
| 각 화이트라벨 | `whitelabel-<slug>` 개별 등록·토큰 | 실제 도메인 목록/노출 권한/캐시/배포 검증 전 |
| F01 | 전용 게시 계약 필요 | 기존 출력 경로 유지 |
| F86 | 전용 게시 계약 필요 | 기존 출력 경로 유지 |
| Admin | 기존 PR12와 새 Release 증거 게이트 통합 필요 | Policy parity 및 인증/IAM 검증 전 |
| Kakao Ops | `kakao-ops` 전용 `catalog-reference` 계약 | main `20e83e2`, read runtime revision `freepass-data-read-00013-cvq`, 전용 token 등록 및 운영 readback 완료 |

F01/F86/Admin을 ERP public 계약에 억지로 연결하지 않는다. 원문 옵션·시트 게시 필드와 Admin 내부 정책 정보는 별도 계약이 필요하다.
등록되지 않은 소비처는 응답을 받을 수 없다. 웹에 서비스를 공개하거나 운영 소비처를 전환한 상태가 아니다.

### Kakao Ops 명시적 REFERENCE_ONLY 계약 (2026-09-28)

Canonical ACTIVE release가 비어 있는 동안 Kakao가 운영 의미를 임의 계산하지 않도록
`GET /v1/consumers/kakao-ops/catalog-reference`를 별도 계약으로 둔다. 기존 `/catalog`의 503을
이 응답으로 조용히 대체하지 않는다.

- 기간별 `depositAmount`, `depositState`, `depositRule`을 FreePass Data에서 결정한다.
- `ZERO`는 원문 비고가 `무보증`이거나 `deposit_free_confirmation.source`와 ISO `at`이 있는 공급사 확인 답변이 있을 때만 사용한다. `deposit_free` true/`예` 단독, 규칙이 있는데 원천 숫자가 0인 값, 비고가 없으면서 원천 숫자가 0인 값은 `UNKNOWN`이다. 규칙 금액은 별도 규칙으로 계산한다.
- ERP5 `products.ext_color`는 `vehicle.exteriorColor`로 전달한다.
- ERP4 `lib/domain/settlement-fee-table.ts`를 코드 정본으로, F04 정산원장 `수수료표!A:J`를
  게시 사본으로 고정했다. 2026-09-28 실조회 150개 규칙 중 자동산출 122행·사람판단 28행을
  전수 대조했고 수치 불일치 0건이었다. `영업자 조율` 행은 금액을 만들지 않는다.
- 원 단위 나눗셈 또는 VAT에서 소수점이 생기는데 반올림 규칙이 없으면 계산하지 않고
  `ROUNDING_RULE_UNSPECIFIED`/`VAT_ROUNDING_RULE_UNSPECIFIED`로 HOLD한다.
- 응답은 항상 `authority=REFERENCE_ONLY`, `publicationDecision=HOLD`다. 재고·가격·수수료 확정은
  별도 공급사 확인 전 완료가 아니다.

최근 private read-only 캡처(`readTime=2026-09-27T16:09:37.843976Z`, source digest
`659c1a84d316965e62ace7669ad630261685d55f923d9938c8148edc9a697310`)로 로컬 전수 검증한 결과는
원천 1,659건 중 listable projection 685건, 기간 4,223건, 외장색상 678건이다. 보증금 상태는
KNOWN 4,037 / ZERO 36 / UNKNOWN 150이었다. 이후 main `20e83e2`를 운영 배포하고 인증된
`catalog-reference` readback에서 HTTP 200, projected 745, 수수료 policy digest 존재를 확인했다.
같은 `kakao-ops` 등록의 `settlement-ledger-read`는 존재하지 않는 코드 조회로 HTTP 200·0건·정상
digest를 확인했다.

## 반복 가능한 읽기 전용 점검

서비스 인증 환경: `npm run check:central-firestore`.
로컬의 명시적 gcloud 로그인으로 확인: `npm run check:central-firestore -- --gcloud`.
명령은 여섯 collection의 count만 읽고 값/고객 원문을 출력하지 않는다. 조회별 readTime을 기록한다.
동일 시각의 일관된 상품 스냅샷이나 전체 대사가 아니며 `cutoverAuthorized`는 항상 false다.

2026-09-21T08:41:15Z 실제 결과:

| collection | count |
| --- | ---: |
| products | 1659 |
| policy | 81 |
| catalog_products | 0 |
| catalog_offers | 0 |
| catalog_policies | 0 |
| projection_active | 0 |

결과: `HOLD_MISSING_CANONICAL_OR_RELEASE`. 연결에 성공해도 빈 정본으로 소비처를 전환하면 안 된다.
로컬 기본 ADC는 없으며 명시적 gcloud 읽기는 성공했다. gcloud 사용자 로그인을 운영 서비스 인증으로 설치하지 않았다.
Cloud Run 조회는 `run.googleapis.com` 비활성으로 실패했다. API를 활성화하거나 서비스/IAM을 만들지 않았다.

### ERP5 전체 원문 캡처 후속 관측

별도 읽기 전용 수집 작업이 2026-09-21T09:06:44.344978Z의 동일 Firestore read-only transaction에서
`products` 1,659건과 `policy` 81건을 전부 읽고 각각의 독립 COUNT와 일치시켰다.
원문은 Git 밖의 로컬 private 증거 파일에만 저장했으며 이 문서나 PR에 포함하지 않았다.
캡처 digest는 `ad67d6f5ef2914b90dc682704f1894105079ebbbbc0d8be44269cf69c68e735f`다.

초기 엄격 매핑 요약은 `mappedForReview=0`, `mappingHold=766`, `decodeFailed=893`이었다.
비민감 typed-key 집계를 별도로 실행한 결과 893건의 decode 실패는 모두 `timestampValue` 영향 문서였고
해당 typed value는 총 1,030개였다. 필드별로는 `policy_reference_checked_at` 887개,
`updated_at` 143개이며 같은 문서에 함께 있을 수 있다. reference/geoPoint/bytes typed value는 0개였다.

원문 typed JSON과 digest는 바꾸지 않고 관측된 위 두 최상위 메타데이터 필드만 RFC3339로 검증해
원문 문자열로 전달하도록 decoder 경계를 보완했다. 임의 업무필드나 중첩 timestamp에는 적용하지 않는다.
같은 캡처 재검사 최종 결과는 `mappedForReview=0`, `mappingHold=1659`, `decodeFailed=0`이다.
즉 1,659건 전부 의미 검사까지 도달했지만, 가격·보증금·주행거리·정책·손오공 분류 증거 부족으로
모두 HOLD다. 이는 운영 상품 1,659건이 잘못됐다는 뜻이 아니다.
정책 81건은 같은 시점 원문 캡처 범위이며 Policy 정본 변환·링크 검증 완료 건수가 아니다.
전체 1,659건의 차량번호는 읽혔고 공백을 무시한 중복 요약은 0이지만,
차량번호만으로 상품/계약 동일성을 보증하지 않는다.

결과는 계속 `cutoverAuthorized=false`, `canonicalWriteAuthorized=false`다.
공급사 원천과의 최신성/parity, 메타데이터 시각의 업무 의미, Policy 링크, Canonical write 및 소비처 전환은 미검증이다.
요약 숫자는 원문 값이나 고객정보를 공개하지 않지만, 운영 연결 완료 증거로 사용하지 않는다.

### Policy 연결 증거

동일한 변경 불가 캡처를 대상으로 digest를 다시 확인한 뒤 정책 연결을 count-only로 분석했다.
정책 문서 81건 중 비활성 26건, 사용할 수 없는 문서 0건, ID 충돌·중복 exact identifier 0건이었다.
상품 참조는 전체 1,659건 중 정책 미설정 317건과 exact unique 연결 검토 후보 1,342건으로 완전 분류됐다.
invalid·ambiguous·inactive exact·zero-padding/alias 후보·missing은 각각 0건이다.
상품이 참조한 정책 문서는 30건이고 미참조 정책 문서는 51건이다.

이 결과는 ID 수준의 정확한 일치 증거다. 1,342건의 정책 내용이 올바르거나 Canonical Policy로 승인됐다는 뜻은 아니다.
정책 사실의 의미·유효기간·필드 authority를 검토하기 전까지 `status=HOLD`,
`canonicalWriteAuthorized=false`, `cutoverAuthorized=false`를 유지한다.

## 전환에 남은 작업

1. 완료한 read-only 전체 캡처·typed decode·Policy ID 연결 증거를 기준으로 가격/보증금/주행거리와 정책 사실 의미를 대조해 검토 가능한 RAW/Candidate → 승인된 Canonical/Policy로 진행.
2. PR12 Admin projection과 현재 manifest/lineage/READY 게이트 통합. 기존 PR12를 그대로 병합하면 이 계약과 호환되지 않는다.
3. F01/F86 출력 필드를 보존하는 계약, 소비처 전체에 공통으로 추적할 source/release 버전 연결.
4. 운영 API 호스팅/서비스 identity/IAM을 확정하고 실제 서버에서 읽기 검증.
5. 각 소비처 mapper와 shadow 대사. 실시간 계약락/판매가능 상태 경계 보존.
6. 대상별 전환, 실패 시 기존 경로 유지, 실제 화면/시트/API 응답 재조회. 전 대상 검증 전에는 전체 완료가 아니다.

ERP5 순수 변환은 별도 `codex/erp5-product-mapping-20260921` 작업이 담당한다.
이 작업은 Firebase binding/읽기 API/연결 점검만 담당하여 공용 미커밋 파일을 덮어쓰지 않는다.

## 검증 기록

- Codex: 구조 검사, TypeScript 빌드, API 인증/변조/empty HOLD, 실제 entrypoint 차단, named-app 재사용 검사, 읽기 전용 Firestore reader 검사 통과. 위 count는 운영 REST 재조회 증거다.
- Cursor Agent: 초기 FAIL 두 항목(소비 서버 NODE_ENV 누락 시 다른 프로젝트 허용, 개발 API의 Firestore 무인증 조회)을 수정했다. 동일 worktree 재검토에서 이 코드 범위 PASS. 배포/전체 소비처 전환 승인은 아니다.
- Claude Code: 주간 한도로 UNAVAILABLE. Gemini CLI: 계정 서비스 403으로 UNAVAILABLE. 둘을 PASS로 계산하지 않는다.
- 미해결 코드 검토 이견은 없으며, 운영 이전 필수 교차검증과 실제 소비처 대사는 미완료다.
- 별도 ERP5 변환 커밋 `9895b518675e75b9371bdf169e7f11ffb5d88198`을 인계받았으며 이번 런타임 변경에 자동 병합하거나 운영 게시하지 않았다.
