# 프리패스 데이터 — 아키텍처 v2 검토안

작성일: 2026-09-20
상태: PROPOSED / DESIGN REVIEW ONLY
기준 문서: main의 docs/ARCHITECTURE.md, docs/MIGRATION-PLAN.md, docs/CONSOLE-UX.md
기준 revision: 99071c966453f36c10bd39799949e57bdca41944

이 문서는 설계 제안이다. 기존 정본을 자동 대체하지 않으며, Firebase·권한·writer·배포·스케줄·데이터 소스의 변경을 승인하지 않는다. 독립 검토와 운영 실증은 아직 수행되지 않았다. 실제 고객 데이터, 비밀정보, 비공개 저장소 문서 원문은 이 공개 검토안에 포함하지 않는다.

## 1. 결론

프리패스 데이터는 Firebase의 기술 운영과 프리패스 제품군의 데이터 공급을 책임지는 공통 플랫폼으로 구축한다. 그러나 모든 업무 의미·계산·상태 결정권을 플랫폼으로 이전하지 않는다.

핵심은 `책임 중앙화 + 도메인 권한 유지 + 장애 격리 + 증거 기반 전환`이다.

하나의 관리 플랫폼은 하나의 물리 DB, 하나의 거대한 API, 모든 프로젝트의 코드 병합을 뜻하지 않는다. 초기에는 기존 저장소와 식별자를 유지하며 관리 책임과 공급 계약을 먼저 정리한다.

## 2. 이전 설계에서 보완할 판단

| 이전 표현 | v2 제안 |
|---|---|
| 모든 데이터의 정본은 하나 | 같은 업무 사실·범위에 대한 권위 있는 변경 경로가 하나. 도메인과 시간 맥락은 구분 |
| 프로젝트별 데이터를 모두 미리 복제 | 제공 계약은 프로젝트 요구를 반영하되, 공통 dataset을 재사용. 사전 생성은 비용·지연·권한에 따라 선택 |
| Firebase SDK는 어디에도 없어야 함 | 소비 앱의 임의 원장 접근을 금지. 승인된 전송 구현·인증 SDK·파일 전송까지 일괄 금지하지 않음 |
| 모든 수정은 override | 원천정정·업무조건 변경·일시 override·업무 상태전이를 구분 |
| 소비처 전부 확인해야 저장 성공 | 정본 저장, 제공본 발행, 서비스 조회, 실제 화면 관측을 분리 |
| 앱마다 읽기·쓰기 스위치 | 읽기는 consumer/dataset별. 쓰기 권한 이전은 domain/aggregate/scope별 |
| RAW는 영구 불변 보관 | 보관 기간 안에서 덮어쓰기 금지. 보존·삭제·복원 후 재삭제 정책은 별도 |
| API로 감추면 DB 교체 영향 없음 | 외부 의미·성능·일관성·실시간 동작 계약까지 유지하고 검증한 경우에만 호환 |

## 3. AI Core와의 관계

AI Core는 공통 계약의 형식, 버전, 오류, provenance, receipt, workflow 표현과 UI/UX 검증 기준을 제공한다. 프리패스 데이터는 이를 적용한 프리패스 데이터 플랫폼이다.

프로젝트 독립성 규정과 공통 데이터 공유는 적용 범위를 명시한 FreePass profile/ADR로 조정해야 한다. 공유 플랫폼을 만든다고 도메인 고유의 데이터 결정권·배포 승인·법인별 권한 경계를 없애지 않는다. 현행 공통 규격과 충돌하는 항목은 기록하고 승인 전에는 CONFORMANT로 표기하지 않는다.

규격 적용 흐름:
`공통 규격 revision 고정 → FreePass 적용 profile → 도메인 계약 → consumer 적합성 테스트 → 운영 증거 → 채택`

운영 앱은 요청마다 AI Core에 접속해서 최신 규격을 가져오지 않는다. 검증한 계약·검사기·디자인 자산을 버전 고정한 배포 산출물에 포함한다. AI Core의 관리 화면 장애가 데이터 조회의 필수 의존성이 되어서는 안 된다.

