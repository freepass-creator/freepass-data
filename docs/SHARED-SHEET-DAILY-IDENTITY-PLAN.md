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
| Firestore | freepasserp5 `roles/datastore.user`(Canonical·source 컬렉션 쓰기 — 코드가 writer 소유권 EXCLUSIVE `service:freepass-data` 로 다시 막는다) |
| 증거 버킷 | 비공개 버킷 1개, 서비스 계정에 객체 생성·읽기만(`roles/storage.objectCreator` + `objectViewer`), 덮어쓰기 금지(`--if-generation-match=0`) |
| 공통 시트 | 소유자(pyh)가 서비스 계정 이메일에 **보기** 공유 — 위임·키 없음. 읽기 토큰은 WIF 로 받은 서비스 계정 ADC + `spreadsheets.readonly` |
| GitHub 설정 | environment `data-production-delivery` 변수 3개(공급자·서비스 계정·버킷) + secret `FREEPASS_DATA_SHARED_SHEET_ID`(있음) + 스위치 변수 `FREEPASS_DATA_SHARED_SHEET_DAILY`(dry-run 숫자 확인 뒤 `on`) |

## 승인 뒤 코드 변경(작은 PR)

- `shared-sheet-daily` job 에서 `GOOGLE_SA_JSON`·`GOOGLE_SHEETS_SUBJECT` 단계를 빼고, `google-github-actions/auth` 의 ADC(WIF)로 시트를 읽는다. `capture-shared-sheet` 는 keyFile 이 없으면 ADC + `spreadsheets.readonly` 를 쓰므로 코드 변경은 거의 없다.
- 확인 순서: 수동 `shared-sheet-dry-run` 1회 → 숫자(레코드·HOLD·정본 갱신·기간 대사·차량번호 중복) AI 상황실 확인 → 스위치 `on` → 예약(03:40 KST) 시작.

## 그 전까지 (수동 대체)

운영자 PC 에서 같은 순서: `inspect-erp5-source --live-read-only` → `capture-shared-sheet --erp5-capture …` → `ingest-shared-sheet-canonical --firestore` 계획 → 숫자 확인 → 같은 계획 digest 로 `--apply` → 되읽기. AI 상황실 지시가 있을 때만 apply.
