# ERP5 상시 읽기 전용 감사

이 workflow는 `freepasserp5` Firestore의 `products`와 `policy`를 2시간마다 FULL 캡처하고,
직전 성공 캡처와 비교해 신규·변경·동일·미관측 및 재고 상태 전환을 기록한다.

## 영속성

- 원문, DRY RUN, delta는 비공개 GCS 버킷의 실행 ID별 immutable prefix에 저장한다.
- `latest.json`은 다음 비교 대상을 가리키는 포인터일 뿐 원문을 덮어쓰지 않는다.
- GitHub Artifact에는 원문 없이 요약만 90일 보존한다.
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

CREATE_NEW_JUSTIFIED: 저장소에 schedule 또는 상시 실행 workflow가 없었다. 기존 캡처·DRY RUN·delta
구현은 그대로 재사용하고, 이 파일은 인증·주기·영속 저장을 연결하는 운영 orchestration만 담당한다.