이 프로젝트에서 발견한 공통 개선은 검토 후보와 근거로 환류한다. 공통 규격을 별도 정본으로 복제하거나 단독으로 승격하지 않는다.

## 4. 책임 모델

| 책임 | 최종 책임 주체 | 플랫폼의 역할 |
|---|---|---|
| Firebase binding, Firestore/Storage, IAM/rules/index, 복구 | 프리패스 데이터 | 운영·격리·배포 검증 |
| 상품/오퍼/가격조건의 의미 | 지정된 Catalog 도메인 책임자 | 계약화·영속화·공급 |
| 견적 산식·시뮬레이션 | Estimate 도메인 | 검증된 입력 제공, 결과·입력 버전 보관 |
| 영업 상태·통화 행위의 의미 | Sales 도메인 | 허용된 명령의 저장·조회·증거 |
| 접수/계약/정산의 업무 전이 | 해당 운영/정산 도메인 | authoritative handler 실행 경계와 persistence |
| 화면 구성·브랜드·정보 밀도 | 소비 프로젝트 | 데이터 의미를 바꾸지 않는 presentation |

도메인 코드 소유와 실행 프로세스 위치는 다르다. 도메인 책임자가 관리하는 검증 코드를 플랫폼의 서버 모듈에 버전 고정해 실행할 수 있다. 중요한 것은 서버 측 권위 있는 검증이 하나라는 점이다. 브라우저 검증만 신뢰하거나 플랫폼에 동일 계산식을 다시 작성하지 않는다.

범용 `patch(any_entity, any_field)`를 외부 쓰기 계약으로 만들지 않는다.

## 5. 목표 구조

```text
             AI Core 고정 규격·검증·채택 증거
                           │
                  FreePass 적용 profile
                           │
┌────────────────── 프리패스 데이터 ──────────────────┐
│ 관리면: 원천 / 의미·계약 / 변경 / 제공본 / 권한 / 관측 │
│                                                    │
│ 원천 → 수집 증거 → 정규화 후보 → 도메인 검증 → 정본   │
│                                      │             │
│ 명령 → 인증·권한 → 도메인 handler → atomic commit    │
│                                      ├─ 감사       │
│                                      └─ outbox     │
│                                                    │
│ 정본 → 제공 계약 → 검증된 데이터 release → 조회면    │
│ Firebase/Storage 및 필요 시 별도 검색·분석 저장소     │
└────────────────────────────────────────────────────┘
                 │         │         │         │
               Admin     Sales     ERP.com   Estimate
```

네 소비처는 병렬이다. Estimate를 ERP.com이나 Admin 아래의 데이터 소비자로 잘못 배치하지 않는다. 기능 재사용과 데이터 공급 관계는 별도의 그래프다.

초기 구현은 하나의 repo 안의 경계 있는 모듈로 시작한다. 관리 UI, 읽기/명령 서버, 비동기 worker는 부하·권한을 분리할 수 있게 한다. 처음부터 수십 개 마이크로서비스나 별도 데이터 메쉬를 만들지 않는다.

## 6. Data Product — 공급 단위

프로젝트별 JSON 파일이 아니라 책임과 보장 조건이 있는 제공 dataset을 공급 단위로 관리한다.

제공 계약에는 다음을 포함한다.
- dataset_id와 계약 버전
- 의미 책임자·플랫폼 책임자
- 입력 domain/revision과 output schema
- 허용 consumer, tenant/audience와 field allowlist
- 데이터 품질 검사와 공개 금지 조건
- 최신성 기준, 허용 지연, 만료 시 행동
- 제공 방식(API, release snapshot, 제한적 subscription)
- 조회/변경 권한 및 관련 명령
- 호환성·폐기·복구 정책
- 데이터 release와 실제 관측 증거

