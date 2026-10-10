# FreePass Data native supplier intake — original ERP, not ERP4

Status (2026-10-03): **CODED / FIXTURE TESTED; LIVE ORIGINAL / PERSISTENCE / DEPLOYMENT / CUTOVER HOLD.**
Owner: FreePass Data. Existing `SourceIntakeBatch`, `ingestRawSourceBatch` and Firestore Source Store are reused.
This does not add a second CatalogStore, publication writer or scheduler.

## 카카오톡 원천 — 2026-10-09

### 실제 연결 — 2026-10-09

P1 수정 검증(2026-10-09, HEAD `8508e9f` 기반 미커밋): RP023 실제 문서 차단, 중복 폴더 결정적 선택·재시작 수렴·경고 요약 회귀 시험을 추가했다. `npm.cmd run check` 실행: 카카오 live ports 23/23, source intake 38/38 PASS; 전체 Vitest 1,805 PASS / 9 FAIL / 14 SKIP(4개 파일 실패), exit 1. 실패는 iancar-source-capture/read-pilot/runtime-policy의 하위 실행 환경 및 jq, vehicle-finder-route의 localhost ECONNREFUSED를 포함한다. 전체 check PASS 아님. 네트워크 제한으로 연결 재시도 중지(BLOCKED_NETWORK). 원문 로그 `.kakao-p1-check.log`. 커밋·푸시·운영 실행 없음. next_start_here: 호출 세션에서 환경 제한과 실패 9건을 확인하고 전체 check 재검증.

**CODED / OFFLINE TESTED, 운영 실측 HOLD.** 기준 `503aee8aff28c52a0d55f39d23cc753d15e328ed`, `work/freepass-data/kakao-live-ports-20261009`. 사용자 제공 main/Issue #24/겹치는 PR 확인을 사용했다. Academy READY `2026-10-09T13:26:04.539Z`, reuse COMPOSE_OR_EXTEND. **CREATE_NEW_JUSTIFIED**: 기존 SourceStore·사건 선점·카카오 CLI·사진 계획과 이안카 typed backup codec을 재사용한다. 기존 포트에는 Drive REST transport/사용자 ADC 조합/일반 카톡 사진 CAS 구현이 없어 `kakao-drive-archive.ts`, `kakao-live-ports.ts`, 가짜 transport 시험만 추가했다. 새 DB·예약 작업·서비스·공유 권한은 만들지 않았다.

아래 결정이 이 절의 과거 domain reader 허용, Actions 실행 초안, live ports 미구현 안내를 대체한다. 실행자는 **카톡 비공개 대기열이 있는 Windows PC의 예약 작업**, 인증자는 **pyh@teamjpk.com 사용자 ADC**다. 기존 gws 사용자 인증과 gcloud ADC는 별개 토큰 저장소이므로 gws 성공만으로 ADC 접근을 판단하지 않는다. 서비스 계정 키·폴더 공유·공개 링크 없음. 예약 작업은 해당 Windows 사용자로 실행하고 중복 인스턴스를 시작하지 않도록 설정해야 한다. 이번 작업은 예약을 등록/활성화하지 않았다.

환경 변수(실제 값은 비공개 운영 설정에만 둔다):

| 이름 | 의미 |
|---|---|
| `FREEPASS_KAKAO_DRIVE_ROOT_ID` | 필수. `원문/카카오톡` 논리 루트에 대응하는 실제 비공개 폴더. 아래에는 `{공급사코드}/{YYYY-MM}/{eventId}`만 생성한다. 실제 ID는 코드·문서·시험·로그에 기록하지 않는다. |
| `FIREBASE_PROJECT_ID` | 명시적 중앙 target `freepasserp5`. `firebase-target.ts`만 사용한다. |
| `NODE_ENV` | 운영은 `production`, emulator 금지. |
| `FREEPASS_KAKAO_SOURCE_APPLY` | `approved`와 CLI `--apply`가 함께 있어야 내장 `createKakaoPorts()` 호출. 기본 dry-run은 인증·네트워크·쓰기 0. |
| `FREEPASS_KAKAO_PORTS_MODULE` | 선택. 기존 검토된 로컬 모듈의 `createKakaoPorts()`를 우선하는 호환 경로. 입력 JSON으로 지정 금지. |
| `FREEPASS_KAKAO_PHOTO_APPLY` | 사진 writer 전용 별도 `approved` gate. 원문 보관 승인으로 설정하지 않는다. |
| `FREEPASS_KAKAO_PHOTO_BACKUP_DIR` | 사진 쓰기 시 필수 절대 경로. 저장소 밖의 사용자 전용 비공개 디렉터리. Windows ACL은 운영에서 확인한다. |

`KakaoDriveArchive`는 Drive v3 REST의 files.get/list/create, permissions.list, alt=media만 사용한다. ADC가 UserRefreshClient인지와 Drive about의 실제 사용자 이메일을 확인한다. 목적지와 루트 위 모든 부모를 읽어 **같은 사용자 소유자 정확히 1명 외 권한이 하나라도 있으면 거부**한다. 조직 내부 reader도 거부하며 공유 드라이브도 허용하지 않는다. 목록·권한 pagination을 끝까지 읽고 incompleteSearch/미확인 권한을 거부한다. inspectDestination은 쓰기 0, upload에서 부모별 검색 후 폴더를 생성하고 다시 검색한다. 같은 포트 인스턴스의 동시 upload는 직렬화한다. 서로 다른 인스턴스의 동시 생성으로 폴더가 중복될 수 있으므로, 같은 부모·같은 이름·폴더 MIME 검색 결과에서 `createdTime`이 가장 이른 폴더(동률이면 ID 사전순)를 항상 선택한다. 생성 성공 뒤에도 재검색하여 같은 규칙으로 수렴한다. 중복 발견 시 결과 요약 `warnings`에 `DRIVE_DUPLICATE_FOLDER`를 남기고 삭제·이동하지 않는다. 폴더 생성 응답 유실은 같은 실행에서 재생성하지 않으며, 재시작 뒤 재검색이 0건일 때만 생성한다. 파일 `find`는 선택 폴더에 한정하지 않고 `appProperties(eventId·sha256)`로 검색한 뒤 실제 루트 아래 경로·바이트·권한을 검증하므로 비선택 중복 폴더의 기존 파일도 재사용한다. 폴더 선택은 파일 동시 업로드의 원자적 잠금이 아니며 동일 사건의 동시 처리는 기존 SourceStore 사건 선점이 담당한다.
- 알려진 한계(재검토 Codex 지적, Claude 판정 2026-10-09): 폴더 생성 응답이 끊긴 사건은 `UNKNOWN`으로 남고, 재시작해도 선점을 다시 얻지 못해 자동으로 업로드하지 않는다. 설계상 «응답 유실 = 재조회·수동 대사 뒤 재개»이므로 안전 정지(중복 업로드·원문 유실 없음)다. 운영에서 `UNKNOWN` 사건이 쌓이면 상황실 알림 대상이며, 폴더 준비 실패와 파일 전송 불확실을 영속 상태로 나눠 자동 재개하는 것은 후속 과제다.

파일은 eventId·sha256 appProperties로 검색하고 multipart 원본 업로드 후 새 다운로드 바이트 SHA256·경로·속성·권한을 대조한다. POST 자동 재시도 없음. 응답 유실·5xx·본문 유실은 `DRIVE_RESPONSE_UNKNOWN`이며 기존 수집기가 UNKNOWN 영수증을 남긴다. 최초 사건 선점이 재업로드를 차단한다. 같은 프로세스의 불확실한 폴더/파일 POST에도 fence가 남는다. 파일 응답 유실의 재시작은 검색·검증으로 대사하고, 누락을 재업로드 승인으로 해석하지 않는다. 폴더 응답 유실의 재시작은 위 재검색 규칙을 따른다. `find`도 원본 다운로드/검증을 하므로 비용이 들며 성공 목록만 믿지 않는다.

Source는 기존 `FirestoreSourceStore` 그대로다. `KakaoProductReader`는 `products`의 공급사 전체 목록과 지정 문서를 읽고, 수집기는 입력 JSON snapshot 대신 그 최신 목록으로 대조한다. 공급사별 차량 ID 칸은 추정하지 않으므로 내장 reader의 ID-only 매칭은 HOLD, 원문 차량번호 매칭은 가능하다. 공급사 ID 전용 매칭을 켜려면 기존 칸의 검증된 mapping을 가진 reader를 호환 모듈로 주입해야 한다.

**매시 products writer 조사(운영 실호출 아님):** ERP4 로컬 HEAD `fa260f63c10838a667dddad589071f0c73322a70`의 `.github/workflows/erp5-ssot-refresh.yml:13`은 매시 17분, `:138`은 엔진 `e6727ff04fcf98380701fa6360c36f313e0e321f` 고정, `:201`은 ingest-all-suppliers 실행이다. 아래 줄은 반드시 **그 고정 revision의 git show** 기준이며 현재 checkout의 retired stub과 혼동하지 않는다.

| 고정 엔진 파일:줄 | 결과 |
|---|---|
| `scripts/ingest-all-suppliers.mts:32-34` | RP023은 reborncar, 나머지는 ingest-supplier로 분기한다. |
| `scripts/ingest-supplier-to-firestore.mts:507-544`, `:622`, `:773`, `:910-912` | 전체 atom/변동 목록에 photo_link가 없다. 전체·변동 모두 merge=true이므로 기존 photo_link를 덮지 않는다. |
| `lib/domain/photo-atom.ts:24-34` | 공급사 사진은 image_urls/photo_source_hash/photo_collected_at으로 쓴다. photo_link가 아니다. |
| `scripts/ingest-reborncar-to-firestore.mts:112`, `:231-232`, `:254` | 공급사 mainImage를 photo_link 후보로 가져오지만 기존 x[k]가 비었을 때만 patch 후 merge한다. 기존 비어 있지 않은 링크는 유지한다. |
| Data `src/infra/iancar-publication-withdrawal-firestore.ts:19-38`, `:54-66` | RP031 사진 writer는 image_urls/image_url과 원본 보존 칸을 사용한다. 일반 카톡에 전용 공급사 writer를 전용하지 않는다. |

선택: **확인한 고정 코드에는 매시 photo_link 덮어쓰기가 없어** 별도 승인된 빈칸 채우기 `KakaoPhotoWriter`를 구현했다. 상품 전체 digest + Firestore updateTime(초/나노초)을 dry-run digest에 고정, typed before/expectedAfter 백업의 디스크 되읽기 → transaction CAS(maxAttempts=1) → photo_link만 update → 실제 after 백업/전체 문서 대조 순서다. 기존 값·표시 HOLD·승인 미충족은 거부하고 source CLI는 photoWriter를 호출하지 않는다. 응답 유실은 UNKNOWN 대사이며 자동 재실행/롤백하지 않는다. CAS/되읽기가 실패해도 before 백업은 보존한다.

**현재 운영 고정 엔진 재확인(2026-10-09, Codex 읽기 전용 조사, Claude 판정):** 매시 회차 고정 엔진은 `fb35bfb6a0257e973e93403ab4c67a0c90a46619`이다(위 로컬 HEAD 아님). 이 커밋 기준 공급사 경로별 `photo_link`:

| 경로 | 시트 사진으로 덮어쓰기 | 빈 값으로 지우기 | 근거 |
|---|---|---|---|
| 일반 시트 공급사(RP023 제외) | 없음 — 열 매핑·적재 행에 사진 없음, `merge:true` | 없음 | `scripts/ingest-supplier-to-firestore.mts:163-174,410,657-660,770,815,975-980` |
| 홈페이지(RP006) | 없음 — 변동 필드만 update | 없음 | 같은 파일 `:228-238,642,657-660,808-813` |
| RP012 | 없음 — 사진은 `image_urls`·`tica_link` | 없음 | 같은 파일 `:257-258,327,532-533`, `lib/domain/photo-atom.ts:24-33` |
| RP023 시트 적재 | **있음(조건부)** — 상태 전용 회차가 아니고 계약 잠금이 없으며 원천 사진 링크가 비어 있지 않으면 기존 값을 덮어씀 | 없음 | `lib/domain/sheet-autoplus.ts:60-79`, `scripts/ingest-reborncar-to-firestore.mts:114-116` |

판정: RP023 외 공급사는 Data가 쓴 `photo_link`가 다음 매시 회차에 남는다. RP023은 원천 시트에 사진 링크가 생기면 덮어써지므로 카톡 사진 쓰기를 보류한다. **RP023 보류는 코드에서 강제**: 실제 상품 문서의 `provider_company_code` 또는 `partner_code`가 RP023이면 계획의 holds가 비어 있어도 dry-run/apply 모두 `PHOTO_SUPPLIER_OVERWRITE_HOLD`로 거부한다. `mirror-to-firestore.mts:56`의 CARRY는 이 오케스트레이터 경로가 아니다. 고정 엔진이 바뀌면 이 표를 다시 확인한다.

이것은 현재 운영 writer 배타성이나 표시 성공 증명이 아니다. RP023의 빈칸 판단은 읽기 후 쓰기까지 CAS가 없어 **동시 실행 중 이미 읽어 둔 빈 값으로 뒤늦게 덮는 경합**이 가능하다. 운영 사진 적용 전 매시 회차와 겹치지 않는 창 및 현행 pin/다른 writer를 확인해야 하며, 보장 불가면 사진 적용 HOLD다. image_urls는 매시 사진 writer의 칸이므로 대체 저장 칸으로 쓰지 않는다. 향후 photo_link 덮어쓰기 엔진으로 바뀌면 직접 writer를 중지하고 기존 `raw_records`(VEHICLE_PHOTO 원문 귀속) + `source_event_receipts.archiveRefs`(검증된 Drive 증거)를 Data reader가 조합해 ERP에 제공하는 안을 우선 검토한다. 전용 이안카 보존 칸 재사용이나 새 photos 컬렉션 생성은 하지 않는다. 비공개 Drive 사진의 ERP 접근은 계속 `ERP_PRIVATE_MEDIA_DISPLAY_UNVERIFIED`다.

**운영 실측 명령 순서 — 네트워크 있는 승인된 PC에서만, 이번에는 실행하지 않음:**

