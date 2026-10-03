# FreePass Data — NEXT START HERE

## 2026-10-02 이안카 15분 동기화 — 구현 초안 / 운영 활성화 HOLD

- 목적/사용자 결정: 공식 ONE API를 15분 주기로 Data 상품에 반영하고 기존 ERP·화이트라벨 이안카·F01/F86 발행 경로가 같은 관측 회차를 따라간다. RESERVED=계약중, 정책은2차, 미관측은 공개 HOLD이며 삭제·계약 변경은 금지한다.
- 대상 revision: Data main `5318ccfadc655a28a708fd645976057fb030941e`, ERP main `a00547ce4c794343f5520b03f48df00cac2a4a2d`, ERP 기존 engine `ce811592daef6c0283c3637ec94f1b7cf09a3838`. Data 작업 트리는 `C:\Users\admin\.codex\worktrees\period-economics-main\freepass-data`, ERP 작업 트리는 `C:\dev\worktrees\freepasserp4-e-01-engine`. 다른 Data checkout의 dirty 문서는 보존했다. Academy 두 대상 READY, 기존 collector/workflow COMPOSE_OR_EXTEND.
- 변경 상태: 기존 Data collector/runtime/infra와 firestore-document 회귀에 미커밋 초안이 있다. 미관측 공개 HOLD, hosted private backup save/readback 후 transaction, publication CLI 초안이다. ERP 기존 workflow/예약작업 지도도 미커밋: 02/32/47분 이안카 전용 회차+기존17분 전체 공급사 회차, 동일 concurrency/writer 유지. feature flag는 활성화하지 않았으며 checkout ref에 `IANCAR_DATA_REVISION_PENDING`이 남는다. 이 초안을 그대로 commit/push/dispatch하면 안 된다.
- 실제 read-only capture: source syncedAt `2026-10-01T23:47:27.779Z`, digest `b2beb7919cc882792157d8a895efd65900898c3d1ca5ce8a7f5c262d17af38f3`, 116대/2,784요금, AVAILABLE107/RESERVED1/PREPARING2/UNAVAILABLE6, issues0, public108. private capture `2c7c1d11-530e-4542-933d-442f8b4bbc4c.json`. DRY_RUN source116/matched114/created2/absenceHeld3/open108/deletes0/contractChanges0. 실제 DB·시트 변경은 이번 회차 미실행. 이 capture도 다음 적용에는 신선도를 다시 검증해야 한다.
- 실제 소비처: ERP RP031 공개109, 화이트라벨 eancar feed109 및 payload 동일. F01/F86 `10.02 06:58 상품리스트 316대` 중 이안카109, 상태·기준요금 대조 mismatch0. source 신규133호6031/133호6589, source 미관측133호5603/181하5373/133호6549. 합계 차이1만 고치면 되는 상황이 아니다. 실제 eancar 페이지109 및 상세24개 요금/정책 확인중 확인. hourly Sheet 성공은 API15분 갱신을 뜻하지 않는다.
- 검증: build PASS, ONE+Firestore targeted62 PASS, ERP check:schedules PASS. 현재 변경 후 전체 check는 아직 미실행. Claude 읽기 전용 검토 ANSWERED/exit0이며 운영 활성화 반대: 잠금/soft-delete 문서에서 반복 HOLD, 전체 products 동시성 범위, 이미 HOLD한 미관측 문서 재작성/450 cap, hosted rollback 접근·실행 이력, durable backup 기본 정책, raw evidence 보존·권한, 수집시간 신선도 예산, 차량번호 변경 quarantine, summary 정확성/원래 withdrawal 보존을 보완해야 한다. 현재 test PASS를 운영 합격으로 확대하지 않는다.
- 권한 HOLD: 기존 `github-inventory-writer@freepasserp5.iam.gserviceaccount.com`은 datastore.user만 확인됐다. 기존 Secret `freepass-data-iancar-one-api` 단일 read와 기존 비공개 bucket `freepasserp5-data-audit-evidence`의 `iancar-one/` prefix에 object create/read 권한 추가를 사용자에게 명시적으로 질문했으나 아직 답을 받지 못했다. IAM mutation/flag enable/운영 dispatch는 미실행이며 승인을 추정하지 않는다. 새 계정·키·공개 공유·delete 권한은 요청하지 않았다.
- next_start_here: Claude 반례를 먼저 해소하고 실패/백업/복구/동시성 회귀와 전체 check → 독립 재검토 → Data 정확한 main SHA commit/push → ERP placeholder를 해당 SHA로 고정하고 workflow 검토/지도 같은 commit → 명시적 최소 IAM 승인 및 readback → fresh capture/manual canonical run → ERP/eancar/F01/F86 실제 차량 집합·상태·24요금 재조회 → feature flag 활성화 → native15분 실행 증거. GitHub cron 지연은 별도로 관측하며 15분 스케줄과 성공한 원천 신선도를 구분한다.

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
| 프리패스 수수료와 공급사/영업채널 연동은 어떻게 다른가? | [수수료 연동 기준](READ-RUNTIME.md#수수료-연동-기준--사용자-결정-2026-09-30) | 기본은 지급수수료. 상대별 helper PREPARED, 외부 API와 scope 연결은 미구현 |
| 상품·정책의 숫자와 문구가 무슨 뜻인가? | [Commercial Data Catalog](COMMERCIAL-DATA-CONSUMER-ROLLOUT.md#policy-dictionary) | 72항목 의미. 공급사별 실제 값·예외·효력일은 원천으로 대조 |
| 접수·계약·인도·수수료 정산은 어떻게 연결되는가? | [업무 데이터 연결 지도](BUSINESS-DATA-CONNECTION-MAP.md) | ID/버전/스냅샷 관계와 업무 소유권. 실제 계약 확정·수금·지급을 별도로 확인 |
| 어떤 데이터가 있고 어떤 경로로 접근하는가? | [데이터 도메인 카탈로그](DATA-DOMAIN-CATALOG.md), [접근 Gateway](DATA-ACCESS-GATEWAY.md) | 제공 상태·권한·계약과 조회 영수증. 내부 collection 경로를 공개 계약으로 사용하지 않음 |
| F01/F86·ERP·화이트라벨·Admin에 잘 전달되는가? | [소비처별 사용 계약](F01-F86-ERP-PUBLICATION-CONTRACT.md), [소비처 런타임](ERP5-CONSUMER-RUNTIME.md) | 소비처별 release/snapshot·필드·실제 readback. 한 곳 성공을 전체 성공으로 확대하지 않음 |
| 시트 모양·열·숨김 규칙은 무엇인가? | [시트 규격](F01-F86-SHEET-SPEC.md), [실행 runbook](F01-F86-SHEET-RUNBOOK.md) | 기계 정본 `contracts/f01-f86-sheet-spec.v1.json`. 표시 검사는 원천 최신화 검사가 아님 |
| ERP4 수집기 없이 공급사 원본을 어떻게 직접 읽는가? | [FreePass Data 원본 직접 수집기](NATIVE-SOURCE-COLLECTOR.md) | 이안카 RP031 RAW-only 첫 단계. 모든 공급사/요금/운영 컷오버 완료 아님 |
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
