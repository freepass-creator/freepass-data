# 공통 시트 데일리 박제 — 자동 실행 신원 계획 (2026-10-04, 대표 승인 10-04)

> 상태: **대표 승인 10-04(①안: 맞춤 역할 + (default) 데이터베이스 조건 + 감지 점검)**. IAM·WIF·로그 설정 실행은 AI 상황실이 ai-ops 비공개 명령 묶음(실행 블록·되돌리기 블록 분리)으로 하고 되읽기로 확인한다. 코드 쪽은 #347. 실행 전까지 매일 박제는 운영자 PC 수동 실행.

## 왜 필요한가

#330 의 매일 박제 job 은 첫 수동 실행에서 신원 확인 단계에서 멈췄다(쓰기 0) — 쓰기 계정·WIF 공급자·증거 버킷 변수가 없었다. 시트 위임 열쇠(`GOOGLE_SA_JSON`)는 **만들지 않는다**: 장기 개인 키 없이 WIF 임시 자격으로만 돈다.

## 확정 설계

| 항목 | 값 |
|---|---|
| 워크플로 | 매일 박제 전용 `.github/workflows/shared-sheet-daily.yml`(#347 에서 data-owned-refresh 에서 떼어 냄). 실행 제목 `shared-sheet-daily <dry-run|apply>` |
| 서비스 계정 | `github-data-inventory-writer@freepasserp5.iam.gserviceaccount.com`(새로 — ERP4 `github-inventory-writer` 는 쓰지 않는다: ERP4 는 화이트 라벨만) |
| GitHub 연결 | **새 WIF 풀**의 공급자 하나, 조건 `repository == freepass-creator/freepass-data` · `ref == refs/heads/main` · `workflow_ref == …/shared-sheet-daily.yml@refs/heads/main` · `environment == data-production-delivery`. 기존 풀은 매시 감사 공급자와 저장소 속성을 같이 쓰므로 쓰지 않는다. 같은 environment 의 refresh(data-owned-refresh.yml)는 다른 파일이라 이 계정을 못 빌린다 |
| Firestore | 맞춤 역할 `freepassDataDailyWriter` + 조건 `resource.name == "projects/freepasserp5/databases/(default)"`. 넓은 `roles/datastore.user` 는 쓰지 않는다 |
| 증거 버킷 | 비공개 버킷에 객체 만들기·보기만(`objectCreator` + `objectViewer`), 덮어쓰기 금지(`--if-generation-match=0`) |
| 공통 시트 | 소유자(pyh)가 서비스 계정에 **보기** 공유 — 위임·장기 키 없음. WIF 임시 자격(ADC) + `spreadsheets.readonly` |
| GitHub 설정 | environment `data-production-delivery` 변수 `FREEPASS_DATA_DAILY_WIF_PROVIDER` · `FREEPASS_DATA_DAILY_SERVICE_ACCOUNT` · `FREEPASS_DATA_DAILY_EVIDENCE_BUCKET`(refresh 의 `FREEPASS_DATA_REFRESH_*` 와 따로) + secret `FREEPASS_DATA_SHARED_SHEET_ID`(있음) + 스위치 `FREEPASS_DATA_SHARED_SHEET_DAILY`(마지막에 `on`) |

## Firestore 권한 좁히기

**한계(공식 문서 확인):** Firestore 의 IAM 조건은 «데이터베이스 단위»까지만 걸린다. 모음(컬렉션) 단위 IAM 조건은 없고, 보안 규칙은 서비스 계정·서버 라이브러리에 적용되지 않는다. 그래서 «허용 모음에만 쓰기»를 IAM 하나로는 강제할 수 없다.

**겹으로 좁힌다:**

1. **맞춤 역할** — 권한 정확히 다섯: `datastore.databases.get`(거래 시작·되돌리기) · `datastore.entities.get` · `list` · `create` · `update`. **지우기(`datastore.entities.delete`) 없음**, 색인·가져오기/내보내기·데이터베이스 관리 없음. 같은 구성의 `freepassEstimateArtifactWriter` 가 운영에서 거래를 돌린다.
2. **데이터베이스 조건** — `(default)` 한 곳만.
3. **실행 경로 고정** — WIF 조건(위 표) + environment 보호. 코드는 `src/infra/firestore-layout.ts` 의 모음 이름으로만 쓰고, Canonical 쓰기는 writer 소유권 EXCLUSIVE `service:freepass-data` 로 다시 막는다.
4. **감지(#347, 켜는 것은 명령 묶음 순서대로)** — Firestore 쓰기 감사 로그(DATA_WRITE)를 켜되 다른 계정의 쓰기 로그는 저장 전에 버린다. 매시 감사 워크플로의 별도 job `daily-writer-guard` 가 읽기 전용 감사 계정(그 계정에는 data_access «로그 보기» 하나만)으로 최근 26시간을 읽어 판정한다:
   - 허용 모음 밖(특히 ERP4 화면의 `products`)·다른 데이터베이스 쓰기 → 경보(감사 job 실패)
   - `shared-sheet-daily`(main) 실행 구간 밖 쓰기 → 경보
   - 적용 실행이 성공했는데 쓰기 로그가 없음(로그 꺼짐·누락) → 보류(실패)
   - 공개 로그에는 개수와 정해진 모음 이름만. 로그 본문에 쓴 문서 경로가 남는지는 공식 문서에 없어 첫 적용 뒤 1회 확인한다 — 경로가 없으면 실행 구간 판정만 남는다.

**허용 모음(이 실행 경로가 실제로 쓰는 것):** `catalog_vehicle_models` · `catalog_vehicle_assets` · `catalog_products` · `catalog_offers` · `canonical_source_bindings` · `catalog_entity_revisions` · `sources` · `source_runs` · `source_heads` · `raw_records` · `normalized_candidates` · `field_lineage` · `canonicalization_receipts` · `reviewed_source_change_receipts` · `audit_events` · `outbox_events` · `data_access_events` (읽기만: `writer_ownership`). 기계 정본은 `src/domain/daily-writer-guard.ts`.

**남는 위험:** 이 신원은 `(default)` 안의 다른 모음에도 문서를 만들거나 고칠 «권한»은 갖는다(지우기는 못 하지만 `update` 로 내용을 덮을 수는 있다). 막는 것은 고정된 실행 경로·코드·소유권이고, 넘으면 감시가 다음 매시 감사에서 잡는다 — 사전 차단이 아니라 사후 감지다. 감사 계정의 로그 보기는 _Default 의 data_access 로그 전체(제외 규칙 뒤에는 이 계정의 Firestore 쓰기 + 다른 서비스가 켠 data_access 로그)다.

**완전히 막으려면(별도 승인):** Canonical·source 모음을 freepasserp5 안의 전용 데이터베이스로 옮기고 조건을 그 데이터베이스로 건다. 이동·소비처 연결 변경이 큰 일이라 따로 올린다.

## 실행 순서 (명령 묶음과 같음)

1) #347 반영 → 2) 서비스 계정·맞춤 역할·조건부 바인딩·새 WIF 풀·버킷·시트 공유·environment 변수(각 되읽기) → 3) 쓰기 감사 로그·제외 규칙·감사 계정 로그 보기(첫 적용 «전») → 4) 수동 `shared-sheet-daily` dry-run 1회 → 숫자 확인 → 5) 통제된 첫 apply 1회 → 되읽기 0 불일치 · 로그 모양 확인 → 6) `FREEPASS_DATA_DAILY_WRITER_GUARD=on` → 감시 OK 확인 → 7) `FREEPASS_DATA_SHARED_SHEET_DAILY=on`(매일 03:40 KST). 되돌릴 때는 예약·감시 끄기 → 진행 중 실행 끝 확인 → 변수·공유·바인딩·역할·계정·로그 설정 역순.

## 그 전까지 (수동 대체)

운영자 PC 에서 같은 순서: `inspect-erp5-source --live-read-only` → `capture-shared-sheet --erp5-capture …` → `ingest-shared-sheet-canonical --firestore` 계획 → 숫자 확인 → 같은 계획 digest 로 `--apply` → 되읽기. AI 상황실 지시가 있을 때만 apply.