공개 상품정보가 같다면 여러 프로젝트가 `public-catalog.v1`을 공유한다. 내부 공급조건은 별도 제한 dataset으로 제공한다. 견적 입력은 계산에 필요한 정형 조건과 승인된 파라미터를 제공한다. 모든 앱마다 같은 상품 전체를 별도 저장하지 않는다.

매핑은 필드 선택·정렬·결합·단위의 명시적 변환에 한정한다. 가격 산식이나 업무 상태 판단이 필요하면 해당 도메인의 버전 고정 규칙을 호출하고 결과에 규칙 revision을 남긴다. 소비처 전용 변환기가 몰래 새 계산 정본이 되는 것을 막는다.

## 7. 의미 모델

최소한 차량 실물, 차량 모델/트림 기준정보, 판매 상품, 공급 오퍼, 가격·보증금·보험·기간 조건을 구분한다. 같은 차량에 여러 오퍼가 있을 수 있다. 서로 다른 오퍼의 최저 가격과 유리한 보증금을 조합해 존재하지 않는 조건을 만들지 않는다.

정체성은 불변 opaque ID로 관리하고 공급사 ID·차량번호·시트 위치는 namespaced external reference로 보관한다. 차량번호나 시트 행 번호가 바뀌었다고 새 차량으로 자동 판단하지 않는다. 동일성 불확실 시 merge하지 않고 검토 대상으로 둔다.

금액은 통화·단위·세금 포함 여부를 명시한다. 기간은 수치와 단위를 함께 취급한다. `0`, `unknown`, `not_applicable`, `withheld`, `invalid`를 혼동하지 않는다. 보증금이 약정기간에 따라 계산된다면 규칙과 입력 조건을 제공하며 기간이 없을 때 0원으로 대체하지 않는다.

API 응답 구조가 그대로여도 원→만원, 세전→세후, 상태 의미 변경은 의미상 breaking change다.

## 8. 원천·정본·이력

원천 증거에는 source_id, source_record_id, snapshot/digest, source 위치, observed_at, 가능하면 source_updated_at을 남긴다. observed_at이 최신이라고 원천 자체가 최신이라고 판정하지 않는다.

정규화에는 mapper/normalizer 버전, 입력 digest, 검증 결과를 남긴다. 수집 실패와 원천에서 실제 제거된 상태를 구분한다. 전체 수집의 완전성이 확인되지 않은 회차에서 누락을 삭제로 해석하지 않는다.

시간은 최소한 업무상 유효 시점(valid_from/to)과 시스템 기록 시점(recorded_at)을 구분한다. 전체 시스템에 완전한 bitemporal DB를 도입할 필요는 없지만, 가격·정책·견적·계약의 과거 조건을 재현할 수 있는 이력은 보존한다.

견적·접수·계약은 결정 당시 선택한 오퍼, 입력 snapshot, 계산 엔진 버전, 데이터 release를 참조한다. 오늘의 가격 수정은 과거 계약 내용을 바꾸지 않는다. 재계산은 새로운 결과 revision이다.

## 9. 수정은 네 종류

1. 원천 오류 정정: 원천 소유 경로로 정정하거나 근거 있는 correction을 기록한다.
2. 자체 업무조건 변경: Catalog의 가격/판매정책 명령으로 유효 시점을 포함해 변경한다.
3. 임시 override: 권한, 사유, 범위, 유효기간, 원천 변경 시 재검토 정책을 가진다.
4. 업무 상태 변경: 승인·취소·계약·정산 명령을 사용한다. 데이터 콘솔에서 상태 문자열만 바꾸지 않는다.

Authority는 `SOURCE_WINS / REVIEW_REQUIRED / CALCULATED` 같은 한 줄 enum으로 합치지 않는다. 소유자, 허용 writer, 변경 방식, 승인 요건, 충돌 규칙, 시간 범위를 별도 축으로 정의한다.

콘솔은 승인 우회 도구가 아니다. Admin에서 금지된 변경을 콘솔에서 수행할 수 없어야 한다.

