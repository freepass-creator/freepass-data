# ERP5 상시 읽기 전용 감사

이 workflow는 `freepasserp5` Firestore의 `products`와 `policy`를 2시간마다 FULL 캡처하고,
직전 성공 캡처와 비교해 신규·변경·동일·미관측 및 재고 상태 전환을 기록한다.

각 성공 관측은 `source-inventory.json` 원천 신분증을 만든다. 여기에는 프로젝트/DB/컬렉션,
동일 transaction readTime과 digest, 컬렉션별 전체 문서 수, 상품 필드 경로 수, 매핑 분류 수,
직전 관측 대비 추가·변경·동일·미관측 수와 재고 상태 전환 수가 들어간다. 원문 값과 문서 ID는
요약에 넣지 않는다. Actions 실행 요약에서도 같은 count card를 즉시 확인할 수 있다.

이 workflow는 운영 writer가 아니다. 실제 원천 최신화와 Firestore/F01/F86 쓰기의 단일 책임자는
`freepass-creator/freepasserp4`의 `.github/workflows/erp5-ssot-refresh.yml`이다. 해당 writer는
24개 공급사 원천 재수집 → ERP5 Atom 갱신 → 정책 참조 정합화 → 고정 snapshot → F01/F86 발행·감사를
한 concurrency 경계에서 수행한다. FreePass Data가 같은 컬렉션을 별도로 갱신해 이중 writer가 되지 않는다.

2026-09-21 19:00 KST 커밋 `100e5a1d`에서 자동 trigger가 의도적으로 제거됐고 마지막 full-green
운영 증거는 run `35580953322`였다. ChatGPT Audit 100은 data plane full-green과 함께 native schedule/
recovery timeliness HOLD, Source Contract의 stale `audit95-recorder` main-writer 충돌을 기록했다.
복구안은 ERP4 Draft PR #463이며, 병합·실행·readback 전에는 상시 최신화가 복구됐다고 표현하지 않는다.

## 영속성

- 원문, DRY RUN, delta는 비공개 GCS 버킷의 실행 ID별 immutable prefix에 저장한다.
- `latest.json`은 다음 비교 대상을 가리키는 포인터일 뿐 원문을 덮어쓰지 않는다.
- `latest.json` 조회에서 HTTP 404만 첫 관측으로 인정한다. 인증·네트워크·서버 오류는 실패로 닫고 기존 포인터를 전진시키지 않는다.
- GitHub Artifact에는 원문 없이 요약만 90일 보존한다.
- `source-inventory.json`은 원천별 개수와 구조·변화 인지를 위한 비민감 요약이다.
- workflow와 검사 규칙은 Git에 남는다.

## 권한 경계

GitHub OIDC Workload Identity를 사용한다. 서비스 계정은 `freepasserp5`의 Firestore 읽기와 지정된
증거 버킷의 객체 생성·조회에 필요한 최소 권한만 가져야 한다. Firestore commit/batchWrite,
Canonical write, 시트 갱신, 소비처 전환, RTDB 접근은 workflow에 없다.

필수 repository variables:

- `ERP5_WIF_PROVIDER`
- `ERP5_READ_SERVICE_ACCOUNT`
- `ERP5_EVIDENCE_BUCKET`

셋 중 하나라도 없으면 네트워크 읽기 전에 실패한다. workflow schedule은 default branch에 병합된
뒤에만 정기 실행된다. 현재 변수와 IAM이 없으므로 코드가 존재하는 것만으로 상시 가동을 주장하지 않는다.

## 운영 판정

캡처와 저장, readback이 모두 성공한 실행만 다음 `latest.json`이 된다. 변화가 있으면 결과는 HOLD이며
자동 삭제·출고불가 처리·Canonical 반영을 하지 않는다. 실패한 실행은 직전 성공 포인터를 유지한다.

운영자가 외워야 할 것은 특정 숫자를 영구 고정한 값이 아니라, 마지막 성공 실행의 `readTime + digest +
collection count + field-path count + delta` 묶음이다. 개수가 같아도 필드나 값이 달라질 수 있으므로
count-only PASS를 금지한다. `MISSING_FROM_SOURCE`는 삭제 허가가 아니며 원천 상태 확인 전 HOLD다.

CREATE_NEW_JUSTIFIED: 저장소에 schedule 또는 상시 실행 workflow가 없었다. 기존 캡처·DRY RUN·delta
구현은 그대로 재사용하고, 이 파일은 인증·주기·영속 저장을 연결하는 운영 orchestration만 담당한다.
