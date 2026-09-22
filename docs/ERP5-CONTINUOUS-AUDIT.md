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

2026-09-22 FreePass Data PR #36에서 이 read-only workflow를 default branch에 등록했고, PR #37에서
summary stdout을 JSON-only로 고쳤다. 첫 성공 run `35689380147`은 FULL same-transaction 캡처와 private
GCS 실행 경로, `latest.json` readback까지 통과했다. 후속 run `35689500302`는 직전 포인터를 읽고
1,659개 전부 UNCHANGED, 추가·변경·미관측·재고전환 0인 delta를 보존한 뒤 포인터를 새 세대로 전진했다.
두 번의 수동 성공은 native `schedule` 전달 성공의 증거로 확대하지 않는다.

권한 분리 이후 `main@d63d051`에서 수동 run `35693167169`, `35693329115`가 연속 성공했다.
두 실행 모두 객체별 create-only 업로드, GCS byte readback, 포인터 전용 신원 재인증,
직전 generation 조건 갱신과 최종 readback을 통과했다. 두 번째 실행은 products 1,659건,
policy 81건, field path 508개, `NO_CHANGE`, unchanged 1,659건을 기록했고 `latest.json`은
`35693329115-1`을 가리킨다.

## 영속성

- 원문, DRY RUN, delta는 비공개 GCS 버킷의 실행 ID별 immutable prefix에 저장한다.
- `latest.json`은 다음 비교 대상을 가리키는 포인터일 뿐 원문을 덮어쓰지 않는다.
- `latest.json` 조회에서 HTTP 404만 첫 관측으로 인정한다. 인증·네트워크·서버 오류는 실패로 닫고 기존 포인터를 전진시키지 않는다.
- 실행 원문 계정은 객체 생성·조회만 하고 삭제하지 못한다. 실행별 고유 경로와 각 객체의 `ifGenerationMatch=0`을 함께 적용해 같은 이름의 새 generation 생성도 실패로 닫는다. 별도 포인터 계정만 `latest.json` 하나를 바꿀 수 있다.
- 실행별 원문과 요약을 GCS에서 다시 내려받아 byte-for-byte 일치한 뒤, 직전 generation 조건으로 `latest.json`을 원자적으로 전진시키고 다시 읽는다.
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
- `ERP5_POINTER_SERVICE_ACCOUNT`
- `ERP5_EVIDENCE_BUCKET`

셋 중 하나라도 없으면 네트워크 읽기 전에 실패한다. 현재 WIF provider는
`freepass-creator/freepass-data`의 `main`과 이 workflow 경로로 제한돼 있고, 서비스계정은
`roles/datastore.viewer`와 지정 버킷의 객체 생성·조회만 사용한다. 별도 포인터 서비스계정은 IAM 조건으로
`latest.json` 하나에만 objectUser가 적용된다. 버킷은 uniform access, public access prevention,
object versioning을 사용한다. workflow는 default branch에서 active다.

Google Cloud CLI는 workflow에서 `579.0.0`으로 고정한다. 여러 파일을 한 명령으로 올리지 않고 객체마다
`ifGenerationMatch=0`을 실행해, 이미 사용한 run ID/attempt 경로에서는 한 객체라도 충돌하면 실패한다.

CREATE_NEW_JUSTIFIED: 기존 감사 서비스계정 하나로는 실행별 원문의 append-only 권한과 `latest.json`
교체 권한을 동시에 최소화할 수 없다. 기존 workflow와 WIF provider는 재사용하고 포인터 객체 하나에만
조건부 권한을 갖는 별도 서비스계정을 둔다.

## 운영 판정

캡처와 저장, readback이 모두 성공한 실행만 다음 `latest.json`이 된다. 변화가 있으면 결과는 HOLD이며
자동 삭제·출고불가 처리·Canonical 반영을 하지 않는다. 실패한 실행은 직전 성공 포인터를 유지한다.

운영자가 외워야 할 것은 특정 숫자를 영구 고정한 값이 아니라, 마지막 성공 실행의 `readTime + digest +
collection count + field-path count + delta` 묶음이다. 개수가 같아도 필드나 값이 달라질 수 있으므로
count-only PASS를 금지한다. `MISSING_FROM_SOURCE`는 삭제 허가가 아니며 원천 상태 확인 전 HOLD다.

CREATE_NEW_JUSTIFIED: 저장소에 schedule 또는 상시 실행 workflow가 없었다. 기존 캡처·DRY RUN·delta
구현은 그대로 재사용하고, 이 파일은 인증·주기·영속 저장을 연결하는 운영 orchestration만 담당한다.

## 공개 판정 게이트

각 감사의 DRY RUN은 `publicationGate`를 만들고 그 판정을 `source-inventory.json`에도 복사한다.
`FULL / COMPLETE`는 Firestore 원천을 전부 읽었다는 뜻이며 공개 허가가 아니다. 매핑 HOLD가 하나라도
남아 있거나, 검토 승인 증거가 없거나, 검토된 Canonical release를 만들지 않았으면 판정은 `HOLD`이고
`activeReleaseAuthorized=false`다. workflow 자체에는 release 생성·활성화 기능이 없다.

따라서 검토가 쉬운 일부 레코드만 골라 전체 ERP 카탈로그처럼 공개할 수 없다. 운영 판정에는 원천 수,
candidate 수, 검토 대기/HOLD 수와 기계 판정 사유를 항상 함께 사용한다.