```powershell
# 대상 작업 트리에서, 기존 pyh@teamjpk.com 사용자 ADC 사용. 토큰 출력/저장 금지.
$env:NODE_ENV = 'production'
$env:FIREBASE_PROJECT_ID = 'freepasserp5'
$env:FREEPASS_KAKAO_DRIVE_ROOT_ID = Read-Host '비공개 Drive 루트 ID'
$env:FREEPASS_KAKAO_INPUT = Read-Host '비공개 묶음 JSON 절대 경로'
Remove-Item Env:FREEPASS_KAKAO_SOURCE_APPLY -ErrorAction SilentlyContinue
Remove-Item Env:FREEPASS_KAKAO_PHOTO_APPLY -ErrorAction SilentlyContinue
Remove-Item Env:FREEPASS_KAKAO_PORTS_MODULE -ErrorAction SilentlyContinue
npm.cmd run build
# 기본 실행: 쓰기 0, 토큰 발급/실조회도 없음
node dist/src/jobs/ingest-kakao-source.js "$env:FREEPASS_KAKAO_INPUT"
# ADC/실사용자/권한/공급사 상품 읽기만; 이 단계에서 폴더/Source 생성 없음
@'
import {readFile} from "node:fs/promises"; import {createKakaoPorts} from "./dist/src/infra/kakao-live-ports.js"; import {prepareKakaoBundle} from "./dist/src/adapters/kakao-source-intake.js"; const i=JSON.parse(await readFile(process.env.FREEPASS_KAKAO_INPUT,"utf8")); const p=await createKakaoPorts(); for(const m of prepareKakaoBundle(i.bundle)) {if(!m.directory) throw Error("IDENTITY_UNRESOLVED"); await p.drive.inspectDestination(m.directory);} await p.productReader.readSupplier(i.bundle.supplierCode); console.log("READ_ONLY_PREFLIGHT_OK");
'@ | node --input-type=module
# 위 성공과 현행 pin/예약 중복 금지/별도 원문 보관 승인을 확인한 뒤에만:
$env:FREEPASS_KAKAO_SOURCE_APPLY = 'approved'
node dist/src/jobs/ingest-kakao-source.js "$env:FREEPASS_KAKAO_INPUT" --apply
Remove-Item Env:FREEPASS_KAKAO_SOURCE_APPLY -ErrorAction SilentlyContinue
```

ADC 인증/Drive scope/Firestore IAM이 부족하면 그 지점에서 HOLD하며 서비스 계정·공유로 우회하지 않는다. 입력과 모든 출력/receipt는 공개 CI·Git에 남기지 않는다. apply 출력은 `{inputDigest,status,deleteAllowed,issues}`, exit 0 + ACK_ELIGIBLE만 원문 보관 되읽기 성공이며 사진 반영 성공이 아니다. UNKNOWN/HOLD이면 같은 입력 보존, 새 입력으로 업로드 재시도 금지. 네트워크 단절 복구 후 같은 입력으로 대사한다. 사진 적용은 표시/원문 귀속/현행 writer 경합 HOLD를 해소하고 `applyKakaoPhotoPlan(plan, ports.photoWriter, {apply:true,approval:'approved',expectedPlanDigest})`를 별도 검토된 실행자가 호출한다. 이번 오더는 그 운영 apply 명령/자동 작업을 활성화하지 않았다.

검증: 신규 fake-fetch/가짜 Firestore 18 PASS(소유자 외 권한·부모 상속 거부, 폴더 중복/동시 생성 방지, 응답 유실/5xx UNKNOWN 및 POST 재시도 0, 다운로드 해시 불일치, CAS 충돌, before/after 백업, 되읽기 불일치). 최초 기존 CLI 시험 1건은 새 내장 factory 동작에 맞춰 미설정 오류 기대값을 갱신했다. `npm.cmd run check` exit 1: architecture/standards/data-access/sheets/build/smoke/shadow/dashboard 통과, Vitest **1797 PASS / 9 FAIL / 14 SKIP**, 파일 137 PASS/4 FAIL/4 SKIP. 실패는 기존 문서와 같은 tsx os.userInfo ENOMEM, jq Permission denied, read-pilot exit/JSON 4건, 로컬 서버 ECONNREFUSED다. 전체 PASS 아님. 최종 관련 재검증은 NEXT-START-HERE에 기록한다. 실제 Google/Firestore 네트워크·운영 쓰기·ERP4 수정·커밋·푸시 없음. Claude 독립 검토는 호출 세션 후속 몫이며 네트워크 금지로 실행하지 않았다.

### 범위와 재사용 판정

- 기준: Data `a6ac21c9ea438c3eb1b3d7b2653261782637b632`, 브랜치 `work/freepass-data/kakao-source-intake-20261009`, 설계는 AI-OPS `ea4c0f2a:docs/handoffs/카톡자료-데이터화-설계-20261009.md`. 로컬 코드/가짜 포트 검증이며 운영 보관·상품 반영 완료가 아니다. 커밋·푸시 없음.
- 수정 전 Academy `READY` (`2026-10-09T12:42:33.093Z`), 재사용 `COMPOSE_OR_EXTEND`. 첫 시도는 잘못된 판정 문자열 `EXTEND`로 `REUSE_DECISION_REQUIRED`였고 허용된 판정으로 바로잡았다.
- 기존 `SourceIntakeBatch`, `ingestRawSourceBatch`, `SourceIngestionStore`, `firestore-layout.ts`, `firebase-target.ts`, `FieldLineageRecord`를 확장한다. 새 원천 DB·별도 product writer·스케줄러는 없다.
- **CREATE_NEW_JUSTIFIED**: 로컬 `reuse:check` PASS. 기존 AI-OPS `카톡파일-드라이브.mjs`의 계획/실행 분리와 공급사별 경로를 재사용하되 로컬 SHA-1 중복 장부는 중앙 멱등을 보장하지 못한다. 기존 Data 어댑터에 메시지 사건 선점·Drive 응답 유실 대사·오프라인 묶음 CLI가 없어 `source-event.ts`, 카카오 adapter/application/port/job 및 가짜 시험만 새 파일로 분리했다. 저장은 기존 Source 저장 계층이다.
- AI-OPS `문서읽기.mjs`의 CSV/XLSX 읽기 결과를 검증된 표 입력으로 받는다. 원본 바이트 SHA256, extractorVersion, sheet/startRow/행·열을 함께 보존한다. 실제 문서 리더 실행·OCR·PDF 추출은 이번 Data 실행기에 포함하지 않는다. 검증되지 않은 표/사진 OCR/PDF 해석은 HOLD다. 표의 문자열을 가격·차종·재고 확정값으로 승격하지 않는다.

### 흐름·키·HOLD

1. 공급사 1곳·공통 roomId 1개의 묶음을 로컬에서 검증한다. 기본 CLI는 파일 읽기와 계획 생성만 한다(쓰기 0).
2. 승인된 포트 실행에서 PC별 관측을 기존 `sources → source_runs → raw_records`로 적재하고 새 조회로 payload를 대조한다. 검증된 표 셀은 기존 `field_lineage`에 원문 경로/추출기 버전을 붙여 보관하고 run의 lineageCount에 포함한다. 표 후보가 완성된 CatalogCandidate인 것처럼 `normalized_candidates`에 넣지 않는다.
3. `SourceIngestionStore.claimEvent`가 `source_event_receipts`에서 트랜잭션 `create`로 처음 한 실행자만 업로드 권한을 얻는다. 기존 사건은 관측 참조만 합친다. 메모리 구현도 같은 도메인 전이를 사용한다. 모음 이름/문서 ID는 `firestore-layout.ts`에만 정의한다.
4. Drive 목적지와 상속 권한 검사 → `appProperties(eventId, sha256)` 재검색 → 최초 선점자만 업로드 → 원본 재다운로드 SHA256/경로/속성/권한 대조 → 영수증 revision CAS 확정. 실제 전송은 `KakaoDriveArchivePort` 뒤에 있다.
5. 차량 사진만 products 대조/`photo_link` 쓰기 계획으로 연결한다. 일반 문서·대화 원문 파일과 혼합 폴더는 상품에 연결하지 않는다. 이번 수집 함수는 상품 writer를 호출하지 않는다.

키 규칙:

- 메시지 ID가 있으면 `SHA256(UTF8(JSON.stringify(["카카오톡", roomId, messageId])))`. 문자열 경계를 보존하는 JSON tuple을 공통 인코딩으로 고정한다. PC명·수집시각·문장 내용은 사건 키에서 제외한다.
- ID가 없으면 `["카카오톡", roomId, senderKey, 원발송시각 UTC, sequence]`의 SHA256. `sequenceScope="ROOM"`인 공통 대화 순서가 필수다. PC 로컬 행번호나 문장+분 단위 시각은 식별 근거가 아니다.
- 식별 불충분이면 `eventId=null`, `IDENTITY_UNRESOLVED`; RAW 관측은 보존하고 Drive/상품 연결은 HOLD. 첨부 본체는 중앙 보관 확인 전 AI-OPS 비공개 로컬 대기열에서 삭제하지 않는다.
- `observationId=stableDigest([eventId, collectorId, observedAt, fingerprint])`. 두 PC 관측은 서로 다른 RAW 참조로 같은 사건에 매달린다. 재시작 시 같은 관측을 재사용한다.
- 첨부 동일성은 **원본 바이트 SHA256**이다. 같은 사건의 같은 파일은 한 번만 업로드하고, 다른 메시지가 같은 파일을 재전송하면 사건/원문 이력을 별도로 보존한다.
- `firstRawRef`는 처음 기록 후 불변. `latestRawRef`는 `captureVerified=true`이고 version이 더 큰 원문만 갱신한다. version은 공급사 원문의 검증된 후속 revision이며 PC 수집 횟수로 증가시키지 않는다. 같은/이전 version에서 원문이 달라지면 CONFLICT다.
- 선점 기한은 5분. 만료가 업로드 권한 재발급을 뜻하지 않는다. 선점/업로드/확정 응답 유실은 UNKNOWN, 재조회 전용이다. 첫 업로드 이후 미전송 파일이 남거나 새로운 원문 version의 파일이 없으면 자동 재업로드하지 않고 수동 대사 HOLD다.
- “오늘 매물”은 항상 PARTIAL이며 미관측 기존 차량의 삭제/품절 0. “2차 없습니다”는 STATUS_NOTICE_CANDIDATE이고 재고 0으로 바꾸지 않는다. 시트 충돌은 CONFLICT/HOLD다.
- 원문 내 공급사 차량 ID 또는 차량번호 증거가 없거나 products 대조가 0건/복수이면 HOLD. 공급사 코드가 다르면 매칭하지 않는다. 기존 `photo_link`가 있으면 보존/HOLD한다.

### 비공개 Drive 계약

경로는 `원문/카카오톡/{공급사코드}/{YYYY-MM}/{eventId}/`이고 실제 루트 폴더 ID는 비공개 운영 설정에만 둔다. 파일명은 SHA256이며 원래 대화와 첨부 메타데이터는 JSON 원문 파일에 보존한다. 속성은 `eventId`, `sha256`이다.

포트는 `inspectDestination`, `find`, `upload`, `verify`를 구현한다. `inspectDestination`은 쓰기 없이 해당 목적지 또는 생성할 목적지의 부모 ACL을 확인해야 한다. `upload`는 경로의 동일 부모/상속 ACL을 유지하고 공유 권한을 확대하지 않는다. `verify`의 sha256은 메타데이터를 믿는 값이 아니라 다운로드한 원본 바이트로 계산한 값이어야 한다.

현재 접근 검사는 전체/상속 권한 확인이 모두 있어야 한다. 지정 조직 domain의 reader(검색 공개 금지) 및 같은 조직 user만 허용하고 anyone·외부 사용자·확인되지 않은 group 권한은 거부한다. 서비스 계정/공유 드라이브 역할을 실제로 사용할 경우 이 엄격한 검사와 충돌할 수 있으며 허용 대상을 별도 검토해야 한다. 공개 링크로 우회하지 않는다. 파일 URL 문자열의 존재만으로 권한 검증 PASS가 되지 않는다.

### products 사진 칸과 ERP 소비 근거

읽기만 한 ERP4 로컬 HEAD는 `fa260f63c10838a667dddad589071f0c73322a70`이며 운영 배포 revision으로 간주하지 않는다. ERP4 수정 없음.

| 기존 칸 | 형식/소유자/소비 근거 |
|---|---|
| `products.photo_link` | 외부 사진 링크 문자열, 복수 링크는 줄바꿈. 이번 계획의 대상이다. Data `src/application/kakao-catalog-reference.ts:36`은 원천 링크로 구분한다. ERP4 `lib/domain/product-photos.ts:138`/`:174`에서 줄바꿈·쉼표를 분리해 직접 이미지/서버 해석 대상으로 나눈다. |
| `products.image_urls`, `image_url` | 이미지 URL 배열과 대표 이미지 문자열. Data `src/infra/iancar-publication-withdrawal-firestore.ts:35`에서 이안카의 기존 검토된 발행 경로가 쓴다. 일반 카톡 수집이 해당 이안카 writer를 다른 공급사에 사용하지 않는다. |
| `images`, `photos`, `photo` | 기존 호환 reader가 허용하는 별칭. Data `src/application/kakao-catalog-reference.ts:30`. 신규 표준 칸을 만들지 않는다. |
| `doc_images` | 문서 사진, 차량 대표사진으로 승격 금지. Data reader `src/application/kakao-catalog-reference.ts:32`에서 제외한다. 카톡 연결안도 VEHICLE_PHOTO만 선택한다. |

제품 의미 소유자는 `FREEPASS_DATA_CATALOG`, 일반 Admin gateway의 products 쓰기는 금지(`src/domain/admin-workflow.ts:35`). 따라서 이 작업은 Admin commit을 우회 writer로 만들지 않는다. 승인 적용은 기존 검토된 product writer의 `KakaoPhotoWriterPort` adapter로만 구성해야 하며 **그 운영 adapter는 미연결**이다.

ERP 상세는 `components/ProductDetail.tsx:71` → `components/use-product-photos.ts:33`/`:37`/`:44` → `lib/domain/product-photos.ts`를 읽고, 목록 카드도 공용 사진 경로를 사용한다(`components/ProductCard.tsx:47`). `app/api/extract-photos/route.ts:25`/`:76`에 Drive 서비스 계정 조회가 있지만, **이번 비공개 파일 링크가 실제 사진으로 표시되고 원문 접근 경계를 지키는지는 미확인**이다. Data 이안카 사진 프록시는 `src/api/consumer-gateway.ts:226`의 별도 인증·감사 경로이며 일반 Drive 프록시라고 가정하지 않는다. `ERP_PRIVATE_MEDIA_DISPLAY_UNVERIFIED`를 모든 사진 계획에 남긴다. 이번에 스키마 변경·사진용 새 칸은 없다.

### 2단계 — 공통 시트 사진 표시 계획 (2026-10-09)

기준 revision은 1단계 `dd529ac19acc0fae73de35e91c8d3704e74d094e`, 동일 PR #412 브랜치다. 사용자가 제공한 main `a6ac21c`/PR MERGEABLE/Issue #24 확인을 사용했으며 네트워크 재조회는 하지 않았다. Academy `READY` (`2026-10-09T13:01:51.934Z`). 재사용 판정은 **COMPOSE_OR_EXTEND**: 1단계 adapter/application/domain/port/job·시험과 이 문서를 확장한다. 새 파일·DB·workflow 자산 생성이 없어 `CREATE_NEW_JUSTIFIED` 대상도 없다. 과거 1단계의 신규 생성 근거는 위에 보존한다.