## 10. 쓰기와 복구

명령 처리의 기본 순서:
`인증 → 서버에서 actor/tenant 확인 → 범위별 권한 → 기대 revision/ownership epoch → 도메인 검증 → 원자적 저장 → outbox 처리 → 제공본 생성`

가능한 동일 Firestore transaction 안에 업무 변경, revision, idempotency 결과, outbox를 함께 기록한다. 재시도 가능한 transaction 안에서 문자발송·외부 API 호출 등 외부 부작용을 실행하지 않는다. 파일은 검증된 staging 객체와 metadata commit을 분리하며 Firestore와 Storage가 하나의 transaction이라고 가정하지 않는다.

Idempotency key는 명령 종류·범위·입력 digest와 결합한다. 같은 key에 다른 payload가 오면 충돌이다. 응답이 사라져도 receipt 조회로 결과를 확인한 뒤 재시도한다.

이벤트는 중복·순서 역전을 전제로 한다. consumer/worker는 처리 ID와 entity revision을 확인한다. 이전 revision으로 되돌리는 이벤트를 적용하지 않고, gap은 재조회·대사한다. 외부 제공자가 exactly-once를 보장하지 않으면 플랫폼도 임의로 보장한다고 주장하지 않는다.

## 11. Data Release

정본의 현재값과 외부 공개된 버전을 분리한다.

release manifest에는 release_id, dataset contract version, 입력 revision 집합, transformer/engine version, schema version, content digest, 권한 profile revision, 품질검증, 발행 근거를 담는다. 서로 다른 원장의 revision 숫자를 빼서 지연으로 표시하지 않는다.

가격·기간·보증금·정책처럼 함께 일치해야 하는 자료는 호환 가능한 입력 버전 묶음으로 생성하고 검증 후 active release pointer를 전환한다. 목록·필터·건수·페이지 cursor도 동일 dataset release를 사용한다. 조회 cursor는 query와 scope에 묶는다.

여러 저장소의 버전을 묶은 manifest를 전역 동시 transaction으로 표현하지 않는다. 실제 보장 범위와 as-of 시점을 적는다. 예약·계약 확정은 공개 snapshot만 믿지 않고 현재 권위 있는 상태를 재검증한다.

전체 소비 앱이 동시에 같은 버전으로 바뀐다고 약속하지 않는다. 각 요청은 자신이 읽은 release를 식별할 수 있어야 한다.

## 12. 완료 의미

저장, 발행, 조회, 화면 관측은 다른 증거다.

- COMMITTED: 권위 있는 정본 transaction 확인
- PUBLISHED: 대상 제공 경로에 release 반영 확인
- SERVED: 특정 요청에 특정 release 제공 확인
- OBSERVED: 특정 runtime/검증 범위에서 해당 release 관측

위 용어는 검토용 운영 단계이며 기존 공통 receipt/workflow와 매핑 후 채택한다. canonical commit 성공을 소비 앱이 꺼져 있다는 이유로 실패 처리하지 않는다. 반대로 API가 열렸다는 이유만으로 모든 사용자가 새 값을 봤다고 표시하지 않는다.

필수 제공 대상의 발행 완료가 필요한 publish 작업은 그 자체의 완료 조건과 receipt를 가진다. 데이터 저장과 배포의 두 작업을 구분한다.

## 13. 전환 스위치

읽기 설정 범위는 `환경 × consumer × dataset × tenant/audience`다. 각 설정은 revision과 승인 근거를 가진다. 비교 모드에서는 동일한 입력 기준으로 결과를 비교하고, shadow write가 실제 이중 쓰기를 만들지 않게 한다.

쓰기 권한은 앱별 토글이 아니라 `domain/aggregate/scope`별로 이전한다. 하나의 사실에 두 개의 독립 writer가 생기지 않게 한다.

권한 이전 절차:
`대상 명확화 → 신·구 상태 대사 → 진행 중 명령 정리 → 구 writer 쓰기 차단 → ownership epoch 전진 → 신 writer 검증 → 제한 활성화`

