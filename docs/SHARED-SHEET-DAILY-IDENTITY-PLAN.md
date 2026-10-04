# 공통 시트 데일리 박제 — 자동 실행 신원 계획 (2026-10-04, 승인 대기)

> 상태: **계획만**. IAM·WIF 변경은 대표 승인 뒤 인프라 담당이 한다(이 저장소 코드·세션은 IAM 을 바꾸지 않는다). 그 전까지 데일리 박제는 운영자 PC 수동 실행으로 대신한다(AI 상황실 결정 10-04).

## 왜 필요한가

`.github/workflows/data-owned-refresh.yml` 의 `shared-sheet-daily` job(#330)은 첫 수동 실행에서 신원 확인 단계에서 멈췄다(쓰기 0). 이 저장소·environment `data-production-delivery` 에 다음이 없다.

- `FREEPASS_DATA_REFRESH_WIF_PROVIDER` · `FREEPASS_DATA_REFRESH_SERVICE_ACCOUNT` · `FREEPASS_DATA_REFRESH_EVIDENCE_BUCKET`
- secret `GOOGLE_SA_JSON`(시트 위임 키) — **만들지 않는다**(열쇠 파일 없는 설계로 바꾼다)

## 목표 설계 (열쇠 파일 없음)

| 항목 | 값 |
|---|---|
| 서비스 계정 | `github-data-inventory-writer@freepasserp5.iam.gserviceaccount.com`(없으면 생성 — 기존 ERP4 `github-inventory-writer` 는 쓰지 않는다: ERP4 는 화이트 라벨만) |
| GitHub 연결 | Workload Identity Federation 공급자, 조건: `repository == freepass-creator/freepass-data` · `ref == refs/heads/main` · `workflow == data-owned-refresh.yml` |
| Firestore | **좁힌 맞춤 역할**(아래 «Firestore 권한 좁히기») + 데이터베이스 조건 `resource.name == "projects/freepasserp5/databases/(default)"`. 넓은 `roles/datastore.user` 는 쓰지 않는다 |
| 증거 버킷 | 비공개 버킷 1개, 서비스 계정에 객체 생성·읽기만(`roles/storage.objectCreator` + `objectViewer`), 덮어쓰기 금지(`--if-generation-match=0`) |
| 공통 시트 | 소유자(pyh)가 서비스 계정 이메일에 **보기** 공유 — 위임·키 없음. 읽기 토큰은 WIF 로 받은 서비스 계정 ADC + `spreadsheets.readonly` |
| GitHub 설정 | environment `data-production-delivery` 변수 3개(공급자·서비스 계정·버킷) + secret `FREEPASS_DATA_SHARED_SHEET_ID`(있음) + 스위치 변수 `FREEPASS_DATA_SHARED_SHEET_DAILY`(dry-run 숫자 확인 뒤 `on`) |

## Firestore 권한 좁히기 (상황실 검토 10-04 반영)

**한계(공식 문서 확인):** Firestore 의 IAM 조건은 «데이터베이스 단위»까지만 걸린다(`resource.name == "projects/<프로젝트>/databases/<DB>"`). 모음(컬렉션) 단위 IAM 조건은 없다. 보안 규칙(Security Rules)은 서비스 계정·서버 라이브러리에 적용되지 않는다. 그래서 «catalog_*·source_* 에만 쓰기»를 IAM 하나로는 강제할 수 없다.

**그래서 겹으로 좁힌다:**

1. **맞춤 역할 `freepassDataDailyWriter`** — 권한은 정확히 다섯 개: `datastore.databases.get`(거래 시작·되돌리기에 필요) · `datastore.entities.get` · `datastore.entities.list` · `datastore.entities.create` · `datastore.entities.update`. **`datastore.entities.delete` 없음**, 색인·가져오기/내보내기·데이터베이스 관리 권한 없음. 매일 박제는 지우기를 하지 않는다(만들기·고치기·읽기만). 승인 뒤 첫 시험 실행에서 거래가 이 다섯 개로 도는지 확인하고, 모자라면 이 문서를 고친 뒤에만 더한다.
2. **데이터베이스 조건** — 위 조건으로 `(default)` 한 곳에만. 다른 데이터베이스는 못 건드린다.
3. **실행 경로 고정** — WIF 조건(저장소·main·`data-owned-refresh.yml`) + environment `data-production-delivery` 보호(검토자 승인). 코드는 `src/infra/firestore-layout.ts` 의 모음 이름으로만 쓰고, Canonical 쓰기는 writer 소유권 EXCLUSIVE `service:freepass-data` 로 다시 막는다.
4. **감지(아직 계획 — 만들고 시험한 뒤에만 «감지된다»고 말한다)** — Firestore «데이터 접근 감사 로그(DATA_WRITE)»를 켜고, 이 서비스 계정의 쓰기가 아래 허용 모음 밖으로 나가면 매일 점검에서 «보류»로 알리는 점검을 만든다.

**매일 박제가 쓰는 모음(허용 목록 — 이 실행 경로가 실제로 쓰는 것만):** `catalog_vehicle_models` · `catalog_vehicle_assets` · `catalog_products` · `catalog_offers` · `canonical_source_bindings` · `catalog_entity_revisions` · `sources` · `source_runs` · `source_heads` · `raw_records` · `normalized_candidates` · `field_lineage` · `canonicalization_receipts` · `reviewed_source_change_receipts` · `audit_events` · `outbox_events` · `data_access_events` (읽기만: `writer_ownership`). `capture-shared-sheet` 는 Firestore 에 쓰지 않는다(시트 읽기·증거 버킷만).

**남는 위험:** 이 신원은 `(default)` 안의 다른 모음(예: ERP4 화면이 쓰는 `products`)에도 문서를 만들거나 고칠 «권한»은 갖는다. 문서를 지우지는 못하지만 `update` 로 기존 필드·내용을 덮거나 필드를 지워 훼손할 수는 있다. 막는 것은 고정된 실행 경로·코드·소유권뿐이고, 감지 점검(4번)은 아직 만들지 않았다 — 사전 차단이 아니고, 감지도 만든 뒤에야 사후 감지가 된다.

**완전히 막으려면(별도 승인):** Canonical·source 모음을 freepasserp5 안의 «전용 데이터베이스»(예: `freepass-data`)로 옮기고 조건을 그 데이터베이스로 건다. 이동·소비처 연결 변경이 큰 일이라 이 계획에 넣지 않고 따로 올린다.

## 승인 뒤 코드 변경(작은 PR)

- `shared-sheet-daily` job 에서 `GOOGLE_SA_JSON`·`GOOGLE_SHEETS_SUBJECT` 단계를 빼고, `google-github-actions/auth` 의 ADC(WIF)로 시트를 읽는다. `capture-shared-sheet` 는 keyFile 이 없으면 ADC + `spreadsheets.readonly` 를 쓰므로 코드 변경은 거의 없다.
- 확인 순서: 수동 `shared-sheet-dry-run` 1회 → 숫자(레코드·HOLD·정본 갱신·기간 대사·차량번호 중복) AI 상황실 확인 → 스위치 `on` → 예약(03:40 KST) 시작.

## 그 전까지 (수동 대체)

운영자 PC 에서 같은 순서: `inspect-erp5-source --live-read-only` → `capture-shared-sheet --erp5-capture …` → `ingest-shared-sheet-canonical --firestore` 계획 → 숫자 확인 → 같은 계획 digest 로 `--apply` → 되읽기. AI 상황실 지시가 있을 때만 apply.