현행 시트의 사진 전용 열은 없다. `contracts/supplier-input-sheet-spec.v1.json:110`의 `inputHeaders` 마지막 `비고`(`:184`, BV)가 기존 표시 후보이며, `:30`/legacy sales 전환은 사진링크 열 제거·차량번호 링크 이전의 역사다. 옛 숨김 사진 열을 현행으로 복원하지 않는다. `docs/SUPPLIER-INPUT-SHEET-RUNBOOK.md:396`과 `:102`도 과거 사진 전환과 현행 전환을 구분한다. 규격 파일·머리글·시트는 변경하지 않았다.

기존 Data → 공통 시트 경로는 `src/application/sheet-blank-fill-input.ts::buildSheetBlankFillInput`(products/policy 읽기) → `src/application/sheet-blank-fill.ts::planSheetBlankFill` → `src/jobs/plan-sheet-blank-fill.ts`의 비공개 plan/report → 별도 승인된 AI-OPS 시트 실행기다. 현재 FIELD_MAP/TARGET_HEADERS에는 사진이 없어 products에 링크가 생겼다고 자동 표시되지 않는다. `scripts/supplier-input-sheet.mjs`는 규격 표시/종합 투영 경로이고, `summaryFormula`는 공급사 탭 A:BV를 종합한다. 이 스크립트를 새 원문 writer로 사용하지 않는다.

`planKakaoSheetPhoto`는 같은 `바꿀칸 {범위,전:'',후}`·`줄확인` 형식의 **사진 전용 계획 조각**만 만든다. 입력 헤더를 기존 `sharedSheetHeaders`와 완전 일치 검사하고, 최신 products.photo_link와 공급사/기존 차량 ID/행 식별 값을 대조한다. 현행 목적지는 비고이며, 15분 이내 셀 캡처·정확한 열/행·수식/링크 메타데이터 완전성이 필요하다. 공급사/사람 값, 공백, 0, false, 빈 결과 수식, 기존 링크는 보존한다. 비고가 차 있으면 덧붙이거나 지우지 않고 HOLD한다. 원문 문서 링크는 넣지 않으며 1단계에서 검증한 차량사진 링크의 products 되읽기만 전달한다.

자동 export/job 연결과 시트 쓰기는 아직 없다. 운영 연결 시 기존 비공개 계획에 이 조각을 합치되 시트 바인딩/등록된 현재 탭·상품 단일 매칭·productDigest/rowDigest·사진 lineage/권한·행 이동을 재검증해야 한다. `SHEET_PRIVATE_MEDIA_DISPLAY_UNVERIFIED`, `SHEET_WRITE_NOT_AUTHORIZED`는 계획에 남으며 일반 plan writer로 바로 전달하면 안 된다. 기존 비공개 링크만 표시하고 공유 권한을 확대하지 않는다. 사진/비고 열 모두 없는 미래 규격은 `SHEET_PHOTO_SPEC_DESIGN_REQUIRED`: 그때 별도 규격 설계만 제안하고 열 생성 금지다.

### 2단계 — 상시 수신·비공개 대기열·정리 계약

AI-OPS 감시가 메시지와 첨부 원본을 확보해 비공개 대기열에 원자적으로 게시 → Data 소유 실행기가 묶음을 읽고 기본 dry-run → 승인된 원문 보관 실행이 기존 Source/Drive 포트로 적재 → RAW/사건 영수증/첨부 바이트·권한 되읽기 → digest가 같은 ACK를 AI-OPS가 인증된 경로로 확인 → 그 묶음의 로컬 사본만 정리한다. 상품 반영·시트 쓰기는 독립 승인 경로다. 실행/예약은 **설계 상태**이며 이번 작업으로 상시 가동됐다는 뜻이 아니다.

- JSON은 1단계 CLI와 같은 `KakaoQueueInput = {bundle, products?}`다. bundle의 supplierCode/roomId/collectorId/observedAt/messages, 메시지·첨부 타입과 크기 제한은 `src/adapters/kakao-source-intake.ts` 하나를 재사용한다. 실행 모듈·명령·삭제 경로를 JSON에 추가하지 않는다. products는 선택적 계획 snapshot이며 운영 writer의 최신 읽기를 대체하지 않는다.
- 대기열 포트 `list() → [{key,inputDigest}]`, `read(key) → KakaoQueueInput`; key는 비공개 opaque key이고 inputDigest는 `stableDigest(input)`이다. 게시자는 임시 파일 완성 후 atomic rename/create로 공개하며 immutable key의 내용은 바꾸지 않는다. 재시작 시 같은 JSON·관측시각·version을 유지한다. PC ID를 사건 ID에 넣거나 재시도마다 revision을 올리지 않는다.
- `processKakaoQueue`는 순차 처리하고 읽기/해시 실패를 해당 묶음의 HOLD/UNKNOWN으로 격리한다. 목록 자체 실패는 `QUEUE_LIST_FAILED`로 실행 실패. 기본은 dry-run, 삭제 0. Source/Drive apply는 기존 승인 두 관문과 주입 포트가 필요하다. 사용자가 원문 보관 실행을 승인하기 전 상시 apply를 켜지 않는다.
- 성공 조건: 묶음 **모든** 메시지가 ARCHIVED이며 COMPLETED Source run, 동일 RAW payload/지문, 동일 관측 참조를 가진 ARCHIVED 사건 receipt를 새로 읽는다. 원문 JSON 및 첨부마다 유일한 eventId/sha256 파일·receipt 참조·다운로드 해시·경로·전체/상속 비공개 권한을 다시 확인한다. 이후만 `ACK_ELIGIBLE/deleteAllowed=true`. 제품 표시 HOLD는 원문 보관과 별개이며 사진 표시 완료를 뜻하지 않는다.
- 응답 `{inputDigest,status,deleteAllowed,issues}`에서 DRY_RUN/HOLD/UNKNOWN은 삭제 불가. CLI apply는 이 receipt를 출력하고 정리 불가면 exit 2다. 원문·파일 경로·공급사 이름·개인정보 없이 digest/사유 코드만 알림용 반환한다. 알림 실제 전송 포트는 연결하지 않았다.
- AI-OPS는 ACK를 Data 인증 경로에서 되읽고 **자신의 원본 digest와 동일한 묶음**에 한해 정리한다. 성공 exit만으로 삭제 금지. 부분 성공은 묶음 전체 보존, 보류/실패/연결 단절은 무기한 보존·격리하고 시간 기반 자동 삭제 금지. ACK 응답 유실은 같은 묶음 재대사; 업로드 응답 유실/lease 만료는 1단계의 검색·되읽기 규칙을 지킨다. JSON과 첨부를 공유하는 다른 pending 항목이 있으면 참조가 해소될 때까지 첨부 보존. 중앙 원본 삭제는 이 계약 범위 밖이다.

**Data 소유 실행 설계(문서 초안, 비활성):** 요청에 언급된 `.github/workflows/data-owned-refresh.yml:1`은 현재 `RETIRED` 안내로, 되살리지 않는다. 현행 `.github/workflows/shared-sheet-daily.yml:25` 이후의 Data 소유 concurrency(`freepass-data-production-delivery`), cancel-in-progress=false, 환경·target binding·승인 gate 패턴만 참고한다. 카톡용 workflow_ref에는 별도 최소 WIF/IAM 검토가 필요하며 기존 daily 신원을 자동 재사용하지 않는다. 이후 승인된 Data 실행기가 매일 정해진 수신 창 및 수동 재대사에서 같은 processKakaoQueue를 호출하도록 설계한다. 정확한 주기/신원/비공개 queue transport/멈춤 스위치가 확정되기 전 cron·repository_dispatch·workflow 파일을 만들거나 켜지 않는다. ERP4 예약 추가 금지. backlog의 가장 오래된 항목 나이·HOLD/UNKNOWN 수·마지막 중앙 ACK 시각을 감시하고, 상태 이상 시 신규 업로드 중단 및 비식별 알림을 반환한다. 일일 성공 여부만으로 나중에 들어온 새 묶음을 건너뛰지 않는다.

AI-OPS에 필요한 변경 요청(이번에 해당 저장소 수정 없음):
1. 같은 CLI envelope와 공통 메시지 ID/검증된 revision·원본 바이트를 만드는 capture, 비공개 atomic queue 게시 및 digest 계산.
2. 인증된 queue 읽기/ACK 되읽기 transport와 Data 실행기에게 필요한 최소 접근 범위. 공개 Actions artifact·로그에 원문/첨부 저장 금지.
3. 동일 digest의 ACK만 수락하는 정리기, 공유 첨부 참조 보존, 부분 실패 격리, 재시작 시 immutable 묶음 복원.
4. 반환 사유 코드를 기존 감시/알림에 연결하고 중복 경보를 digest 기준으로 묶기. HOLD 해제 전 맹목 재업로드 금지.
5. Data 실행 주기·일일 수신 마감/지연 경보 기준·중단 스위치를 확정하고 실제 transport/권한/되읽기 증거를 확보한 뒤 별도 활성화 검토.

### 2단계 — 공급사 원천 성향·관측 기반 시범 선택

`readSupplierSourceSummary`는 기존 SourceIngestionStore.getRun/getSource/listRaw만 사용한다. 저장 위치는 기존 `sources/source_runs/raw_records/source_event_receipts`; 별도 성향 DB/모음/사람 지정 우선순위는 없다. 성향은 읽을 때 계산하고 원본은 기존 모음에 그대로 보존한다. 호출자는 대상 기간의 run manifest를 주며 응답에 그 목록과 `PROVIDED_SOURCE_RUNS_ONLY`를 남긴다. 자동 전체 이력 검색은 미연결이고, 누락된 manifest를 전 공급사 관측 완료로 해석하면 안 된다.

계산은 `summarizeSupplierSources`: 최근 N일(1~365일, 경계 포함)에서 미래/오래된 사건을 제외하고 공급사코드+사건키로 중복 제거한다. 카톡은 원발송시각과 eventId 기준이며 PC별 재관측으로 수가 늘지 않는다. 검증된 표를 가진 메시지는 KAKAO_TABLE, 나머지 검증된 메모는 KAKAO_MEMO다. 시트는 공급사별 완료된 capture run 하나를 사건 하나로 센다(차량 행 수가 아님). API/기타도 관측 종류·최근 시각을 보존한다. kind 충돌은 오류, RAW 누락·미완료 run·격리/미검증 관측은 HOLD이며 시범 자동 선택을 막는다.

전체 관측 사건의 과반이 카톡 메모면 KAKAO_MEMO_PRIMARY, 시트면 SHEET_PRIMARY, 동률·표 중심·기타 중심은 MIXED_OR_INSUFFICIENT다. 사건수·종류별 수·최근 시각·기간을 함께 반환한다. API 관측이 있으면 `crossCheckObserved=true`지만 이는 홈페이지 존재/이용허가를 증명하지 않는다. 수집 주기가 다르면 비율도 달라지므로 **관측 성향일 뿐 field authority나 원천 우선순위를 변경하지 않는다**. 관측 0인 공급사는 누락/UNKNOWN이며 0 재고나 특정 성향으로 만들지 않는다.

`selectKakaoPilotSuppliers`는 최근 N일 카톡 고유 사건(메모+표)이 있는 공급사를 실제 도착 수 내림차순 → 최근 관측시각 → opaque 공급사코드 순으로 정렬해 limit개 반환한다. 특정 공급사 이름/코드를 선택 규칙에 넣지 않는다. 홈페이지는 이용약관·접근 허용 확인 전 수집 금지이며, 허용 후에도 한 건씩 교차 확인 근거로만 기존 Source 경로에 보존한다. API 관측에서 홈페이지 사실을 추정하거나 일괄 크롤링하지 않는다.

### 2단계 검증 및 남은 HOLD

- 변경: 1단계 기존 파일 6개(adapter/application/domain/job/port/시험)와 이 문서·NEXT-START-HERE, 총 8개. 신규 파일·규격 수정·워크플로 수정·운영 쓰기·커밋·푸시 없음.
- 가짜 포트 시험: 현행 비고 계획, 사람 값/공백/수식/링크 보존, 헤더·행·상품 불일치 HOLD, queue dry-run/여러 묶음/부분 실패/재시작/응답 유실/최종 되읽기·권한 실패, RAW 관측 중복 제거/시트 capture 단위/관측 변화/시범 선택을 검증했다. 최종 build PASS, 카카오33+기존 Source persistence4=37 PASS, diff 공백 검사 PASS.
- `npm.cmd run check`: 첫 실행은 추가 테스트의 exactOptionalPropertyTypes 오류로 build 실패했고 테스트 구성에서 undefined 속성을 제거해 수정. 이후 build·architecture·Data boundary·standards 검사(규격 상태 PARTIAL)·시트105·runtime smoke12·shadow10·dashboard21 단계 통과. 최종 전체 실행은 Vitest 1777 PASS / 9 FAIL / 14 SKIP, exit 1(카카오33 PASS 포함). 9건은 기존 CLI의 `uv_os_get_passwd ENOMEM`, jq Permission denied, read-pilot exit/JSON 오류, 로컬 서버 ECONNREFUSED다. 환경/기존 경로 실패를 기대값 변경으로 통과시키지 않았다. 후속 행 식별/알림 digest 방어 변경은 build·관련 시험을 다시 검증한다. 최종 추가 검증 수는 NEXT-START-HERE에 기록한다.
- HOLD: 독립 Claude 검토는 네트워크 금지로 UNAVAILABLE(호출 없음). 실제 queue transport/감시/ACK 정리 연결, Drive/Firestore 운영 권한과 트랜잭션, 상품→공통 시트 입력 exporter 결합, 비공개 링크의 실제 시트/ERP 화면, 정상 환경 전체 check가 남는다. 로컬 코드·계획 시험을 상시 운영/시트 표시 완료로 확대하지 않는다.
- next_start_here: 이 절과 같은 미커밋 diff를 지휘통제실에서 독립 검토하고, 네트워크 있는 환경의 별도 승인 절차에서 transport/권한·원문 보관·ACK 되읽기부터 진행한다. 원천 성향 manifest의 기간·공급사 coverage도 먼저 확정한다.

### CLI와 운영 실측 절차

입력은 비공개 JSON 하나: `{ "bundle": { supplierCode, roomId, collectorId, observedAt, messages }, "products": [...] }`. 타입 전체는 `src/adapters/kakao-source-intake.ts`와 `src/ports/kakao-archive.ts`. `messages`에는 messageId(또는 fallback 식별 근거), sentAt, text, captureVerified, version, attachments를 넣는다. 첨부는 bytesBase64/mediaType/role, 차량 대조는 원문 evidenceText와 식별자다. products는 `{id,data,supplierVehicleIdField?}`로 기존 공급사 차량 ID 필드를 명시한다. 공급사 ID 필드 이름을 임의 추정하지 않는다. 입력 파일/출력 계획/영수증은 공개 Git에 넣지 않는다.