epoch는 검증 가능한 저장/권한 경계에서 강제해야 한다. 설정 JSON이나 UI 토글만으로 기존 앱·서비스 계정의 직접 쓰기가 차단됐다고 간주하지 않는다. 여러 실행 인스턴스가 동일한 논리 writer를 구현할 수 있다.

읽기 경로 rollback과 쓰기 권한 rollback은 다르다. 새 writer가 쓴 뒤에는 단순히 옛 스위치로 돌아갈 수 없다. 필요하면 쓰기를 중단하고 상태를 대사한 후 별도 권한 이전 절차를 수행한다. 폐기된 원장·RTDB로 자동 fallback하지 않는다.

RTDB는 목표 플랫폼에서 사용하지 않는다. 이 검토안은 새 RTDB adapter, scheduler, migration job의 실행 승인이 아니다.

## 14. 전송 방식과 장애 격리

기본은 버전이 있는 HTTP API와 읽기 전용 release snapshot이다. SDK는 이를 쓰기 편하게 만드는 client이며 권한 경계 그 자체가 아니다. 중요한 정본 쓰기는 서버 경로로 제한한다.

파일 bytes를 모두 중앙 API로 중계하지 않는다. 플랫폼이 허용한 객체·범위·유효시간에 한해 직접 전송할 수 있다. 실시간 구독이 필요한 경우 제한된 read projection을 플랫폼 소유 adapter로 노출할 수 있으나, 성능·권한·재연결 검증을 통과한 명시적 예외여야 한다.

관리 UI, 조회, 수집/재생성 worker의 장애와 부하를 격리한다. 대량 정규화가 고객 조회를 고갈시키지 않게 별도 budget과 queue를 둔다. 공개 정보는 승인된 정책 범위 안의 last-known-good release를 제공할 수 있으나 만료·판매중지·접근권한 철회 정책을 따라야 한다. 오프라인 캐시의 즉시 전역 철회를 보장하지 않는다.

계약확정·지급·권한 판단 등 엄격한 작업은 필요한 최신 증거가 없으면 보류한다. 모든 장애에서 전체 앱을 멈추는 것도, 모든 장애에서 옛 데이터를 쓰는 것도 피한다.

## 15. 보안·개인정보·파트너 확장

consumer_id는 tenant_id가 아니다. 앱 종류와 사업자/파트너 권한 범위를 분리하고 인증된 주체에서 권한을 결정한다. 요청 body에 적힌 actor/tenant만 신뢰하지 않는다.

공개 dataset은 명시적 field allowlist로 만든다. 새 내부 필드가 추가돼도 공개 응답에 자동으로 포함되지 않는다. 내부 권한과 개인별 결과를 공개 cache와 섞지 않는다. 파일 URL, 검색 색인, 로그, export에도 동일한 scope를 적용한다.

원천을 읽을 권한과 파트너에게 재배포할 권한은 별도로 검토한다. 원천별 보존·이용범위는 registry의 정책으로 둔다.

RAW와 감사 데이터도 보존 기간과 접근 정책이 필요하다. 삭제가 필요한 자료는 projection, 검색, export, cache와 복구 절차까지 고려한다. 과거 backup/event replay로 삭제된 정보가 되살아나지 않도록 삭제 정책을 재적용한다. 감사에는 필요한 최소 근거만 남긴다.

## 16. 운영 관측과 UI

관측 지도는 등록된 목표 연결과 실제 관측된 연결을 분리한다. 코드 변경만으로 운영이 바뀌었다고 표시하지 않는다.

홈은 일반적인 전체 건수보다 다음 질문에 답한다.
- 지금 무엇을 믿을 수 있는가?
- 어느 제공본이 오래됐거나 발행에 실패했는가?
- 원천과 정본의 값이 왜 다른가?
- 어떤 변경이 승인/충돌 검토를 기다리는가?
- 어느 연결이 목표와 실제가 다른가?

