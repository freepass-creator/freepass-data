# freepasserp5 중앙 연결과 소비처 전환 상태

2026-09-21 사용자 직접 지정: 중앙 저장용 Firebase 프로젝트는 **freepasserp5**.
Firestore `(default)`, `asia-northeast3`를 실조회했다. RTDB는 사용하지 않는다.

## 코드에 반영한 연결

- `src/infra/firebase-target.ts`가 두 저장 어댑터의 유일한 대상 연결을 만든다.
- `FIREBASE_PROJECT_ID`를 명시해야 한다. production은 `freepasserp5`만 허용하며 emulator를 거부한다.
- 이미 만들어진 `freepass-data-target` 앱의 프로젝트가 다르면 중단한다. 기본 Firebase 앱이나 ADC 프로젝트 추정으로 우회하지 않는다.
- production은 메모리 데모 실행을 거부한다. API 부팅이 Firestore Release를 생성/활성화하지 않는다.
- 기존 개발 API 전체는 memory에서만 실행할 수 있다. Firestore 조회도 인증 없는 개발 경로로 우회할 수 없다. 운영 명령은 서비스 신원과 권한 검증이 완성될 때까지 차단한다.

## 독립된 소비처 읽기 서버

`npm run serve:consumers`는 읽기 전용 서버다. worker, 시드, command endpoint, 게시 기능이 없다.
서버 환경에 `FIREBASE_PROJECT_ID=freepasserp5`, `FREEPASS_DATA_DRIVER=firestore`, 서비스의 ADC/workload identity,
`FREEPASS_DATA_CONSUMERS_JSON`을 설정한다. 운영에서는 `NODE_ENV=production`도 명시한다.
기본 바인딩은 localhost다. 배포 인프라의 TLS/서비스 접근 정책 검토 후에만 HOST를 변경한다.
이 읽기 서버는 NODE_ENV 누락에도 다른 프로젝트, memory, emulator를 거부한다. 런타임 객체에는 읽기 메서드 두 개만 제공하며 IAM의 읽기 전용 설정도 별도로 필요하다.

등록된 backend는 `GET /v1/consumers/{consumerId}/catalog`에 소비처 전용 Bearer를 보낸다.
토큰은 Secret Manager 등 서버의 비밀 저장소에서 공급하고 브라우저/Sheets 셀/로그에 넣지 않는다.
다른 소비처의 토큰을 재사용하거나 요청자가 projection을 선택할 수 없다.
허용된 public schema, ACTIVE 상태, manifest 및 input/data digest를 확인하고 실제 사용한 release ID를 응답한다.
현재 빈 release도 거부한다. 정상적인 전체 품절에 따른 빈 게시 허용은 별도 증거 계약이 필요하다.
이는 데이터 무결성 검사이며 최신성·가격 의미·소비처 parity 검증을 대체하지 않는다.

| 소비처 | 이번 코드 | 운영 상태 |
| --- | --- | --- |
| ERP.com | `erp-com` 서비스 등록 및 ERP public read 계약 | 기존 ERP5 직접 읽기 유지, 전환 전 |
| 각 화이트라벨 | `whitelabel-<slug>` 개별 등록·토큰 | 실제 도메인 목록/노출 권한/캐시/배포 검증 전 |
| F01 | 전용 게시 계약 필요 | 기존 출력 경로 유지 |
| F86 | 전용 게시 계약 필요 | 기존 출력 경로 유지 |
| Admin | 기존 PR12와 새 Release 증거 게이트 통합 필요 | Policy parity 및 인증/IAM 검증 전 |

F01/F86/Admin을 ERP public 계약에 억지로 연결하지 않는다. 원문 옵션·시트 게시 필드와 Admin 내부 정책 정보는 별도 계약이 필요하다.
등록되지 않은 소비처는 응답을 받을 수 없다. 웹에 서비스를 공개하거나 운영 소비처를 전환한 상태가 아니다.

## 반복 가능한 읽기 전용 점검

서비스 인증 환경: `npm run check:central-firestore`.
로컬의 명시적 gcloud 로그인으로 확인: `npm run check:central-firestore -- --gcloud`.
명령은 여섯 collection의 count만 읽고 값/고객 원문을 출력하지 않는다. 조회별 readTime을 기록한다.
동일 시각의 일관된 상품 스냅샷이나 전체 대사가 아니며 `cutoverAuthorized`는 항상 false다.

2026-09-21T08:41:15Z 실제 결과:

| collection | count |
| --- | ---: |
| products | 1659 |
| policy | 81 |
| catalog_products | 0 |
| catalog_offers | 0 |
| catalog_policies | 0 |
| projection_active | 0 |

결과: `HOLD_MISSING_CANONICAL_OR_RELEASE`. 연결에 성공해도 빈 정본으로 소비처를 전환하면 안 된다.
로컬 기본 ADC는 없으며 명시적 gcloud 읽기는 성공했다. gcloud 사용자 로그인을 운영 서비스 인증으로 설치하지 않았다.
Cloud Run 조회는 `run.googleapis.com` 비활성으로 실패했다. API를 활성화하거나 서비스/IAM을 만들지 않았다.

## 전환에 남은 작업

1. ERP5 원문 수집과 엄격한 변환 → 검토 가능한 RAW/Candidate → 승인된 Canonical/Policy.
2. PR12 Admin projection과 현재 manifest/lineage/READY 게이트 통합. 기존 PR12를 그대로 병합하면 이 계약과 호환되지 않는다.
3. F01/F86 출력 필드를 보존하는 계약, 소비처 전체에 공통으로 추적할 source/release 버전 연결.
4. 운영 API 호스팅/서비스 identity/IAM을 확정하고 실제 서버에서 읽기 검증.
5. 각 소비처 mapper와 shadow 대사. 실시간 계약락/판매가능 상태 경계 보존.
6. 대상별 전환, 실패 시 기존 경로 유지, 실제 화면/시트/API 응답 재조회. 전 대상 검증 전에는 전체 완료가 아니다.

ERP5 순수 변환은 별도 `codex/erp5-product-mapping-20260921` 작업이 담당한다.
이 작업은 Firebase binding/읽기 API/연결 점검만 담당하여 공용 미커밋 파일을 덮어쓰지 않는다.

## 검증 기록

- Codex: 구조 검사, TypeScript 빌드, API 인증/변조/empty HOLD, 실제 entrypoint 차단, named-app 재사용 검사, 읽기 전용 Firestore reader 검사 통과. 위 count는 운영 REST 재조회 증거다.
- Cursor Agent: 초기 FAIL 두 항목(소비 서버 NODE_ENV 누락 시 다른 프로젝트 허용, 개발 API의 Firestore 무인증 조회)을 수정했다. 동일 worktree 재검토에서 이 코드 범위 PASS. 배포/전체 소비처 전환 승인은 아니다.
- Claude Code: 주간 한도로 UNAVAILABLE. Gemini CLI: 계정 서비스 403으로 UNAVAILABLE. 둘을 PASS로 계산하지 않는다.
- 미해결 코드 검토 이견은 없으며, 운영 이전 필수 교차검증과 실제 소비처 대사는 미완료다.
- 별도 ERP5 변환 커밋 `9895b518675e75b9371bdf169e7f11ffb5d88198`을 인계받았으며 이번 런타임 변경에 자동 병합하거나 운영 게시하지 않았다.
