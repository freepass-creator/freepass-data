# FreePass Data native supplier intake — original ERP, not ERP4

Status (2026-09-30): **CODED / UNVERIFIED AGAINST LIVE ORIGINAL; RAW-ONLY PILOT. NOT DEPLOYED. NOT CUT OVER.**
Owner: FreePass Data. Existing `SourceIntakeBatch`, `ingestRawSourceBatch` and Firestore Source Store are reused.
This does not add a second CatalogStore, publication writer or scheduler.

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

### 범위와 증거 수준

- 목적: 공동 시트 밖 5곳의 누락 원인과 기간별 계산 입력을 점검한다. **진단 일부 확인 / 원천 대사 일부 HOLD / 운영 수리 미적용**이다.
- 작업 정본: `work/freepass-data/supplier-direct-integration-20261003`, Data `e4dcee5446e70f7342f1bcdc25b170d8aca077d0`. GitHub connector로 main이 같은 revision임을 확인했고 open PR 검색 결과는 0건이었다. Issue #24의 데이터 플랫폼 경계를 유지한다.
- 읽은 운영 코드: ERP4 engine `fe3eccc0173cb581e71a5a963bb7f28d3715b14f`의 Git 객체만. ERP4 main workflow는 `094155bd8e03a4269654a45b2eac6237a7796ad1` 관측, engine pin `fe3eccc`, Data RP031 실행기 pin `4917f2a79c0ab41d83dee745c8645bf810934f98`. ERP4 checkout 수정 없음.
- [회차 37110200131](https://github.com/freepass-creator/freepasserp4/actions/runs/37110200131)의 job `111166453368` 로그/단계 성공을 직접 재조회했다. 아래 시각은 **이 회차의 단계 완료 시각**이며 공급사 자체 갱신시각이나 현재 최신 성공 회차를 뜻하지 않는다. 오늘 cron 횟수·08:59 실패는 사용자에게 전달된 Claude 실측으로, 이번 전체 run 목록 재감사는 하지 않았다.
- 2026-10-03 원본/시트 connector 읽기: RP004 원본 `1LqWVs2o1-wpPqFiYkOjcQldmIXqtBMKYp0A1SKEir5w`, F86 `1hQtshpWKL4L0zSR3H3UQ36atICtHv9Ka7dQh7d7K5Vg`. 원본 fetch 응답 modified_time `2026-10-02T08:27:25.994Z`; 셀 재조회는 비원자 읽기이므로 그 시각으로 전체 셀 버전 일치를 보증하지 않는다. 광역 export의 텍스트에는 링크 메타데이터가 없어 사진 판정에 사용하지 않았다.
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
| 현재 운영의 최소안 | freepasserp5 Cloud Scheduler → OIDC 인증 private Cloud Run 중계 → GitHub 기존 `erp5-ssot-refresh.yml` workflow_dispatch | 중계가 Secret Manager의 GitHub App private key를 읽고 해당 저장소 설치 토큰을 짧게 발급. Scheduler 설정에는 GitHub 토큰 없음 | 기존 동일 저장소 cadence와 `erp5-inventory-publish` 유지. ERP4 코드 추가 없이 기존 입력 재사용. 구현/배포/생성 미실행 |
| 직접 repository_dispatch | Scheduler → GitHub `erp5_refresh_watchdog` | Google OIDC는 GitHub 인증이 아님. PAT/App token 전달·갱신 경로 필요; repository dispatch는 Contents write 요구 | 현재 event는 전체 공급사 회차로 분기해 iancar-only가 아님. 부적합 |
| 목표 native 운영 | Scheduler → OAuth → Data-owned Cloud Run Job 실행 API → 기존 Data ONE collector | Scheduler SA에 해당 job의 run.invoker; job SA에 해당 ONE secret 읽기와 승인된 대상 권한 | GitHub concurrency와 잠금 공유 안 됨. 기존 writer 중지/drain/IAM fencing 및 native publication parity 뒤에만 가능. 지금 활성화 금지 |

최소안의 고정 요청(설계 예시, **실행하지 않음**):

```text
POST /repos/freepass-creator/freepasserp4/actions/workflows/erp5-ssot-refresh.yml/dispatches
ref: main
inputs: {iancar_only: true, iancar_apply: true, apply: false, target: ALL}
```

`apply=false`는 dry-run이라는 뜻이 아니다. 이 조합은 **새 ONE 수집 후 실제 반영**이며 오래된 ready snapshot replay를 막는다. 실제 적용 승인은 별도다. 중계는 임의 repo/ref/input을 받지 않고 이 조합만 허용한다. 미래 첫 검증 회차는 `iancar_apply=false`로 구분하고 실제 반영 성공으로 세지 않는다.

- 주기 후보 `2,17,32,47 * * * *`, timezone UTC. :17은 전체 회차와 충돌 가능하므로 중계와 기존 cadence 모두 busy면 양보한다. 기존 GitHub 15분 schedule 비활성화는 별도 승인·변경 사항이다. hourly/watchdog는 유지하되 같은 writer에 합류한다.
- 최소 IAM: Scheduler 호출 SA는 **중계 서비스에만** `roles/run.invoker`; Scheduler service agent의 정상 `roles/cloudscheduler.serviceAgent` 유지. 중계 runtime SA는 **GitHub App key secret 하나에만** `roles/secretmanager.secretAccessor`. 중계에는 Firestore/Sheets/ONE API 접근권한을 주지 않는다. App은 ERP4 저장소 하나의 Actions write(+기본 Metadata read); contents write 불필요. App ID/installation ID/repo/workflow/ref는 비밀이 아닌 고정 config다. 배포자가 필요한 actAs/배포권한은 runtime SA에 부여하지 않는다.
- 중복 방지: Scheduler는 at-least-once이므로 jobName+scheduleTime을 idempotency key로 삼고 create-only 실행 영수증 저장을 설계한다. 최소 추가권한은 전용 비공개 receipt bucket에 object create/get만(기존 증거 저장소 재사용 검토). dispatch 응답이 불명확하면 재전송하지 않고 UNKNOWN으로 보류한다. 새 API의 run ID 응답을 저장하고, 응답 없는 구버전은 Actions 조회로 대사한다. 발급 토큰/키는 로그·영수증에 남기지 않는다.
- 중계 max instances1/concurrency1만으로는 durable 중복 방지가 되지 않는다. run 종료를 기다리는 pending admission을 기록하고 미완료 회차가 있으면 새 dispatch를 건너뛴다. Actions run 조회 실패/페이지 잘림/응답 불명확은 양보/HOLD로 처리한다.
- 실제 잠금은 기존 workflow의 job-level `erp5-inventory-publish`, cancel-in-progress=false. 이안카 cadence는 자신 외 미완료 run이 있으면 `IANCAR_YIELDED_TO_EXISTING_WRITER`로 종료한다. **현재 조회는 per_page=100이며 precheck→queue가 원자적이지 않다.** 새 scheduler가 이 한계를 없앴다고 주장하지 않는다. hourly와 입장 경합 시 GitHub pending 교체 위험을 검증해야 하며, 양보/중복/시작 경합 시험 전 rollout HOLD.
- Data `data-owned-refresh.yml`은 owner 미전환에 더해 `e6727ff` 구 engine pin을 사용한다. `data-delivery-owner.mjs`는 legacy workflow disabled+drained, IAM/key fencing, 65분 drain, Data main Actions 환경을 요구한다. Cloud Run에 그대로 실행하거나 owner var만 전환하면 안 된다. 새 수집 writer를 legacy와 병행하지 않는다.
- 감시는 trigger 접수 / run 시작 / source syncedAt·stale / canonical 반영 / F01·F86 readback을 각각 기록한다. 중계 2xx는 갱신 완료가 아니다. stale 시 last-good 보존, 원천 갱신 없이 재시도로 15분 성공을 꾸미지 않는다.

공식 설계 근거: [Scheduler HTTP 인증](https://docs.cloud.google.com/scheduler/docs/http-target-auth), [Cloud Run Job 예약 실행](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule), [workflow dispatch 권한](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event), [repository dispatch 권한](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event), [Scheduler 전달 특성](https://docs.cloud.google.com/scheduler/docs/overview). 이번에는 IAM/secret/var/Scheduler 생성·변경·dispatch 모두0.

### 수리 범위와 후속 diff 제안

결함이 있는 executable은 ERP4 고정 engine이고 Data에는 RP004/RP006/RP023 native 구현이 없다. 이번 Data 수정은 기존 문서 두 곳의 근거·누락 표·설계·handoff이며, 작동하지 않는 새 adapter나 두 번째 writer를 만들어 운영 수리로 표시하지 않는다. native 이관 시 기존 `SourceIntakeBatch`/RAW/source head를 재사용하고 새 자산 전 reuse check가 필요하다.

ERP4는 수정하지 않았다. 아래는 검토용 **정확한 최소 diff 제안**으로, 전체 수리나 배포 가능한 완료 patch가 아니다. 상세→Row 증거를 별도로 전달하여 기간·사진의 문자열 왕복 손실을 막는 방향이다.

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
- 필요한 것: RP031 기존 ONE secret의 승인된 runtime 접근(신규 키 누락으로 단정하지 않음)과 공급사 fresh 응답; RP012 Data runtime용 승인된 계정 주입/토큰 갱신 transport; RP006 공개 규칙/페이지를 읽을 수 있는 연결; RP023 공개 규칙과 허용 세션 reader; RP004 rich-cell reader·원자 readback(원본 connector 접근은 이미 성공). Scheduler 중계는 App 설치/키 보관·전용 IAM 검토가 필요하나 생성 금지 유지.
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