상세의 기본 동선은 `현재값 → 출처 → 적용 규칙 → 제공 결과 → 변경/발행 이력`이다. 가격 필드를 선택하면 값·단위·오퍼·기간·정책·유효시점·입력 버전·수정 근거가 이어져야 한다. 개발용 JSON과 전체 graph는 보조 보기로 제공한다.

운영 연결 상태와 표준 채택 상태를 분리한다. 최신성 UNKNOWN을 정상으로, 미관측 consumer를 실패나 성공으로 임의 표현하지 않는다.

타이포·header·table/detail·bottom action·focus·오류·충돌은 AI Core profile을 적용한다. 모바일은 핵심 판단과 승인 동선, 데스크톱은 대사와 영향 분석에 맞게 구성한다. 화면 미리보기의 정상 표시와 실제 consumer runtime 관측은 별도다.

## 17. 외부 규격의 적용

| 참고 규격 | 적용할 책임 | 규격만으로 보장되지 않는 것 |
|---|---|---|
| OpenAPI + JSON Schema | API와 자료형의 명세·검증 | 업무 의미와 권한의 정확성 |
| CloudEvents | 이벤트 공통 표현과 외부 교환 | 중복 제거, 순서, exactly-once 실행 |
| W3C PROV | 원천·활동·책임자·파생 관계 모델 | 보관 정책, 실제 증거의 진실성 |
| OpenTelemetry | trace/metric/log 상관관계 | 계약 체결이나 발행 완료의 업무 증거 |
| WCAG 2.2 AA | 접근성 목표와 검증 기준 | 실제 화면을 시험하지 않은 적합성 선언 |

버전은 사용 도구와 소비자에서 검증한 것으로 고정한다. 공통 규격과 외부 표준의 차이는 adapter 또는 승인된 profile로 기록한다. 규격 이름을 나열하는 것을 인증이나 전면 준수로 표현하지 않는다.

## 18. AI 사용 경계

AI는 출처 설명·후보 매핑·이상 감지·변경 제안을 돕는다. 그러나 추론 결과가 자동으로 canonical이 되지 않는다. 출력은 schema와 도메인 검증을 통과해야 하고, 권한 있는 actor의 검토/승인 및 동일 command 경로를 따른다.

외부 원문 안의 지시문은 데이터로 취급하며 권한·배포·보안 정책 변경 명령으로 실행하지 않는다. AI에게 production raw database 임의 쓰기 권한을 주지 않는다. 다중 AI의 의견 수가 운영 증거를 대체하지 않는다.

## 19. 초기 구현과 보류 범위

첫 검증 범위는 공급 경로 하나, Catalog의 제한된 offer 집합, 두 소비처다. 기존 동작을 버리고 새 계산기를 만드는 대신 기존 원문/정본/발행 경로의 현재 소유권과 실행 revision을 먼저 확인한다.

1. 의미·writer·binding·제공 계약을 등록한다.
2. read-only adapter와 합성 fixture로 현재 결과를 재현한다.
3. 동일 입력 기준으로 두 consumer의 제공본과 단위·오퍼·기간·보증금 정합성을 대사한다.
4. 콘솔에서 원문부터 제공 결과까지 추적한다.
5. 변경 요청·충돌·발행·rollback을 비운영 환경에서 검증한다.
6. 독립 검토와 runtime 증거 뒤 제한된 읽기 전환을 승인받는다.
7. 쓰기 권한 이전은 별도 승인과 차단 시험 뒤 수행한다.

처음부터 고객·계약·정산 전체의 이관, 물리 DB 통합, 범용 매핑 프로그래밍 언어, Kafka/전면 event sourcing, data mesh, AI 자동수정, 모든 화면 재설계를 수행하지 않는다.

## 20. 수용 시험 — 아직 실행하지 않은 요구사항