```powershell
npm.cmd run ingest:kakao-source -- <비공개-묶음.json>
npm.cmd run check
# 이 샌드박스에서 tsx가 os.userInfo 오류이면, 빌드된 동일 CLI를 로컬 검증한다.
npm.cmd run build
node dist/src/jobs/ingest-kakao-source.js <비공개-묶음.json>
```

기본 실행 결과는 eventId·observationId·첨부 해시·Drive 경로/appProperties 계획·표 증거 수·products 대조/연결안이며 쓰기 0이다. 원문 본문/첨부 bytes는 출력하지 않는다.

운영 재개는 네트워크가 있는 승인된 환경에서 아래 순서로 공급사 1곳·사진 1대만 진행한다.

1. 실제 공급사/공통 방 식별, 메시지 revision, 사진 원문 귀속, 제품 snapshot digest, 비공개 Drive 루트와 전체/상속 권한을 확인한다. Drive 원본 생성·검색·다운로드와 Source Firestore read/create/transaction 권한, 기존 상품 writer 승인/소유권을 각각 확인한다. 인증은 기존 연결, Firebase는 `firebase-target.ts`만 사용한다.
2. `KakaoDriveArchivePort`의 실제 transport와 기존 Source Store/제품 read를 운영 composition root에 주입한다. CLI 함수 `runKakaoSourceCli(args, env, ports)`를 재사용하거나, 비공개 로컬 모듈의 `createKakaoPorts()` export를 `FREEPASS_KAKAO_PORTS_MODULE=<검토된-로컬-module.mjs>`로 지정한다. CLI는 승인+apply 확인 후에만 그 모듈을 로드한다. 카톡 JSON에서 실행 모듈을 지정할 수 없다. 포트 미설정이면 `HOLD_KAKAO_LIVE_PORTS_NOT_CONFIGURED`; `--apply`만으로 live ports가 만들어지지 않는다.
3. 검토된 원문 보관 실행에 한해 `FREEPASS_KAKAO_SOURCE_APPLY=approved` **및** `--apply` 둘 다 필요하다. `runKakaoSourceCli`의 주입 경로를 통해 Drive 업로드→다운로드 해시→RAW/영수증 되읽기를 증명한다. 이 승인으로 products는 쓰지 않는다.
4. 사진 plan의 현재 product 전체 digest/기존 photo_link를 재확인한다. 승인된 비공개 접근 경로의 ERP 표시/문서 미노출 증거로 HOLD를 해소한 뒤 기존 product writer port의 dryRun 결과 digest를 검토한다. `applyKakaoPhotoPlan`은 apply=true·approval=approved·동일 dry-run digest가 모두 있어야 port.apply를 호출한다. 실제 product adapter는 snapshot CAS·전후 이력·승인·쓰기 소유권·되읽기를 기존 경로에서 강제해야 한다. 적용 응답 유실은 재조회하며 자동 재실행하지 않는다.
5. products 사진 칸 되읽기, ERP 목록/상세에서 동일 사진 표시, 미로그인/다른 권한에서 원문 노출 여부를 확인한다. 표시 실패 시 공개 공유하지 않고 HOLD한다. 실패 복구도 당시 digest를 확인한 기존 writer를 통해 원래 사진 칸 값만 되돌리는 검토안을 사용한다.

남음: 실제 Drive transport/product writer adapter 연결, Firestore 실제 트랜잭션/권한, 비공개 ERP 표시·접근 검증, 운영 backup/readback, Claude 독립 검토. 원문/첨부가 일부만 업로드된 UNKNOWN 사건과 후속 revision의 새 첨부는 자동 lease takeover 없이 별도 대사/승인 재개가 필요하다. 소스 수집 승인은 상품 확정·시트 발행 승인이 아니다.

### 검증 기록

변경 파일(14개):

| 구분 | 경로 |
|---|---|
| 기존 Source 확장 | `src/application/ingest-raw-source.ts`, `src/ports/source-store.ts`, `src/infra/source-memory-store.ts`, `src/infra/source-firestore-store.ts`, `src/infra/firestore-layout.ts` |
| 카톡/Drive/사진 경계 신규 | `src/domain/source-event.ts`, `src/adapters/kakao-source-intake.ts`, `src/application/kakao-source-intake.ts`, `src/ports/kakao-archive.ts` |
| 실행/시험 | `src/jobs/ingest-kakao-source.ts`, `package.json`, `tests/kakao-source-intake.test.ts` |
| 인계 | `docs/NATIVE-SOURCE-COLLECTOR.md`, `docs/NEXT-START-HERE.md` |

- 2026-10-09 두 결함 수정(기반 `8e85637`, 커밋·푸시 없음): 사건별 선점 직전 주입 시계로 lease 계산·검사, stableValue로 보관 JSON 키 정렬. 6분 지연 후 다음 사건 보관·키 순서가 다른 두 PC 동일 해시/ACK·만료 후 재선점 금지 회귀 포함 카카오 36 PASS. `npm.cmd run check` 최초 시계 옵션 타입 누락 수정 후 재실행: build/선행 검사 PASS, Vitest 1780 PASS / 9 FAIL / 14 SKIP, exit 1. 기존 ENOMEM·jq 권한·로컬 ECONNREFUSED 환경 오류 및 read-pilot 4건 exit/JSON 실패(원인 분리 필요); 전체 PASS 아님. next_start_here: 정상 환경 전체 check 재검증.
- 재검토(Codex) 지적 «키 정렬로 바뀐 보관 해시가 예전 보관본과 맞지 않음»: 이 코드는 2026-10-09 기준 운영에서 한 번도 실행되지 않아 예전 방식 보관본이 0건이므로 호환 경로를 두지 않는다. 운영 첫 보관부터 정규 직렬화만 쓴다. 이후 직렬화를 다시 바꿀 때는 그때 보관본 호환·재처리 시험을 함께 넣는다.
- 카카오 전용 17 PASS, 기존 RAW 적재 4 PASS. 가짜 Drive/Firestore 포트로 두 PC(사건1·관측2), restart/응답 유실, 같은 문장 재발화, 같은 파일 재전송, PARTIAL 삭제0, 식별불명, 사진 매칭 성공/실패, 공개권한 거부, 최초/최신 참조, CSV 증거/lineage 및 재실행, 승인/CLI 경계를 검증했다. Firestore emulator/실서비스 통과라는 뜻이 아니다.
- `npm.cmd run check` 첫 실행은 신규 테스트 override의 반환 타입 오류로 build 실패. Promise<never>로 고친 뒤 build 및 관련 21개 시험 PASS.
- 두 번째 `npm.cmd run check`: **exit 1**. architecture/data-access 경계 PASS, standards 15 PASS(프로젝트 상태 PARTIAL 유지), sheets 105 PASS, build PASS, read-runtime 12 PASS, shadow 10 PASS, dashboard 7+14 PASS. Vitest **1761 PASS / 9 FAIL / 14 SKIP**, 파일 136 PASS / 4 FAIL / 4 SKIP.
- FAIL 원문: 이안카 CLI 2건과 runtime entrypoint 1건은 `uv_os_get_passwd returned ENOMEM` (`tsx`의 `os.userInfo`); runtime-policy 1건은 설치된 `jq: Permission denied`; read-pilot CLI 4건은 exit/JSON 결과 불일치(원인 분리 필요); vehicle-finder-route 1건은 `ECONNREFUSED 127.0.0.1` 환경 기동 실패. 기존 기대값·환경·스킵 조건을 바꾸지 않았다. 전체 PASS로 보고하지 않는다.
- 원격 fetch/Issue/PR 조회, Drive/Firestore/웹 실호출, 커밋/푸시/운영 쓰기 없음. Claude 검토는 이번 오더의 후속 검토 단계이며 실행하지 않았다.
- 별도 환경 확인: `node --import tsx -e ...`와 `npm.cmd run ingest:kakao-source --` 모두 같은 `uv_os_get_passwd ENOMEM`을 재현했다. 샌드박스 계정 조회 오류로 구분하며 tsx/기존 시험 기대값은 변경하지 않는다. 빌드된 동일 CLI의 가짜 JSON subprocess dry-run은 전용 시험에서 별도로 확인한다.
- 전체 check 이후 CLI의 승인 후 로컬 포트 모듈 주입, 사진 plan 링크/기존값 불변 검사와 적용 후 verified 응답 검사를 보강했다. 최종 build/관련21개 시험/diff 검사 PASS. 가짜 JSON을 사용한 빌드 CLI subprocess는 exit0/DRY_RUN/쓰기0을 확인했다. 전체 check를 최종 PASS로 바꾸지 않는다.

## Common supplier adapter contract — 2026-10-02

`src/domain/source-intake.ts` owns `SUPPLIER_SOURCE_ADAPTERS`,
`collectSupplierSource` and `inspectSupplierSourceBatch`. All transports return the
existing `SourceIntakeBatch`: source identity/kind, mapping/source revision, checksum,
upstream observation time, freshness requirement, scoped coverage, original records
and per-record fingerprints. Missing evidence, future/stale time or partial/unknown
coverage produces HOLD. An empty result also requires review, even with a declared
complete zero count; keep the original zero observation without approving retirement.
`RAW_READY` is RAW preparation only; it never approves
Canonical writes, publication, source absence or retirement. Existing source-head
decisions remain in `decideSourceHead`, not these adapters.

| Supplier | Adapter responsibility | Shared boundary |
|---|---|---|
| 손오공 RP012 | `sonogongSourceAdapter` reads LOW_SONOKONG_DAILY, LOW_SONOKONG and LOW_TCAR separately through an injected original API reader. Preserve list/detail, bucket, original term/option/photo fields; require matching product ID and plate. Missing detail/count mismatch stays partial. | Bucket-qualified RAW identity; oldest observation time; immutable original payload, digest and common evidence. Sheet projections do not replace original API inventory. |
| 이안카 RP031 | Existing ONE API auth, pagination, list/detail/term/conditions/photo attribution remain in `iancar-one-api.ts`. Direct-login pilot is inventory-only and has no term authority. Both collector commands now report the shared evidence contract. | ONE enriched facts deliberately keep UNKNOWN coverage, even with a complete vehicle list; the common report keeps HOLD without blocking existing approved per-field operations. |
| 웰릭스 RP013 | `welrixSourceAdapter` reads the approved Sheet/tab/range through an injected grid reader. Inventory and policy use separate calls/source IDs. Preserve headers and original cells, including unit text. | Binding/count/identity checks; duplicate inventory plates reject; repeated policy UID rows remain separate condition evidence. RAW row position is not a Canonical policy ID. |
| 아이카 RP004 | `aicaSourceAdapter` + injected rich-grid reader; `aicaSheetsGridReader` implements bounded Sheets GET using existing Data ADC. | Original cells/links + plate/tab/row evidence; ambiguities HOLD, photoState UNKNOWN. Fixtures only, no live transport invocation. |
| 아이언 RP006 | `ironSourceAdapter` + injected detail fetcher; retain original HTML, term tuples, deposit text and gallery references. | Nonstandard months/units preserved. Deposit UNKNOWN; designated details PARTIAL; no network implementation. |

Authentication and network transport remain in the provider reader. The newly added
Sonogong/Welrix adapters are executable RAW transformations with injected read ports,
**not yet wired to native live transport, CLI or schedules**. Do not claim a live
supplier refresh from their fixture tests. Implement the authorized original API/Sheets
readers against these ports and verify real source metadata/schema before rollout;
unknown freshness thresholds must not be invented. Native Data has no replacement
writer activated by this change. Current operational publisher and schedules are unchanged.