| ID | 실패/변경 상황 | 통과 조건 |
|---|---|---|
| T01 | 보증금 단위 미상 | 0원/추측값으로 공개하지 않음 |
| T02 | 다른 오퍼의 가격/조건 혼합 | offer invariant 검사에서 차단 |
| T03 | 동일 command 재전송 | 동일 결과 또는 명확한 입력 충돌, 중복 부작용 없음 |
| T04 | 두 운영자 동시 수정 | 기대 revision 충돌과 입력 보존 |
| T05 | commit 뒤 응답 유실 | receipt 재조회로 실제 결과 복원 |
| T06 | 이벤트 중복·역순·누락 | 중복 처리 방지, 이전 revision 미적용, gap 대사 |
| T07 | 구 writer가 전환 뒤 다시 실행 | 실제 권한/저장 경계에서 차단 |
| T08 | 제공본 생성 중 중단 | 검증 안 된 부분 release를 활성화하지 않음 |
| T09 | 신규 가격·정책 적용 | 기존 견적/계약 snapshot 유지 |
| T10 | 다른 tenant의 ID/파일 요청 | 본문·검색·파일·cache 경로에서 모두 차단 |
| T11 | 내부 민감 필드 추가 | 공개 dataset에 자동 유출되지 않음 |
| T12 | 원천 수집 실패/누락 | 전체 상품 삭제·retire로 오판하지 않음 |
| T13 | 관리 UI/수집 worker 장애 | 허용된 조회 경로 유지, 엄격한 업무확정은 보류 |
| T14 | 삭제 후 backup/replay | 삭제 정책 재적용, 정보 재노출 없음 |
| T15 | 소비 앱 장기 미접속 | 저장 성공과 미관측 상태를 구분 |
| T16 | dataset 계약/의미 변경 | 호환성 검증 없이는 기존 consumer 자동 전환 없음 |
| T17 | 검색·필터·페이지 이동 | 같은 release/query/scope 기준 유지 |
| T18 | 원천 값이 임시 override 이후 변경 | 등록된 만료/재검토 정책대로 처리 |

성공 경로 테스트만으로 production-ready로 선언하지 않는다. 측정되지 않은 성능·가용성·복구시간은 미확인으로 남긴다.

## 21. 인수인계와 미확정

다음 작업의 시작점은 코드 대량 생성이 아니라 소유권/의미/제공 계약 하나의 확정과 기존 실행 경로의 재현이다.

구현 전 확정해야 할 항목:
- 공유 데이터와 독립 도메인 범위의 승인된 profile
- 현재 실제 writer와 IAM/rules의 차단 가능성
- 공급사별 source authority와 재배포 범위
- dataset별 허용 지연·만료 행동·복구 목표
- 첫 read 전환 대상과 필요한 독립 검증자
- 운영 실행 경로와 승인 절차

이 문서 작성으로 기존 scheduler를 켜거나 옮기지 않는다. Actions 실행·배포·권한 변경·실데이터 쓰기·기존 문서의 정본 승격은 수행 범위 밖이다. 해당 작업의 최신 handoff/approval 정책을 구현 담당이 재확인한다.

## 22. 공개 기술 근거

- OpenAPI: https://spec.openapis.org/oas/latest.html
- JSON Schema 2020-12: https://json-schema.org/draft/2020-12
- CloudEvents: https://cloudevents.io/
- W3C PROV overview: https://www.w3.org/TR/prov-overview/
- OpenTelemetry observability: https://opentelemetry.io/docs/concepts/observability-primer/
- WCAG 2.2: https://www.w3.org/TR/WCAG22/
- Firestore transactions: https://firebase.google.com/docs/firestore/manage-data/transactions
- Firestore event delivery limitations: https://firebase.google.com/docs/functions/firestore-events
- Firestore server authorization boundary: https://firebase.google.com/docs/firestore/security/rules-conditions

기술 문서는 2026-09-20 검토에 사용했다. 이 링크들은 설계 근거이며 이 프로젝트의 구현 완료나 인증을 뜻하지 않는다.