The collector does not parse `10` into money or a rate. Later reviewed normalization
must record unit (원/만원/%), basis, rental period, contracted mileage, product/return
variant and policy effectivity using the [business dictionary](COMMERCIAL-DATA-CONSUMER-ROLLOUT.md#policy-dictionary).
Blank, zero, unknown and prohibited remain different. Sonogong amount rounding and
deposit rules belong to reviewed product normalization, never a generic RAW converter.
The same vehicle may occur in different Sonogong product buckets. Preserve those
separate RAW product observations; reviewed VehicleAsset linking must resolve shared
vehicle identity and contradictory product facts. Do not discard a product variant
or merge rental/subscription terms because the plate is shared.
RAW record count is product-observation count, not a distinct vehicle/fleet count.
The zero-record gate applies to the whole declared batch scope. A successfully
observed, declared-zero product bucket alongside other nonempty buckets is not a
failed request and does not delete any vehicle; a failed read still rejects the whole
collection. Per-bucket operational admission remains a rollout decision.

Reuse: existing intake/store/ONE adapters are COMPOSE_OR_EXTEND. A native RAW adapter
file was CREATE_NEW_JUSTIFIED after reuse search and Academy READY: no existing Data
Sonogong bucket/detail or Welrix cell-to-intake adapter existed; the frozen legacy
engine is incompatible with current ONE-owned inventory. No new store or engine repository.

<a id="supplier-direct-status"></a>

## 직접 연동 공급사 현황 — 2026-10-03

### 오더 4 — 전 공급사 수집 중계 일반화 (PR #288, 운영 HOLD)

- 최신 구현은 `supplier-relay.ts`, `supplier-relay-transport.ts`, `serve-supplier-relay.ts`, `serve:supplier:relay`다. Cloud Run `supplier-collect-relay`, SA `supplier-relay-runtime`/`supplier-relay-scheduler`, `SUPPLIER_RELAY_*`, `supplier-relay/v1/`를 사용한다. 아래 오더2/과거 설계의 factory-only·App 발급 설명은 당시 이력이며 현재 구현 근거가 아니다.
- `SUPPLIER_RELAY_ALLOWLIST`의 job 이름만 받으며 본문 `{}` 고정. iancar-15m과 hourly-all은 writer 그룹 pending 하나를 공유한다. hourly-all은 자동 회차와 같은 이안카 fresh sync를 요청할 dispatch 조합이 없어 HOLD 정의만 둔다.
- dispatch 후 자기 run을 제외한 미완료 run 재조회, 겹침 UNKNOWN/OVERLAP 및 pending 유지, cancelled/실패 자동 재전송 금지. ERP4 cadence 조회와 queue 입장은 원자적이지 않다. Scheduler 확인 후 ERP4 cron 제거는 별도 승인이다.
- `/verify`는 OIDC 인증·config·기존 Secret 읽기·GCS 읽기·GitHub 목록 읽기만 수행한다. selftest는 별도 prefix의 조건부 생성 **쓰기1건**이다. 이 검증과 모든 HOLD 해소 전에 Scheduler resume 금지.
- 항목별 `supplier-relay-status/v1`과 필수 exact-object pending CAS IAM, yml revision/줄 근거, 운영 절차는 [공급사 수집 중계 배포 절차](deploy/supplier-collect-relay-배포절차.md)를 따른다. 상태는 회차별 create-only 새 파일(이름순=시각순)이라 덮어쓰기 권한이 필요 없다.
- 검증: 관련51 PASS, 전체 check 빌드 통과 후 Vitest1210 PASS/9 FAIL/14 SKIP(환경 오류 별도 인계). 원격 yml 읽기는 네트워크 차단, 로컬 ERP4 origin/main `094155bd`만 확인했다. Claude 독립 검토는 `CLAUDE_PROCESS_FAILED`로 미검증.

### 오더 2 — Data native 수리 (코드만, 운영 미적용)

- 결정: **ERP4 최소 diff 미채택(Data native로 이관)**. 아래 진단과 과거 diff는 이력이며 고정 엔진을 수정하지 않는다.
- 대상: `work/freepass-data/supplier-native-fixes-20261003`, 기반 `5b1d430d7f6e465a7a6379de1a59754286025264` (PR #287 문서 위). 이 checkout만 수정, commit/push 없음. git/gh 네트워크는 차단됐으나 GitHub connector로 Issue #24, PR #287 merged, main `21f1511878efc9fe8a9fc664142c3d2f552a1031`을 확인했다. open PR 검색 0건. 기반 대비 main의 추가 변경은 공동 시트 dropdown 관련 4파일로 이번 변경과 겹치지 않는다. main merge/rebase는 하지 않았다.
- 재사용: `reuse:check` 검색 후 `CREATE_NEW_JUSTIFIED` PASS. `supplier-source-capture.ts`, `SourceIntakeBatch`, 공통 검사와 기존 테스트는 COMPOSE_OR_EXTEND. 새 `src/infra/aica-sheet-reader.ts`는 기존 values/presentation reader가 공급사 rich-cell RAW 계약을 제공하지 않아 분리했다. 인증은 기존 Data ADC 해석 경로와 `firebase-target.ts::resolveTargetProject`를 재사용하며 Firebase app을 추가하지 않는다. 새 `src/api/supplier-relay.ts`는 기존 수집/발행 writer와 다른 HTTP 입장 제어 책임이며 해당 서비스가 없어 신규 정당화했다. 영수증은 주입 포트뿐이고 두 번째 source store가 아니다. 새 fixture 테스트는 실제 사이트/운영 접근 없이 이 두 경계를 검증하기 위한 것이다. 수정 전 Academy READY(11:15:42Z); 신규 인자를 붙인 재조회(11:25:30Z)는 이번 변경 자체의 dirty 경고 `DIRTY_WORKTREE_REVIEW_REQUIRED`로 HOLD였다. 최초 clean 상태 및 본 작업 diff를 재확인했고 타 작업 변경 없음; clean 재실행을 위해 commit/reset하지 않았다. 재조회 HOLD를 READY로 기록하지 않는다.
- RP004: `aicaSourceAdapter`는 승인된 복수 탭의 grid reader 패턴을 재사용한다. 셀의 typed/formatted/formula 값과 hyperlink / textFormat.link / textFormatRuns 링크를 그대로 보존한다. RAW ID는 sheet+tab+physical row+원문 plate 조합이고 Canonical PK가 아니다. 빈 plate, 정규화 비교상 중복 plate, 여러 plate가 공유한 URL, 알려진 단축 URL은 `captureIssues`와 공통 HOLD. 모든 링크의 `photoState=UNKNOWN`, `image_urls`로 승격하지 않는다. 알 수 없는 단축 서비스도 사진으로 승인되지 않는다.
- Sheets transport: `spreadsheets.get(includeGridData=true)` + 최소 fields + 승인된 A1 범위만. 단일 응답의 sheet/tab/offset/크기를 확인하며 리디렉션·재시도 없음. 기존 ADC에 Sheets 읽기 scope/원본 권한이 없으면 HOLD(새 키 생성 금지). HTTP 읽기 시각은 공급사 변경시각이 아니며 reader는 `complete=false, expectedRows=null`; live 연결·전체 재고/신선도 증명은 별도다.
- 인증 의존성: lockfile에 이미 있던 `google-auth-library@10.9.1`을 직접 의존성으로 선언했다(기존 transitive version/integrity 유지). Firebase 기본 Cloud scope를 Sheets 권한으로 오인하지 않고 같은 ADC에 `spreadsheets.readonly`를 요청한다. 사용자 ADC의 기존 grant가 부족하면 재로그인/새 키 없이 HOLD한다. [Sheets scope](https://developers.google.com/workspace/sheets/api/scopes), [ADC 동작](https://docs.cloud.google.com/docs/authentication/application-default-credentials). offline npm 설치는 metadata cache 부재 `ENOTCACHED`; package/lock root 선언만 일치시켰으며 clean install 검증은 미실행이다.
- RP006: ERP4 `fe3eccc:lib/server/ironrentcar-source.ts`의 선택자만 참고한 Data 독립 RAW 추출기. 원본 HTML과 기간 tuple의 `periodRaw/rentRaw/htmlRaw`, 보증금 원문 배열+`UNKNOWN`, gallery `img[src]` 원문 배열을 보존한다. 72/84/53개월을 표준기간으로 압축하지 않으며 원/만원을 숫자로 바꾸지 않는다. 이미지 proxy/상대 URL도 RAW 그대로이며 페이지 URL로 대체하지 않는다. 파서는 명시적 닫는 태그 형태의 제한된 extractor이고 브라우저의 HTML 자동복구를 구현하지 않는다. 구조 불일치/번호 귀속 실패는 HOLD. 실제 HTML 적합성은 미검증.
- RP006 포트: `IRON_DETAIL_REQUEST_LIMITS={concurrency:2,requestsPerVehicle:1}`. 명시된 고유 id/plate의 상세만 순차 1회, 실패 재시도/목록 탐색 없음. 실 fetch transport는 제공하지 않는다. 범위는 항상 PARTIAL/UNKNOWN; supplier full inventory나 요금 완전성으로 승격하지 않는다.
- RP031: private Cloud Run용 Fastify 서비스 **factory만 구현**, import/listen/운영 부작용 없음. OIDC 검증, Secret Manager 기반 App 설치 토큰, GitHub 조회/dispatch, durable receipt는 모두 필수 주입 포트다. 고정 repo/workflow/ref/입력만 사용하고 HTTP body는 `{}`만 허용한다. jobName+UTC scheduleTime SHA256 create-only 영수증과 schedule key 간 원자적 pending admission을 모두 요구한다. BUSY는 skip, 실패·응답 불명확·run ID 없는 응답은 UNKNOWN이며 재전송하지 않는다. ACCEPTED_PENDING도 run 완료가 아니다. 다음 tick은 기존 accepted run ID의 확정 종료를 조회하고 완료 증거+owner CAS 해제 후에만 새로 입장한다. UNKNOWN/RESERVED는 시간 만료나 단순 run 목록 IDLE로 풀지 않으며 별도 대사 전까지 후속 회차를 막는다.
- 영수증 포트 구현 조건: 기존 비공개 receipt storage를 재사용하고 create-only/CAS 및 owner 검증을 구현해야 한다. 이 작업은 durable backend를 생성/연결하지 않았다. `max-instances=1/concurrency=1`만으로 중복 방지가 된다고 주장하지 않는다. pending 해제는 해당 run의 확정 종료 또는 확정 미전송 증거가 있어야 하며, 모호한 전송은 자동 해제 금지. 기존 workflow precheck→queue 경합은 여전히 rollout HOLD.

### 손오공 RP012 Data runtime 계정 주입 — DESIGNED ONLY

기존 GitHub `SONOGONG_ACCOUNT_JSON`과 **같은 계정 값**을 유지하고 새 계정/키를 만들지 않는다. 값 조회·복사·출력은 이번 작업에서 하지 않았다. 이안카 ONE의 `freepasserp5` Secret Manager `freepass-data-iancar-one-api` 패턴을 재사용해 손오공 전용 secret의 승인된 버전을 runtime에 주입한다(제안 이름 `freepass-data-sonogong-account`, 존재/생성 미확인). ONE secret 자체에 덮어쓰지 않는다. GitHub secret은 readback API가 없으므로 승인된 원 보관자가 비출력 경로로 동일 값을 공급하고 계정 일치 검증을 맡는다. 공개 문서/명령행에 값 또는 그 digest를 남기지 않는다.

Data RP012 전용 runtime SA **한 개만 accessor**로 지정하고 그 secret 하나에만 `roles/secretmanager.secretAccessor`; 프로젝트 전체 권한 금지. 기존 ERP4 경로는 유지하며 Data native writer를 활성화하지 않는다. 로그인 transport의 단일 accessor가 계정 주입을 받아 8시간 토큰을 프로세스 메모리에만 보관한다. 토큰 만료 전에 single-flight 갱신, 재시작 시 재로그인, 로그/파일/RAW/Firestore/공유 cache 영속화 금지. 만료·갱신 실패는 HOLD/last-good 보존이며 빈 수집이나 0 보증금으로 바꾸지 않는다. 계정 교체·권한·운영 연결은 별도 승인 후 검증한다.

### 공급사 문의 목록 — 발송하지 않음, 현재 수신 방식 유지

아이언 RP006과 오토플러스 RP023은 공개 화면 수집 규칙을 확인하지 못했다. 기존 방식은 유지하고, 각 공급사에 아래 항목으로 공식 API 또는 공유 Sheet/정기 파일 제공 가능 여부를 문의할 초안이다.

1. 허용 접근 방식(API 문서·읽기 전용 계정·시트 공유), 사용/재배포/사진 이용 허용 범위, 요청 주기·동시성·제한과 변경 통지 창구.
2. 고유 상품 ID·차량번호 귀속, 재고/예약/출고/판매완료 상태 원문, 기준시각·수정시각, 전체 목록과 변경/삭제 구분.
3. **기간별 월대여료·보증금·약정거리**: 비표준 개월수 포함, 원/만원·VAT, 무보증/미정/협의/0 구분, 월/연거리 기준, 반납/인수형과 효력일·예외조건.
4. **사진**: 차량별 대표/상세 배열, 원본 URL·접근 만료·권리·공유 URL 여부, 상세 페이지 주소와 이미지 주소 구분.
5. 미제공 필드의 공식 의미, 오류/누락 신고와 revision별 대사 방법. 내부 청구/지급 수수료는 별도 허용 원천 확인 전 UNKNOWN.

### 운영 반영 전 남은 단계 — 오더3, 운영 실행 금지

오더3는 concrete transport/명령과 mock 검증까지다. 아래가 현재 rollout 기준이며 아래쪽 오더1의 App 설계는 역사 자료다. 토큰 발급·Secret 저장 절차는 경영지원실 소관으로 이 문서에 싣지 않는다.

1. 독립 검토와 정상 환경 전체 `npm run check`를 완료한다. 이 환경에서는 기존 9개 테스트가 `uv_os_get_passwd ENOMEM`/jq 권한/로컬 서버 연결 오류로 실패했다. 새 transport를 포함한 전용 검사는 통과했지만 전체 통과나 운영 검증으로 확대하지 않는다.
2. 중계의 환경변수 binding(audience·Scheduler SA email·jobName·기존 private evidence bucket·기존 단일 Secret 이름/버전)을 운영 담당자가 검증한다. 기본 열쇠는 고정 저장소 하나의 Actions 쓰기 전용 fine-grained PAT이며 `actionsToken` 포트가 메모리로 읽는다. 실제 권한 범위는 mock으로 증명되지 않는다. 중계에는 Firestore/Sheets/ONE 권한을 주지 않는다.
3. 기존 bucket의 `supplier-relay/v1` namespace와 최소 권한을 검토하고, 별도 승인 환경에서 immutable receipt/outcome/completion의 create-only와 writer 그룹별 pending 객체의 generation CAS를 검증한다. pending은 삭제하지 않고 빈 상태도 CAS로 기록하며 lease 만료가 없다. RESERVED/UNKNOWN 장기 보류와 응답 유실은 별도 대사 대상이다. 실제 GCS persistence·동시 인스턴스·장애 복구/수동 해제는 HOLD다.
4. `serve:supplier:relay`의 image/startup·OIDC·정확한 repo/workflow run 조회·`return_run_details=true` 응답 계약을 승인된 환경에서 확인한다. 페이지 잘림/404/응답 run ID 누락은 UNKNOWN, dispatch 재시도는 없다. 현재 고정 입력은 실제 반영이므로 최초 read-only 검증은 `/verify` 경로만 사용한다. 배포/IAM/Scheduler 생성·설정·dispatch는 별도 승인 전 금지다.
5. `source:aica:capture`의 승인된 탭/range binding과 읽기 권한, 원문 귀속·신선도·전체성 근거를 확인한다. 기본 출력은 counts/digest/issues뿐이다. `AICA_RAW_INGEST_APPROVED=true`와 `--apply-raw`가 함께 있어도 공통 RAW_READY 검사를 통과해야 기존 SourceIngestionStore 경로로 들어간다. 현재 Sheets reader는 FULL coverage를 증명하지 않으므로 실제 RAW 저장은 HOLD다.
6. 아이언은 공개 화면 규칙과 대상 차량을 먼저 확정한다. `IRON_FETCH_APPROVED=true` 없이는 robots 요청도 하지 않는다. reader는 명시적인 wildcard 허용 robots만 보수적으로 수용하며 제한/미지원 규칙/조회 실패는 HOLD다. 승인 시에도 동시 2 이하·차량당 1회·명시 User-Agent·리다이렉트 금지를 유지한다. 실제 원문/요금/사진 귀속과 전체성 검증은 별도다.
7. 기존 writer를 유지한 채 hourly admission 경합·중복 전달·crash/pending·source stale/last-good와 F01/F86/등록 소비처 readback을 별도 승인 후 검증한다. 중계 접수는 갱신 성공이나 native cutover 증거가 아니다. rollback은 새 Scheduler 중단과 pending 증거 보존이며 운영 writer 전환이 아니다.

### 오더 2 검증 기록

- `node node_modules/vitest/vitest.mjs run tests/source-intake.test.ts tests/supplier-native.test.ts`: **45 PASS** (기존 계약17 + native28). 셀 값/3종 링크/원문 불변성, 복수 탭의 중복·빈 번호·공유·단축 링크와 PARTIAL gate, 최소 GET/오류/기존 ADC scope, 72/84/53개월·원/만원·UNKNOWN 보증금·HTML 오귀속, 요청 1회 제한, 중계 동시 admission/중복/기존 run BUSY/확정 종료 후 후속 회차/완료 CAS 실패/응답 유실/영수증 실패/고정 입력/인증/HTTP route 검증.
- `npm.cmd run build`: PASS. `npm.cmd ls google-auth-library --depth=0`: 기존 10.9.1 일치. `git diff --check`: PASS. 초기 fields 괄호/infra→adapter 타입 의존/테스트 타입 오류는 수정했고 기대값 완화 없음.
- `npm.cmd run check`: **exit1, Vitest 1,187 PASS / 9 FAIL / 14 SKIP** (Codex 샌드박스 환경 오류; Claude 정상 환경 재실행 exit0, Vitest 1196 PASS / 14 SKIP). 아키텍처, standards 검사(exit0, 기존 capability 상태 PARTIAL), Data Access boundary, 시트52, build, read-runtime smoke6, shadow10, dashboard21 통과. 실패는 기존 `iancar-source-capture`2 / `read-pilot`4 / `runtime-policy`2 / `vehicle-finder-route`1의 샌드박스 경로에서 발생했다. `uv_os_get_passwd ENOMEM`, jq `Permission denied`, local server `ECONNREFUSED`를 원문 그대로 유지; 관련 기대값/skip/환경을 바꾸지 않았다. 정상 실행 환경의 전체 check 재검증은 HOLD.
- Claude: `claude:status`는 사용 가능이었으나 `claude:review`가 `FAILED / CLAUDE_PROCESS_FAILED`(exit1, 답변 없음). 독립 검토 **UNAVAILABLE**, AI 합의/GO로 세지 않는다.
- live source 요청·Firestore/시트 쓰기·IAM/Scheduler/Cloud Run/secret/var 변경·dispatch·ERP4 수정·commit/push **0**. native RAW persistence와 실제 사이트 HTML/셀 귀속, 중계 concrete ports 및 정상 환경 전체 검사, 독립 검토, 운영 배포/cutover는 HOLD.
- next_start_here: 이 절의 오더2와 `tests/supplier-native.test.ts` → 정상 환경 전체 check/Claude 독립 검토 → 별도 승인된 원문 readback과 포트 wiring 검증. 권한/생성/dispatch는 「승인 후 실행」의 별도 게이트를 통과한 뒤에만 수행한다.

### 범위와 증거 수준

- 목적: 공동 시트 밖 5곳의 누락 원인과 기간별 계산 입력을 점검한다. **진단 일부 확인 / 원천 대사 일부 HOLD / 운영 수리 미적용**이다.
- 작업 정본: `work/freepass-data/supplier-direct-integration-20261003`, Data `e4dcee5446e70f7342f1bcdc25b170d8aca077d0`. GitHub connector로 main이 같은 revision임을 확인했고 open PR 검색 결과는 0건이었다. Issue #24의 데이터 플랫폼 경계를 유지한다.
- 읽은 운영 코드: ERP4 engine `fe3eccc0173cb581e71a5a963bb7f28d3715b14f`의 Git 객체만. ERP4 main workflow는 `094155bd8e03a4269654a45b2eac6237a7796ad1` 관측, engine pin `fe3eccc`, Data RP031 실행기 pin `4917f2a79c0ab41d83dee745c8645bf810934f98`. ERP4 checkout 수정 없음.
- [회차 37110200131](https://github.com/freepass-creator/freepasserp4/actions/runs/37110200131)의 job `111166453368` 로그/단계 성공을 직접 재조회했다. 아래 시각은 **이 회차의 단계 완료 시각**이며 공급사 자체 갱신시각이나 현재 최신 성공 회차를 뜻하지 않는다. 오늘 cron 횟수·08:59 실패는 사용자에게 전달된 Claude 실측으로, 이번 전체 run 목록 재감사는 하지 않았다.
- 2026-10-03 원본/시트 connector 읽기: RP004 원본 `RP004 원본 시트(ID는 비공개 ai-ops 문서)`, F86 `F86 시트(ID는 비공개 ai-ops 문서)`. 원본 fetch 응답 modified_time `2026-10-02T08:27:25.994Z`; 셀 재조회는 비원자 읽기이므로 그 시각으로 전체 셀 버전 일치를 보증하지 않는다. 광역 export의 텍스트에는 링크 메타데이터가 없어 사진 판정에 사용하지 않았다.
- 웹 도구의 두 공급사 robots.txt 접근 실패, Chrome 아이언 robots.txt `ERR_BLOCKED_BY_CLIENT`. 규칙을 확인하지 못해 홈페이지 차량 상세 요청은 **0회**. 로그인·키 입력·원본 이미지 다운로드·단축 URL 전개 없음. 공개 접근 실패를 공급사 원천 공백으로 간주하지 않는다.

| 공급사 | 방식 | 지금 연동 상태 | 마지막 수집 시각 | 빠진 칸 | 문제 | 다음 할 일 |
|---|---|---|---|---|---|---|
| RP031 이안카 | ONE API → Data 실행기, ERP4 workflow가 임시 구동 | 위 회차 Data 반영 단계 success; 08:59 stale 실패는 Claude 실측. 15분 cadence HOLD | 위 회차 완료 08:51:39Z; 공급사 syncedAt **08:44:21.289Z** | 내부 청구/지급 수수료; 정책 완전성/기간 경제조건 연결 미검증 | 트리거 누락과 공급사 stale은 별개. UNKNOWN coverage/last-good 보존 | 아래 Scheduler 설계 검토, fresh source 관측과 소비처 대사 |
| RP012 손오공 | ERP API 비밀번호 로그인/8시간 토큰 → 기존 덤프/ingest | 기존 운영 변동 반영 success; Data native는 RAW port만, live transport 없음 | 위 회차 변동 반영 완료 08:41:30Z; upstream 관측시각 별도 미확인 | term별 약정거리·단위/효력·내부 수수료 연결 | 구독38/픽업141은 위 로그의 source 관측 범위. 옵션 HOLD0은 Claude 실측 | 원본 API reader를 Data port에 연결할 때 버킷/반납·인수형/보증금 원문 보존 |
| RP006 아이언 | 홈페이지 HTML → 기존 parser → mirror rows → ingest | 기존 변동 반영 success; Data native adapter 없음 | 위 회차 완료 08:41:20Z; 원천 페이지 시각 미확인 | 장기요금 5대; 사진 링크 13/17 미연결(Claude 실측) | 사진 배열 전달 단절 확인. 장기 기간 손실 경로 확인, 해당 5대 원인 확정은 HOLD | 규칙 확인 가능한 환경에서 대상별 상세 1회 이하, 동시2 이하로 원문/파서/원자 대사 |
| RP023 오토플러스 | reborncar 홈페이지 세션/상세 API | 기존 전용 수집기 success; Data native adapter 없음 | 위 회차 완료 08:44:51Z; 원천 자체 시각 미확인 | term별 확정 보증금·내부 수수료·정책 효력 근거 | 로그의 갱신38과 source 관측37은 다른 범위. 링크37/37은 Claude 실측 | term×연거리 원문과 보증금 정책을 같은 revision으로 대사 |
| RP004 아이카 | 공급사 자체 원본 Sheet | 기존 변동 반영 success; Data native adapter 없음 | 위 회차 완료 08:41:10Z; 이번 셀 읽기는 수집 실행 아님 | F86 사진 링크42/82 미연결을 재확인; 6대는 원본 링크 존재 | values-only reader가 셀 링크를 누락. 원본 미매칭33대 별도 HOLD | 원본 셀 링크와 차량 귀속을 RAW에 보존하고 현재 원자/F86 대상별 재대사 |

### a. 아이언 장기 요금 5대

해당 회차 08:52:07Z 로그에서 사용자 지정 5대가 장기요금 없음으로 출력됨을 재확인했다. 차량 식별자는 공개 문서에 재복제하지 않고 원래 오더/권한 있는 실행 로그로 추적한다.

정적 증거는 서로 다른 세 단계다(모두 engine `fe3eccc`):

1. `lib/server/ironrentcar-source.ts::parseIronRentcarDetail`은 `.product-detail-rent-row`의 dt에서 기간, dd에서 원/만원 금액을 읽는다. 어떤 기간도 양수로 읽지 못하면 `기간별 대여료 없음` 오류다. 성공한 파서가 장기 요금까지 읽었다는 뜻은 아니다.
2. `lib/domain/mirror-iron-source.ts::rowsFromIronCatalog`의 표준 기간은 `1,12,24,36,48,60,72,84`. 그 외 기간(예:53개월)은 `기타기간③` 문자열로 바뀐다. 이후 `scripts/ingest-supplier-to-firestore.mts::PERIOD_ALIAS`는 `1,6,12,18,24,36,48,60`만 읽으므로 **72/84개월 및 기타기간은 전달 손실 가능**하다. 원본에 장기요금이 있어도 이 경로로 없어질 수 있다.
3. F86 규격은 24개월 이상 요금을 표시한다. 단기만 제공된 차량의 장기 칸이 비는 것은 규격과 일치한다. 그러나 5대가 단기만 제공하는지는 이번에 원문을 못 읽어 확인하지 못했다.

**판정: 5대 각각 `UNKNOWN / HOLD_SOURCE_EVIDENCE`.** 지금은 `원천 미제공`으로 확정하지 않는다. 다음 관측에서 장기 원문 부재가 입증된 경우에만 `모른다(원천 미제공)`로 기록하고, 원문에 존재하면 파서 선택자/기간 변환/원자/발행 중 손실 지점을 분리한다. 0원이나 인접 기간 요금으로 보충하지 않는다.

### b. 아이언·아이카 사진

**아이언 — 전달 결함은 확인, 13대 전부의 원천 유무는 미확인.** 상세 파서는 `.product-detail-gallery img[src]`에서 `image_urls`를 수집하고 Next image URL을 원본 주소로 풀지만, mirror는 사진 대신 상세 HTML 주소를 `사진링크` 문자열로 내보낸다. 이어지는 iron `readRows`는 그 링크와 `image_urls` 모두 Row에 전달하지 않는다. `photoAtomFields(row.imageUrls, ...)`까지 도달할 배열이 없다. 또 `sheetPlateLink`의 배열→ERP 갤러리 연결 대상은 RP012/RP031뿐이라 **수집 배열만 복구해도 RP006 시트 링크는 자동 복구되지 않는다**. 기존 4개 링크는 이번 수집 성공의 증거가 아니다. srcset/lazy 이미지 대응 여부도 실제 HTML 대조 전에는 확정하지 않는다.

**아이카 — 원본 셀 링크 누락 6대의 구체적 증거를 확보했다.** 원본 3개 재고 탭 `장기특별이벤트`(gid1492960151), `중고재렌트`(gid742390595), `신차선출고`(gid1795760937)의 `A1:AA1` 헤더에는 사진 열이 없다. 하지만 `A1:C1160`, `A1:C1011`, `A1:C1005`의 차량번호 C열 `userEnteredFormat.textFormat.link.uri` 등에 링크가 있다. 실제 plate 행 중 링크 행은 각각68/29/1이며 **합계를 운영 재고 대수로 사용하지 않는다**(중복/상태/옛 행 포함). 호스트는 moderentcar, Drive, bit.ly, tinyurl이며 링크 존재가 사진의 귀속·접근 가능성을 보증하지 않는다.

F86 `아이카 82대`(gid529956002)의 헤더 `A1:AL1`, 차량번호 `D2:D113`을 새로 읽고 원본 C열과 정확한 차량번호로 대조했다:

| F86 사진 링크 없는 42대의 분류 | 결과 | 해석 |
|---|---:|---|
| 원본 3개 탭에 동일 차량번호와 링크 존재 | 6 | 원본→운영 전달 누락 확인. 차량별 URL은 private 원본에서 재조회 |
| 원본에 차량번호 있으나 링크 없음 | 3 | 조회한 셀 기준 원천 링크 미제공. 다른 원천에 사진 자체가 없다는 뜻은 아님 |
| 조회한 원본 3개 탭에 차량번호 없음 | 33 | HOLD_SOURCE_MEMBERSHIP. 옛 행/다른 탭/시점차/retire 처리 조사 필요 |

운영 `resolveCols`/sheet `push`에는 사진 필드가 없으며 `lib/server/google-sheets.ts::readSheetGrid`는 `values.get(FORMATTED_VALUE)`만 읽어 셀 링크를 보존하지 않는다. `restore-aica-origin-photo-urls.mts`의 과거 "사진 열 없음"을 "사진 링크 없음"으로 해석하면 틀린다. 그 파일의 과거 백업/사진 복원 코드는 실행하지 않았다. 특히 공유 상세 URL이나 단축 URL을 검증 없이 차량사진으로 채우지 않는다.

### 기간별 계산 입력 대조 — 원문 수집 능력과 Canonical 연결은 별개

정본은 `src/domain/catalog.ts`의 `PriceTerm`/`OfferTermEconomics`, `contracts/product-condition-pricing-v1.schema.json`, `contracts/offer-commercial-terms-v1.schema.json`. `termKey`별 개월수·KRW 월대여료·보증금 상태와 연거리, 계산의 단위·기준액·sourceRefs를 유지한다. 청구수수료(공급사→FreePass)와 지급수수료(FreePass→영업채널)는 별도 원천이다. 5곳의 inventory 성공만으로 두 수수료가 수집됐다고 선언하지 않는다.

| 공급사 | 기간 개월수 / 월대여료 | 약정거리 | 보증금 | 단위·기준·빠진 계산 입력 |
|---|---|---|---|---|
| RP031 | ONE `rental_period`, `monthly_rate`; Data term×거리 키 보존 | `contracted_mileage` + `mileage_period` month/year 명시 | rate별 `deposit`, KRW/0 구분 | currency/VAT 검증 있음. 월거리를 연거리로 바꾸는 정책 연결·FULL coverage·두 수수료/sourceRefs는 별도 HOLD; ONE 허용 범위에 내부 수수료 없음 |
| RP012 | estimates의 RENT/SUBSCRIBE RETURN/BUYOUT 기간별 월납; 기존 경로 천원 반올림 | 현 Row의 `km`는 차량 누적 주행거리여서 약정거리 대체 불가 | 중고렌트 RENT_* ERP 원값; 구독/픽업은 월납×약정연수(최대3개월) 규칙 | legacy `deposit=0` 표현을 Canonical ZERO로 복사 금지. RAW 금액·반올림·상품 버킷·규칙 근거를 함께 보존. 약정거리/수수료/효력 연결 HOLD |
| RP006 | HTML 기간별 rent 원/만원 파싱; 중간 표준기간 변환에서 손실 가능 | parser policySnapshot `annual_mileage` 텍스트, iron Row로 전달되지 않음 | 상세 deposit 단일 값을 각 기간에 복제; 미해석도0이 되는 legacy 위험 | 단위/기준 원문과 UNKNOWN 구분 필요. 내부 수수료 수집 없음; 조건별 가산/효력/Catalog 연결 HOLD |
| RP023 | `rentPriceObjs`의 rentMonth×rentPrice2/3, originPrice2/3; 키 `_20000`/`_30000` | 연2만/3만 축 보존 | mapCar price에 deposit 없음; 약관 규칙과 기간별 확정액은 별도 | KRW/VAT/기간별 보증금 근거·차량가격 기준 수수료·조건 적용성 대사 필요. 공통 옵션 목록을 차량 선택옵션으로 확정 금지 |
| RP004 | 이번 헤더 월렌트/36/48/60, 운영 PERIOD_ALIAS로 수집 | 원본 `연주행` 존재; inventory Row에는 연결 안 됨 | `장기보증`; 원문 무보증/협의와 빈칸을 구분해야 함 | `sheetPrice`는 빈칸을0, 숫자 제거 함수는 단위/혼합표기 손실 가능. 수수료 탭 존재만 metadata 확인; 내용·효력·청구/지급 방향은 미검증 |

`product-condition-pricing-v1`의 dimension/sourcePolicyKeys와 adjustment rule의 source·priority는 inventory 숫자만으로 채울 수 없다. 정책·보험·연령·주행 가산과 예외/효력은 검토된 원문으로 연결한다. `offer-commercial-terms-v1`의 defaultMileage는 POLICY 근거가 있어야 KNOWN이며 odometer/관행값으로 채우지 않는다. `internalEconomicsTerms`의 FIXED/MULTIPLY/RATE 및 MONTHLY_RENT_X_TERM/VEHICLE_PRICE 기준이 빠지면 UNKNOWN/HOLD. 어떤 공급사도 이번 점검으로 경제조건 완전성 PASS가 된 것은 아니다.

### c. 이안카 15분 트리거 최소 설계 — DESIGNED ONLY

관측된 문제는 GitHub schedule 전달 누락이다. [GitHub 공식 문서](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)도 지연/드롭 가능성을 명시한다. 공급사 `stale=true`는 트리거를 옮겨도 해결되지 않는다. 15분은 **호출 목표**이며 원천 fresh 성공 보장이 아니다.

| 안 | 무엇이 무엇을 호출하는가 | 인증/비밀 | 단일 writer 영향 / 판정 |
|---|---|---|---|
| 현재 운영의 최소안 | freepasserp5 Cloud Scheduler → OIDC 인증 private Cloud Run 중계 → GitHub 기존 `erp5-ssot-refresh.yml` workflow_dispatch | 중계가 기존 Secret Manager 버전1에서 해당 저장소용 Actions PAT를 메모리로 읽음. Scheduler 설정에는 GitHub 토큰 없음 | 기존 cadence와 `erp5-inventory-publish` 유지. 일반 중계 구현은 위 오더4를 따르며 배포/생성 미실행 |
| 직접 repository_dispatch | Scheduler → GitHub `erp5_refresh_watchdog` | Google OIDC는 GitHub 인증이 아님. PAT/App token 전달·갱신 경로 필요; repository dispatch는 Contents write 요구 | 현재 event는 전체 공급사 회차로 분기해 iancar-only가 아님. 부적합 |
| 목표 native 운영 | Scheduler → OAuth → Data-owned Cloud Run Job 실행 API → 기존 Data ONE collector | Scheduler SA에 해당 job의 run.invoker; job SA에 해당 ONE secret 읽기와 승인된 대상 권한 | GitHub concurrency와 잠금 공유 안 됨. 기존 writer 중지/drain/IAM fencing 및 native publication parity 뒤에만 가능. 지금 활성화 금지 |

최소안의 고정 요청(설계 예시, **실행하지 않음**):

```text
POST /repos/freepass-creator/freepasserp4/actions/workflows/erp5-ssot-refresh.yml/dispatches
ref: main
inputs: {iancar_only: true, iancar_apply: true, apply: false, target: ALL}
```

`apply=false`는 dry-run이라는 뜻이 아니다. 이 조합은 **새 ONE 수집 후 실제 반영**이며 오래된 ready snapshot replay를 막는다. 실제 적용 승인은 별도다. 중계는 임의 repo/ref/input을 받지 않고 이 조합만 허용한다. 최초 검증은 `/verify`로만 수행하며 dispatch·GCS 쓰기를 하지 않는다. 호출자가 iancar_apply를 바꾸는 경로는 없다.

- 주기 후보 `2,17,32,47 * * * *`, timezone UTC. :17은 전체 회차와 충돌할 수 있다. 중계의 사전 조회와 ERP4 cadence는 관측 당시 busy일 때만 양보하며 원자적 입장을 보장하지 않는다. 기존 GitHub 15분 schedule 비활성화는 별도 승인·변경 사항이다. hourly/watchdog는 유지하되 같은 writer에 합류한다.
- 최소 IAM: Scheduler 호출 SA는 **중계 서비스에만** `roles/run.invoker`; Scheduler service agent의 정상 `roles/cloudscheduler.serviceAgent` 유지. 중계 runtime SA는 **기존 Actions PAT secret 하나에만** `roles/secretmanager.secretAccessor`. 중계에는 Firestore/Sheets/ONE API 접근권한을 주지 않는다. PAT는 ERP4 저장소 하나의 Actions write(+Metadata read) 범위이며 contents write는 불필요하다. repo/workflow/ref는 코드 허용 목록으로 고정한다. 배포자가 필요한 actAs/배포권한은 runtime SA에 부여하지 않는다.
- 중복 방지: Scheduler는 at-least-once이므로 jobName+scheduleTime을 idempotency key로 삼고 create-only 실행 영수증 저장을 설계한다. 영수증은 기존 비공개 bucket의 전용 prefix create/read, pending은 정확한 그룹 객체의 objectUser CAS 권한이 필수다. status 최신 파일과 create/read-only 요구 충돌은 배포 절차의 HOLD를 따른다. dispatch 응답이 불명확하면 재전송하지 않고 UNKNOWN으로 보류한다. 새 API의 run ID 응답을 저장하고, 응답 없는 구버전은 Actions 조회로 대사한다. 발급 토큰/키는 로그·영수증에 남기지 않는다.
- 중계 max instances1/concurrency1만으로는 durable 중복 방지가 되지 않는다. run 종료를 기다리는 pending admission을 기록하고 미완료 회차가 있으면 새 dispatch를 건너뛴다. Actions run 조회 실패/페이지 잘림/응답 불명확은 양보/HOLD로 처리한다.
- 실제 잠금은 기존 workflow의 job-level `erp5-inventory-publish`, cancel-in-progress=false. 이안카 cadence는 자신 외 미완료 run이 있으면 `IANCAR_YIELDED_TO_EXISTING_WRITER`로 종료한다. **현재 조회는 per_page=100이며 precheck→queue가 원자적이지 않다.** 새 scheduler가 이 한계를 없앴다고 주장하지 않는다. hourly와 입장 경합 시 GitHub pending 교체 위험을 검증해야 하며, 양보/중복/시작 경합 시험 전 rollout HOLD.
- Data `data-owned-refresh.yml`은 owner 미전환에 더해 `e6727ff` 구 engine pin을 사용한다. `data-delivery-owner.mjs`는 legacy workflow disabled+drained, IAM/key fencing, 65분 drain, Data main Actions 환경을 요구한다. Cloud Run에 그대로 실행하거나 owner var만 전환하면 안 된다. 새 수집 writer를 legacy와 병행하지 않는다.
- 감시는 trigger 접수 / run 시작 / source syncedAt·stale / canonical 반영 / F01·F86 readback을 각각 기록한다. 중계 2xx는 갱신 완료가 아니다. stale 시 last-good 보존, 원천 갱신 없이 재시도로 15분 성공을 꾸미지 않는다.

공식 설계 근거: [Scheduler HTTP 인증](https://docs.cloud.google.com/scheduler/docs/http-target-auth), [Cloud Run Job 예약 실행](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule), [workflow dispatch 권한](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event), [repository dispatch 권한](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event), [Scheduler 전달 특성](https://docs.cloud.google.com/scheduler/docs/overview). 이번에는 IAM/secret/var/Scheduler 생성·변경·dispatch 모두0.

### 수리 범위와 후속 diff 제안 — 미채택(Data native로 이관)

아래는 오더1 당시 진단 이력이다. 당시 결함 executable은 ERP4 고정 engine이고 Data에는 RP004/RP006/RP023 native 구현이 없었다. 오더2는 위에 기록한 RP004/RP006 RAW 구현으로 이관했으며 RP023 adapter와 운영 수리는 여전히 미완료다. 새 writer를 활성화하지 않았다.

ERP4는 수정하지 않았다. 아래 과거 최소 diff 제안은 대표 결정으로 **미채택(Data native로 이관)**이다. 실행·적용 대상이 아니며 진단 이력으로만 보존한다.

```diff
--- a/lib/domain/mirror-iron-source.ts
+++ b/lib/domain/mirror-iron-source.ts
@@
 export async function rowsFromIronCatalog(): Promise<{
   rows: Map<string, Map<string, string>>; listings: number; active: number; sold: number; errors: number; complete: boolean; oddPeriods: string[];
+  sourceByPlate: Map<string, { price: unknown; imageUrls: unknown; observedAt: number }>;
 }> {
@@
-  return { rows, listings: catalog.listings, active: catalog.active, sold: catalog.sold, errors: catalog.errors.length, complete: catalog.complete, oddPeriods: [...odd] };
+  const sourceByPlate = new Map(catalog.items.filter(item => !item.sold).map(item => {
+    const p = item.product as Record<string, unknown>;
+    return [normName(p.car_number), { price: p.price, imageUrls: p.image_urls, observedAt: catalog.fetchedAt }] as const;
+  }));
+  return { rows, sourceByPlate, listings: catalog.listings, active: catalog.active, sold: catalog.sold, errors: catalog.errors.length, complete: catalog.complete, oddPeriods: [...odd] };
```

이 diff의 소비부는 `readRows` iron branch에서 plate 일치·중복·complete를 검증하고 `sourceByPlate`의 price tuple/사진을 Row에 보존해야 한다. unknown을 검증 없이 Price로 cast하지 않는다. 72/84/53개월 보존, missing/zero 보증금, 잘못된 차량 귀속, 빈 사진→last-good 유지 회귀가 필요하다. 이후 RP006의 실제 이미지가 있는 경우에만 기존 ERP 갤러리 연결을 검토한다. 홈페이지 상세 HTML URL을 `image_urls`로 넣지 않는다.

아이카는 `readSheetGrid`를 전역 변경하는 대신 source reader에서 `spreadsheets.get`의 해당 범위 `userEnteredValue`, `effectiveValue`, `hyperlink`, `userEnteredFormat.textFormat.link`, `textFormatRuns.format.link`를 읽는 경로가 필요하다. RAW에 plate+tabId+row+링크 원문/관측시각 보존 후 기존 `photo-link-guard`와 차량 귀속을 검증한다. 단축 URL/여러 차량 공유 URL/원본 미매칭은 HOLD. 6대 누락의 즉시 채우기나 과거 사진 복원 스크립트 실행은 하지 않았다.

### 검증·남음·next_start_here

- Academy READY(2026-10-03T10:55:38Z), GitHub code/main/Issue24 및 운영 회차 로그 읽기, RP004 source/F86 셀 링크 대사 수행. 운영 쓰기0, ERP4 파일 수정0, commit/push0.
- 전체 check: Codex 샌드박스에서는 환경 오류(`uv_os_get_passwd`, jq Permission denied, 로컬 서버 ECONNREFUSED)로 Vitest 9 FAIL. 같은 트리를 Claude가 정상 환경에서 `npm run check` 재실행 → **exit0, Vitest 1168 PASS / 14 SKIP**, build PASS. 이 변경은 문서 전용이다.
- 검토: Codex 쪽 Claude runner 호출은 실패했으나, 오더를 낸 Claude 세션이 이 절의 diff를 직접 읽고 확인했다(문서 전용, 운영 변경0). 설계안 자체의 실행 승인은 별도다.
- HOLD: 아이언 5대 원문 요금과 13대 사진, 아이카 미매칭33대 및 6대 링크 귀속/소비처 재대사, 두 수수료/정책 계산 입력, native transport, Scheduler admission 경합/실행 증거.
- 필요한 것: RP031 기존 ONE secret의 승인된 runtime 접근(신규 키 누락으로 단정하지 않음)과 공급사 fresh 응답; RP012 Data runtime용 승인된 계정 주입/토큰 갱신 transport; RP006 공개 규칙/페이지를 읽을 수 있는 연결; RP023 공개 규칙과 허용 세션 reader; RP004 rich-cell reader·원자 readback(원본 connector 접근은 이미 성공). 공급사 수집 중계는 기존 PAT Secret 버전1 접근·전용 IAM 검토가 필요하며 생성 금지 유지.
- next_start_here: 이 절의 사진 대사부터 이어서 원본/F86를 같은 창에 재조회하고 6/3/33 분류를 private evidence로 고정한다. 아이언은 robots/규칙 확인 후 지정5대만 원문→parser price→Row→원자 비교. Claude 검토와 정상 환경 전체 check를 거쳐 Data native 이관 또는 bridge 수리 범위를 결정한다. 검토 이후에도 운영 실행 승인은 별도이며 이번 오더는 생성/쓰기 권한을 부여하지 않는다.

## Non-negotiable topology

```text
Original supplier ERP/API/Sheet -> Data-owned source adapter
  -> existing SourceIntakeBatch/append-only RAW/source head
  -> reviewed normalization + Canonical + release (NOT YET CONNECTED HERE)
  -> F01/F86/ERP.com/Admin readback (NOT YET VERIFIED HERE)
```

ERP4 is a **consumer**, not a source collector, engine repository, upstream SSOT or fallback.
The 2026-09-30 legacy Data `data-delivery-owner.mjs` still checks out a frozen ERP4
engine as a transitional executor. It remains a known *unresolved operational*
dependency: do not call the native pipeline complete while that execution path exists.
Do not start a second writer while the legacy production refresh identity still has
authority. IAM fencing, backups and rollback of the active writer must be verified at
cutover, not inferred from a PR merge.

## 2026-09-30 provider ONE API supersession

The provider has now approved a FreePass read-only **ONE API** covering vehicle inventory/detail, term+mileage rent/deposit, contract/policy conditions and representative/detail photos. Customer PII, actual contract/customer documents, internal cost/commission/notes, GPS/control and mutation/reservation actions are excluded.

See [IANCAR-ONE-API.md](IANCAR-ONE-API.md). After exact Base URL/auth/endpoint/schema are verified, ONE API supersedes the login-only RP031 pilot and becomes the field authority for facts it supplies. Do not copy the live key into Git, issues, CI logs or command lines; provision a rotated key through runtime secret storage. Until the endpoint contract is observed, mapping/canonical/publication stay HOLD.

## RP031 / 이안카 direct pilot

`src/adapters/iancar-direct-source.ts` logs into the supplier's **original ERP** at the
single allowlisted host, holds the session only in process memory, and requests the
documented original `/api/inventory`. It has no ERP4 import or Firebase writer.
Supplier login uses a dedicated Data runtime secret (`IANKA_ACCOUNT_JSON`) rather
than copying ERP4 repository secrets.

The adapter validates the original full inventory model/unit response, normalized
unique vehicle numbers, reservations, declared inventory count, source `stale=false`,
upstream `syncedAt` age (<=2 hours), and known availability states. Unknown or
contradictory observations are HOLD; retrieval HTTP 200 alone does not establish a
current authoritative source. Absent vehicles are **not automatically retired**.
The existing Data source-head store chooses the newest FULL+COMPLETE observation.

The original `/api/inventory` does **not** supply an authorized complete rental
rate/deposit feed under the documented B2B credential. Native intake does not guess
prices or copy the ERP4 DOM bootstrap rate scrape. Any new authorized rate source
must have separately versioned per-period evidence, model/plate attribution and
freshness checks. Price publication is HOLD until that exists and is reviewed.
Supplier Google Sheets may provide separately attributed policy/price evidence but
must not silently overrule original ERP inventory availability.

`--compare-erp5` independently captures ERP5 products/policy/partner using the
existing Data read-only transaction and compares RP031 inventory by normalized
plate **both directions and state**. Output contains counts/digests only, not plate
IDs, supplier content or credentials. Even zero inventory differences is NOT proof
of price or F01/F86/customer consumer parity.

## Manual commands — default read-only

```sh
# With dedicated authorized Data runtime credentials injected securely:
# IANKA_ACCOUNT_JSON='...' (never command-line/password in Git)
npm run source:iancar:direct

# Optional independent DB inventory comparison, with a scoped read token and
# a private evidence bucket supplied through Data's existing authorized path:
npm run source:iancar:direct -- --compare-erp5

# RAW ONLY, requires a separate explicit operation approval and correct Data
# Firestore runtime IAM. This does NOT modify Canonical products or selling sheets.
IANCAR_DIRECT_RAW_INGEST_APPROVED=true npm run source:iancar:direct -- --apply-raw
```

The default command reads original ERP and returns only safe counts + issue codes;
no RAW/Canonical/Sheet mutation. `--apply-raw` refuses partial, stale or ambiguous
sources. Production identity and authentication must be provisioned by the sole
designated operations owner. No credentials are moved between repositories.

## Sales complaints: close only on one observed run

For each supplier and each reported plate/period record and compare:

1. Original live provider observed time and FULL+COMPLETE coverage.
2. Accepted Data source-run ID, RAW digest, newly added/missing plate sets and
   supplier availability (unknown values = HOLD; not "출고가능").
3. Reviewed Canonical/active product and source-backed **per-term** rent, deposit,
   age/mileage extras, policy code and applicability. No default price invention.
4. F01 and F86 same source revision and price/plate readback, then ERP.com/Admin
   authenticated rendered value from that revision. If any stage differs, mark
   `HOLD_SOURCE_PARITY`/`HOLD_PRICE_PARITY`/`HOLD_CONSUMER_READBACK` and do
   not issue a false green status. A downstream-to-downstream zero-diff is not
   source freshness evidence.

The existing 2026-09-21 Sonogong incident demonstrated this exact danger: source
224, published 177, F01 and F86 both 177 despite a misleading downstream "PASS".
Those are *historical* incident counts, never today's expected source totals.

## Before operational ownership switch

- Data original-source adapters exist for **every active supplier**, including
  new inventory and policy body changes; each has a proven fresh full capture.
- Data-native collection scheduler and recovery replace the frozen ERP4 executor.
  Only one active original-source writer remains after verified IAM fencing.
- Current original source <-> Data source-head <-> Canonical <-> F01/F86 <=>
  each consumer are compared per-plate, status and per-period conditions.
- Private backups/readbacks and a rollback drill pass; first native shadow runs
  have no unexplained source-only/target-only/status/price differences.
- Runtime Data IAM and consumer readback evidence are recorded. ERP4 legacy
  runner is then retired, **not** adopted as the new design.

This RP031 patch is a first vertical slice, not a claim that the above production
gates or all suppliers are complete.


## 차량 사진 프록시 확장 — 2026-10-10

출처 전략은 ONE API(`isPublicIancarPhotoProduct` + 기존 주입 reader)와 승인 Drive 연결(`isApprovedVehiclePhotoProduct` + `approvedPhotoReader`) 두 개다. 공통 경로는 I/O 없는 상수시간 해시 인증 → 실패 요청만 IP 실패 버킷 / 성공 요청만 consumer 버킷 → 요청 검증 → HTTP 응답 슬롯 확보 → 상품 읽기 → 출처 적격성·독립 차량사진 확인 관문 → 공통 검증·상품 재조회 → 성공 감사 저장 → HTTP 응답 직전 재검증 → 응답 종료 시 슬롯 반환이다. 원본 읽기·캐시 적중·count 모두 같은 출처 적격성과 확인 기록이 유지되어야 응답한다.

`photo_original_refs`는 1~200개이며 모든 항목의 `{ driveFileId, sha256, mediaType, role, zone, approvedAt, vehicleKey, vehiclePhotoVerifiedBy, vehiclePhotoVerificationMethod, vehiclePhotoVerifiedAt }`를 검증한다. 파일 참조·차량키는 영문/숫자/밑줄/하이픈 1~200자, SHA256은 소문자64 hex, role은 VEHICLE_PHOTO, zone은 차량사진, approvedAt은 실제 존재하는 UTC ISO 시각(초 또는 밀리초, Z)이다. 서류·원문·doc_images나 잘못된 ref 하나라도 있으면 상품 전체를 거부한다. 폴더 이름으로 승인을 추정하지 않는다.

차량키는 공급사 코드(provider_company_code, 없으면 partner_code)와 상품 귀속값을 서버에서 읽어 `sha256(JSON.stringify(['vehicle', supplier, vehicleId]))`로 계산한다. 공급사 차량 ID가 없으면 `sha256(JSON.stringify(['plate', supplier, plate]))`다. 문자열 앞뒤 공백을 제거하고 번호판 평문을 키·로그에 쓰지 않는다. 두 경로 모두64 hex라 기존 형식 제약과 호환된다. 옛 승인 키는 새 계산값으로 재승인되어야 하며 자동 fallback하지 않는다.

| 검증·제한 | 결과 |
|---|---|
| 비공개·삭제·철회·상태 부적격, 승인 ref/차량키 불일치 | 404 |
| 잘못된 productId/index | 400 |
| 비어 있는 바이트, 8MiB 초과, JPEG/PNG/WebP 이외 종류, 파일 시그니처 불일치 | 503, 캐시 미등록 |
| 승인 출처의 ref.mediaType 또는 SHA256 불일치 | 503, 캐시 미등록 |
| 상품 재조회에서 적격성·같은 출처·연결 불일치 | 404 VEHICLE_PHOTO_NOT_FOUND. reader 내부 실패는 캐시 미등록. 감사 저장 후에도 재조회하여 응답 차단. 승인 출처는 refs 전체 연결, ONE은 공급사·차량 귀속 재확인 |
| reader 미연결 | 503 VEHICLE_PHOTO_READER_UNAVAILABLE |
| count·바이트 HTTP 슬롯 동시8 초과 | 429 VEHICLE_PHOTO_BUSY + Retry-After: 2. 읽기 전에 확보하고 감사 저장·전송이 끝나는 finish·error·close까지 유지하며 한 번만 반환. reader 내부 작업 슬롯 반환과 별개 |
| 인증 실패 IP / 인증 성공 consumer 한도 초과 | 429 + Retry-After(다음 토큰 대기 초). 같은 IP의 실패 한도가 소진돼도 정상 토큰은 consumer 한도만 적용 |
| 미인증/권한 없음 | 제한 이내에서401/403 |

차량사진 확인자(`vehiclePhotoVerifiedBy`)·확인 방법(`vehiclePhotoVerificationMethod`)은 공백 아닌 문자열, 확인 시각(`vehiclePhotoVerifiedAt`)은 실제 존재하는 UTC ISO 시각(초 또는 밀리초, Z)이어야 한다. `photo_original_refs`의 모든 항목에 세 필드가 있어야 하며 하나라도 없으면 ONE과 승인 Drive의 count·원본·캐시 모두 거부한다. 공급사 신뢰·차량 귀속·파일 형식 검사와 독립된 관문이며 자동 이미지 분류를 뜻하지 않는다.

ONE의 차량 귀속 검사는 `iancarOnePhotoIds`, 승인 Drive의 해시 검사는 공통 reader가 담당한다. ONE 확인 방법 값의 형식은 `ONE 차량사진 전용 확인; 범위=<적용 API/사진 집합>; 방법=<사람이 수행한 검증>; 근거=<비공개 근거 위치/버전>`이다. 차량사진만 반환한다는 실제 근거·확인자·시각은 사람이 채운다. 문서나 공급사 이름으로 승인 기록을 생성하지 않으며 근거가 없으면 HOLD다. ONE도 전체 확인 기록의 변경·철회를 응답 전에 재검증한다.

크기·MIME·시그니처 정책과 크기 상수는 `consumer-output-contract.ts`의 `validateVehiclePhotoMedia` 한 곳이다. ONE 어댑터는 헤더/청크 수신/완료 시, 공통 reader와 gateway는 완성 바이트에 같은 함수를 호출한다. 수신 중 상한 초과는 즉시 취소한다. 기존 ONE count·캐시는 유지하고 공급사 오류는 단일 VEHICLE_PHOTO 응답으로 변환한다.

승인 바이트 캐시는 `(productId, driveFileId, sha256, approvedAt, vehicleKey)` JSON 튜플, 총64MiB, TTL30초, LRU다. 캐시 적중도 바이트·해시·반환 직전 상품 재조회를 통과한다. HTTP Cache-Control은 private, no-store, 감사 operation은 `READ_PRODUCT_PHOTO`, resource는 `vehicle-product-photo`다. count 응답 schema·productId·count와 HTTP 상태를 유지한다. reader는 `revalidate(): Promise<boolean>` 클로저를 반환하며 gateway가 `access.read`의 성공 감사 저장 완료 후 HTTP 응답 직전에 호출한다. 상품을 다시 읽어 같은 출처·같은 승인 연결·적격성을 확인하며 count·원본·캐시 모두 적용한다. 거짓이면404이며 기존 `access.deny`로 DENIED 기록을 시도한다. 이 추가 감사 저장이 불가능해도 데이터를 보내지 않고404를 유지한다. 새 감사 구조는 없다.

요청 제한 상수는 `src/api/photo-request-limit.ts` 한 곳이다. 인증 실패 IP 버스트120/초20 보충, 인증 성공 consumer 버스트60/초10 보충. 인증은 상수시간 해시 비교로 먼저 수행하며 I/O가 없다. 실패 요청은 consumer 버킷을, 성공 요청은 IP 실패 버킷을 소모하지 않는다. 버킷별 최대4096키·키 길이200·60초 비활성 정리, 시계 주입 가능. 상한 도달 시 새 키를429로 거부하여 기존 한도가 새 IP로 축출·초기화되지 않는다. 프로세스별 메모리 제한이며 다중 인스턴스 전역 한도를 보장하지 않는다. 재사용 검색에서 문서·원본 동시성 캐시만 발견되어 시간 기반 요청 제한기를 `CREATE_NEW_JUSTIFIED`로 추가했다.

Fastify `request.ip`는 `FREEPASS_DATA_TRUST_PROXY_HOPS` 정수0~3으로만 프록시 신뢰를 켠다(기본0, 잘못된 값은 시작 거부). 0이면 trustProxy=false로 소켓 IP만 사용하고 위조 X-Forwarded-For를 무시한다. 1~3이면 해당 홉 수만 신뢰하는 Fastify trustProxy 함수로 X-Forwarded-For를 오른쪽부터 해석하고 경계 너머 왼쪽 값은 신뢰하지 않는다. hops>0은 외부 클라이언트의 서버 소켓 직접 접근이 차단되고 모든 경로가 지정된 수의 신뢰 프록시를 통과하며 프록시가 전달 헤더를 정리하는 환경에서만 설정한다. 직접 접근이나 더 짧은 경로가 있으면 홉 수만으로 출처를 검증할 수 없으므로 기본0을 유지한다.

지운 것: `readIancarPhoto` 메서드, `isLegacyProduct` 인자·승인 전 조기 반환, gateway `readVehiclePhoto ?? readIancarPhoto` 폴백, 공개 `IANCAR_PHOTO_*` 응답 경로, 밑줄 연결 차량키, 중복된 이전 프록시 설명. 파일·시험 삭제 없음. 기존 이안카 gateway 시험을 단일 메서드로 이전했고 ONE 귀속·미디어 시험은 보존했다.

호환 확인: 로컬 ERP5(전체) 및 ERP4 lib/app에서 옛 오류 코드·메서드 의존을 grep한 결과0건. ERP5 `lib/catalog-client.mjs`는 HTTP 성공 여부·404로 분기한다. 라이브 검증은 네트워크 금지로 미실행이다.

검증(2026-10-10 PR #419 반려 수정): 관련171/171 PASS(gateway68, ONE75, withdrawal23, output-contract5). 확인 세 필드 각각의 누락·공백 거부/정상 허용과 확인 기록 철회, 실제 응답 스트림 완료 전 추가 요청 제한, finish·error·close의 단일 반환, reader·감사 오류 후 슬롯 반환을 확인했다. `npm.cmd run check`는 arch/standards/data-access/sheets106/build PASS 후 read-runtime-smoke 12 PASS / 1 FAIL로 code1 종료했다. 원인은 tsx 시작의 `uv_os_get_passwd ENOMEM`이며 후속 check 단계에는 도달하지 않았다. 별도 전체 Vitest 결과와 남은 보류는 NEXT-START-HERE 날짜 이력에 기록한다. runtime-policy 시험은 수정하지 않았다.

남음: 실제 Drive reader 구현·비공개 사진 읽기 권한·승인 연결 게시·배포는 범위 밖. 추가 네트워크 독립 검토는 UNAVAILABLE. 정상 실행 환경의 전체 check를 완료로 대신하지 않는다. 커밋·푸시·운영 변경 없음.

### 승인 Drive 원본 bytes adapter — CODED/TESTED, 운영 OFF

기존 infra의 `createApprovedDrivePhotoReader`는 승인된 정확 fileId에 대해 metadata와 `alt=media` GET만 수행한다. 원본 download 방식은 [Drive 공식 문서](https://developers.google.com/workspace/drive/api/guides/manage-downloads)를 따른다. `google-auth-library` Compute metadata 인증은 runtime service account와 drive.readonly scope만 사용하며 사용자 ADC/gws를 읽지 않는다. token/fetch fixture 주입을 지원한다. ID 불일치·휴지통·용량·미디어 오류는 download 전 거부하고 스트림을 공통 8MiB 한도 안에서 읽는다. 전체 bytes의 서명과 기존 공통 reader의 SHA256·차량키·승인 철회 검사 후에만 응답한다. SDK/HTTP 오류 원문이나 토큰은 기록·반환하지 않는다.

factory를 운영 runtime에 자동 연결하지 않았다. 기존 선택적 ApprovedPhotoReader 인자로만 연결할 수 있다. 승인 refs/정확 폴더 ID/서비스 계정 Drive 읽기 권한의 운영 검증과 별도 승인이 남았다. 앞 절의 reader 미구현은 이 코드 작업으로 해소하되, 비공개 사진 읽기 권한·승인 연결 게시·배포 HOLD는 유지한다.
