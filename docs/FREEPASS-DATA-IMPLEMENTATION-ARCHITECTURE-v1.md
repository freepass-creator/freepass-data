# FreePass Data — Implementation Architecture Proposal v1

Status: PROPOSED / REVIEW REQUIRED  
Date: 2026-09-20  
Repository: `freepass-creator/freepass-data`  
Purpose: 구현 전에 구조를 잠그기 위한 기술 설계 정본 후보

---

## 0. 이 문서의 목적

이 문서는 FreePass Data를 단순한 Firebase 관리 화면이나 공용 DB로 만들지 않고,
향후 FreePass Admin / Sales / ERP.com / Estimate / Partner / 신규 프로젝트가 공통으로 사용하는
중앙 데이터 플랫폼으로 구현하기 위한 사전 설계안이다.

**이 문서는 아직 구현 승인본이 아니다.**

다른 AI/개발 세션은 이 문서를 기준으로 다음 관점에서 반론과 보완을 제시해야 한다.

- 데이터 정본/권한 경계가 모호하지 않은가
- Firebase 의존을 잘 숨겼는가
- 프로젝트별 업무 로직을 Data가 침범하지 않는가
- 데이터 유실/중복/충돌/재시도/부분 실패를 다룰 수 있는가
- 과거 견적/계약의 시점 데이터가 보존되는가
- Projection과 Canonical의 정본 관계가 명확한가
- 보안/PII/서비스 권한 경계가 충분한가
- AI Core 규격을 소비하면서도 runtime coupling이 생기지 않는가
- 향후 분리/확장 가능한가
- 지금 단계에서 과설계된 부분은 없는가

최종 구현은 이 문서를 REVIEWED → APPROVED로 승격한 뒤 시작한다.

---

# 1. Architectural Decision

## 1.1 FreePass Data의 정의

**FreePass Data = Firebase Owner + Domain Data SSOT + Data Gateway + Control Plane**

FreePass Data가 책임지는 것:

- Firebase project binding
- Firestore
- Storage
- Firebase Auth 연계
- Security Rules / IAM boundary
- Index
- Emulator
- Backup / restore
- Source ingestion
- RAW snapshot
- Canonical data
- Field authority
- Revision
- Audit
- Lineage
- Projection
- Distribution
- Consumer health
- Data release
- Migration switches

FreePass Data가 책임지지 않는 것:

- Sales 영업 workflow 의미
- Admin 계약/출고/정산 workflow 의미
- Estimate 계산 엔진
- ERP.com UI/상품 경험
- AI Core 공통 표준의 소유

즉 **데이터 중앙화 ≠ 업무 로직 중앙화**다.

---

# 2. AI Core와의 관계

AI Core는 회사 전체 공통 표준의 상위 정본이다.

AI Core가 정의:

- UI/UX 규격
- Schema / ID / type / date / money / enum 규칙
- API Contract
- Adapter Contract
- Event Contract
- Error Contract
- Idempotency
- Revision / Conflict
- Audit / Evidence / Receipt
- Workflow 표준
- 접근성
- 국제화
- Observability 원칙

FreePass Data는 이를 FreePass domain에 적용하는 **실전 consumer**다.

### 금지

FreePass Data runtime이 AI Core HEAD를 실시간 참조하지 않는다.

### 적용

```
AI Core candidate
  ↓
Conformance Test
  ↓
FreePass Data lock
  ↓
Production
```

예상 파일:

```
packages/ai-core/ai-core.lock.json
```

예:

```json
{
  "repository": "freepass-creator/ai-core",
  "revision": "<pinned commit>",
  "uiUxVersion": "1.x",
  "contractVersion": "1.x"
}
```

---

# 3. Architecture Style

## 3.1 시작 형태

**TypeScript Modular Monolith**

처음부터 microservice로 분할하지 않는다.

이유:

- 현재 핵심 위험은 규모보다 데이터 의미/정본/권한/전환
- 여러 service로 나누면 운영 복잡성만 먼저 증가
- domain boundary는 코드 레벨에서 먼저 강제
- 실제 부하/보안 요구가 확인되면 module 단위로 분리 가능

---

# 4. Proposed Tech Stack

## Backend

- TypeScript
- Node.js 22
- Fastify
- AJV
- JSON Schema
- OpenAPI
- Firebase Admin SDK
- Firestore
- Cloud Storage

## Console

- Next.js
- React
- TypeScript
- AI Core UI/UX contract + token

## Contract

```
JSON Schema
  ↓
Generated TypeScript Types
  ↓
Runtime Validation
  ↓
OpenAPI
```

TypeScript interface 단독을 public contract 정본으로 삼지 않는다.

---

# 5. Repository Structure

```
freepass-data/

apps/
  api/
  console/
  worker/

packages/
  contracts/
  domain/
  commands/
  ingestion/
  canonical/
  projection/
  release/
  sdk/
  audit/
  lineage/
  auth/
  observability/
  ai-core/

adapters/
  firebase/
  google-sheet/
  legacy-welrixtable/
  legacy-freepasserp3/
  partner/

infra/
  firebase/
  firestore/
  storage/

docs/
tests/
scripts/
```

---

# 6. First Domain Scope

V1에서 모든 FreePass 데이터를 가져오지 않는다.

초기 scope:

- Vehicle
- Product
- Offer
- PriceTerm
- Policy

후속:

- Quote snapshot
- Customer
- Sales Activity
- Application
- Contract
- Delivery
- Settlement

Sales 운영 고객 DB는 초기 migration 대상에서 제외한다.

---

# 7. Domain Model

## 7.1 Vehicle / Product / Offer 분리

```
Vehicle
  ↓
Product
  ↓
Offer
  ↓
PriceTerm
```

같은 차량에 여러 공급사/기간/보증금/보험 조건이 존재할 수 있다.

### 절대 금지

서로 다른 Offer의:

- 최저 월대여료
- 최저 보증금
- 다른 보험 조건

을 합쳐 실제 존재하지 않는 상품을 생성하지 않는다.

---

# 8. Core Entity Envelope

모든 Canonical Entity는 최소 다음 공통 metadata를 가진다.

```ts
type EntityEnvelope = {
  id: string;
  schemaVersion: string;
  revision: number;

  createdAt: string;
  updatedAt: string;

  createdBy: ActorRef;
  updatedBy: ActorRef;

  lineageId: string;

  sourceRevision?: string;

  validationStatus:
    | 'VALID'
    | 'WARNING'
    | 'INVALID';
};
```

---

# 9. Important Value Semantics

0 / null / unknown을 섞지 않는다.

예: deposit

```ts
type DepositState =
  | 'KNOWN'
  | 'ZERO'
  | 'UNKNOWN'
  | 'NOT_APPLICABLE';
```

`0원`과 `확인 안 됨`은 다른 사실이다.

---

# 10. Data Layers

```
SOURCE
  ↓
RAW
  ↓
NORMALIZED CANDIDATE
  ↓
CANONICAL
  ↓
PROJECTION
  ↓
CONSUMER
```

## SOURCE

- Google Sheet
- legacy Firebase
- partner API
- Encar
- manual command

## RAW

- immutable
- source record key 보존
- source timestamp / ingestion timestamp 분리
- checksum/revision 보존
- 재처리 가능
- Console 직접 수정 금지

대형 원문 snapshot은 Cloud Storage 사용.

## NORMALIZED CANDIDATE

- parser
- normalizer
- mapper
- validator

상태:

- CANDIDATE
- VALID
- WARNING
- REJECTED
- CONFLICT

## CANONICAL

FreePass consumer가 신뢰하는 업무 사실.

## PROJECTION

Consumer별 읽기용 파생 모델.

Projection은 SSOT가 아니다.

---

# 11. Source / Normalize Pipeline

```
Connector
  ↓
Parser
  ↓
Normalizer
  ↓
Mapper
  ↓
Validator
  ↓
Canonicalizer
  ↓
Projector
```

예상 interface:

```ts
interface SourceAdapter<T> {
  fetch(): Promise<T>;
}

interface Parser<I, O> {
  parse(input: I): O;
}

interface Normalizer<I, O> {
  normalize(input: I): O;
}

interface Validator<T> {
  validate(input: T): ValidationResult;
}
```

공급사별 차이는 Adapter / Parser / Mapper에서 흡수한다.

---

# 12. Canonicalizer

Canonicalizer는 단순 copy가 아니다.

```
Normalized Candidate
+ Authority Rule
+ Approved Override
= Canonical Value
```

예상 호출:

```ts
canonicalize({
  source,
  candidate,
  currentEntity,
  authorityRules,
  overrides
});
```

---

# 13. Field Authority

초기 권한 유형 후보:

- SOURCE_WINS
- FREEPASS_WINS
- CALCULATED
- SYSTEM
- MANUAL_OVERRIDE_ALLOWED
- REVIEW_REQUIRED

하지만 단순 enum 하나로 끝내지 않는다.

Field Authority에는 최소:

- canonical owner
- allowed writers
- approval required
- conflict policy
- override allowed
- override expiration
- source refresh behavior

를 정의해야 한다.

---

# 14. Direct Edit = Command

Console에서 Firestore document를 직접 update하지 않는다.

금지:

```ts
updateDoc(...)
```

public business write는 반드시 Command를 사용한다.

예:

```ts
type UpdateOfferPriceCommand = {
  commandId: string;
  idempotencyKey: string;

  offerId: string;
  expectedRevision: number;

  termMonths: number;
  monthlyRent: Money;

  reason: string;
  actor: ActorRef;
};
```

처리:

```
Command
  ↓
Authentication
  ↓
Authorization
  ↓
Expected Revision
  ↓
Field Authority
  ↓
Domain Validation
  ↓
Transaction
  ↓
Revision +1
  ↓
Audit
  ↓
Outbox
```

---

# 15. Concurrency

Last Write Wins를 기본값으로 사용하지 않는다.

Client:

```
expectedRevision: 17
```

Server actual:

```
revision: 18
```

Response:

```
409 REVISION_CONFLICT
```

UI는 AI Core `workflow.conflict` 패턴을 사용한다.

---

# 16. Idempotency

V1부터 적용한다.

HTTP:

```
Idempotency-Key: ...
```

DB:

```
commandReceipts/{idempotencyKey}
```

네트워크 오류 후 동일 명령을 재전송해도 side effect가 중복 발생하지 않아야 한다.

---

# 17. Transactional Outbox

Firestore transaction 안에서 외부 호출을 하지 않는다.

Transaction:

```
Canonical mutation
+ Audit
+ Outbox Event
```

Worker:

```
Outbox
  ↓
Projection rebuild
  ↓
Release
  ↓
Publish
```

이 구조를 기본값으로 사용한다.

---

# 18. Event Model

최소 event:

- source.observed
- ingestion.started
- ingestion.completed
- ingestion.failed
- candidate.normalized
- candidate.rejected
- entity.changed
- override.created
- override.revoked
- projection.built
- projection.failed
- release.activated
- delivery.failed

공통 field:

- event_id
- event_type
- entity_type
- entity_id
- source_revision
- target_revision
- correlation_id
- causation_id
- occurred_at
- actor
- evidence_refs

중복 delivery와 out-of-order event를 정상 상황으로 취급한다.

---

# 19. Firestore Logical Collections

초기 후보:

```
sources/
sourceRuns/

rawRecords/

vehicles/
products/
offers/
policies/

overrides/

commands/
commandReceipts/

outboxEvents/
auditEvents/

projectionReleases/
projections/

consumerBindings/
consumerStates/

deadLetters/
```

실제 collection path는 구현 전 schema review에서 최종 확정한다.

---

# 20. Projection

Canonical은 하나지만 Consumer가 필요로 하는 view는 다르다.

예:

```
Canonical Catalog
  ├─ erp-public
  ├─ admin-catalog
  ├─ sales-catalog
  └─ estimate-input
```

Project Dataset은 SSOT가 아니다.

---

# 21. Projection Release

Projection은 개별 row 덮어쓰기를 곧바로 active로 하지 않는다.

```
BUILDING
  ↓
VALIDATING
  ↓
READY
  ↓
ACTIVE
```

예:

```
Release 181 ACTIVE

Release 182 BUILDING
  ↓
VALIDATE
  ↓
READY
  ↓
activeRelease = 182
```

부분 build 실패 시 기존 Active Release를 유지한다.

이 원칙은 가격/보증금/기간/정책의 혼합 revision 노출을 줄인다.

---

# 22. Read API

예:

```
GET /v1/views/erp-public/products
GET /v1/views/sales-catalog/products
GET /v1/views/admin-catalog/products
GET /v1/views/estimate-input/vehicles
```

응답 meta:

```json
{
  "schemaVersion": "1.0",
  "releaseId": "rel_182",
  "revision": 182,
  "generatedAt": "...",
  "requestId": "..."
}
```

Consumer가 어떤 data release를 읽었는지 확인할 수 있어야 한다.

---

# 23. FreePass Data SDK

예상 package:

```
@freepass/data-sdk
```

Consumer code:

```ts
const products =
  await freepassData.erp.products.list();
```

Consumer code가 다음에 직접 의존하지 않게 한다.

- Firestore collection path
- Firebase project ID
- raw schema
- internal projection storage

SDK는 contract convenience layer이며 security boundary가 아니다.

---

# 24. Authentication / Authorization

Human:

```
Browser
  ↓
Firebase Auth
  ↓ ID Token
FreePass Data API
```

Service:

```
service:freepass-admin
service:freepass-sales
service:freepass-estimate
service:freepass-erp
```

권한 후보:

- catalog.read
- catalog.write
- pricing.read
- pricing.write
- source.read
- source.manage
- projection.read
- projection.publish
- override.create
- override.approve

App identity와 business organization scope를 분리한다.

---

# 25. Consumer Migration Switch

Read 전환:

```ts
type ReadMode =
  | 'LEGACY'
  | 'SHADOW'
  | 'FREEPASS';
```

Write 전환:

```ts
type WriteMode =
  | 'LEGACY'
  | 'FREEPASS';
```

Binding 예:

```ts
type ConsumerBinding = {
  environment: 'production' | 'staging';
  consumerId: string;
  domain: string;

  readMode: ReadMode;
  writeMode: WriteMode;

  contractVersion: string;

  updatedAt: string;
  updatedBy: string;
};
```

스위치는 프로젝트 전체가 아니라 **environment × project × domain** 단위로 관리한다.

---

# 26. Writer Authority

Read는 consumer별로 단계적으로 바꿀 수 있다.

Write는 동일 사실에 대해 동시 writer를 허용하지 않는 것을 기본으로 한다.

예:

```
authorityBindings/
```

```json
{
  "domain": "catalog",
  "writer": "freepass-data",
  "status": "ACTIVE"
}
```

기존 writer가 다시 실행돼도 실제 persistence boundary에서 거부되어야 한다.

---

# 27. Historical Snapshot

현재 Canonical 변경이 과거 견적/접수/계약을 바꾸면 안 된다.

Quote / Application / Contract는 확정 시점에 최소:

- canonical entity revision
- offer revision
- pricing revision
- policy revision
- calculation engine version
- selected input snapshot

을 보존해야 한다.

---

# 28. Audit

Audit는 append-only.

예:

```ts
type AuditEvent = {
  eventId: string;
  actor: ActorRef;

  entityType: string;
  entityId: string;

  action: string;

  before: unknown;
  after: unknown;

  reason: string;

  commandId: string;

  revisionBefore: number;
  revisionAfter: number;

  timestamp: string;
};
```

---

# 29. Lineage

Field level provenance를 지원할 수 있어야 한다.

```ts
type FieldProvenance = {
  entityId: string;
  fieldPath: string;

  sourceId: string;
  sourceRecordId: string;

  sourceValue: unknown;
  normalizedValue: unknown;
  canonicalValue: unknown;

  transformId?: string;
  overrideId?: string;

  sourceRevision?: string;
  canonicalRevision: number;
};
```

Console에서 현재값을 클릭하면 출처를 설명할 수 있어야 한다.

---

# 30. Console Information Architecture

```
홈
데이터
원천
흐름
프로젝트
릴리스
변경이력
오류
규칙
설정
```

초기 구현 우선순위:

1. Data Explorer
2. Entity Detail
3. Source / Lineage
4. Edit / Command
5. Projection
6. Release
7. Consumer status
8. Dashboard

예쁜 Dashboard부터 구현하지 않는다.

---

# 31. Console Entity Detail

Tab:

- 현재값
- 원문
- 변환
- 출처
- 프로젝트별 제공값
- 변경이력

Field click:

- canonical value
- source value
- transform
- authority
- override
- revision
- projection
- consumer

---

# 32. Write Completion Semantics

다음 상태를 구분한다.

```
EDITED
  ↓
VALIDATED
  ↓
CANONICAL_COMMITTED
  ↓
PROJECTION_BUILT
  ↓
RELEASE_ACTIVATED
  ↓
CONSUMER_SERVED
```

`버튼 클릭`을 완료로 간주하지 않는다.

또한 `Canonical 저장 성공`과 `Consumer가 실제 관측함`을 같은 의미로 사용하지 않는다.

---

# 33. Observability

필수 correlation:

- request_id
- command_id
- event_id
- correlation_id
- causation_id
- release_id
- actor
- source_revision
- canonical_revision

Log / Trace / Audit의 목적을 구분한다.

- Log: 운영 진단
- Trace: 요청 흐름
- Audit: 업무 변경 증거
- Receipt: 특정 실행 결과

---

# 34. Security Baseline

- 실제 고객 데이터 GitHub 저장 금지
- secrets GitHub 저장 금지
- PII public projection 금지
- public projection allowlist
- service identity 최소 권한
- Firebase Admin 권한과 사용자 권한 분리
- server-side authorization 필수
- destructive operation에는 explicit authority
- export에 scope/revision/expiry 명시

현재 repository visibility는 운영 connector와 내부 schema가 들어가기 전 반드시 재확인한다.

---

# 35. Testing Layers

```
Unit
Domain
Contract
Adapter
Projection
Release
Migration
Security
E2E
Conformance
```

필수 사례:

```text
같은 idempotency key → 한 번만 변경
stale revision → conflict
다른 Offer의 가격/보증금 합성 → 차단
UNKNOWN deposit → ZERO 변환 금지
projection build 실패 → active release 유지
public projection → supplier cost 노출 금지
old writer 재실행 → write 차단
current price 변경 → historical quote 불변
retry/out-of-order event → 최종 상태 수렴
```

---

# 36. First Vertical Slice

첫 구현은 하나의 흐름을 끝까지 완성한다.

범위:

**중고차 상품 Catalog**

```
Legacy Firebase
  ↓
Read-only Adapter
  ↓
RAW
  ↓
Normalizer
  ↓
Vehicle / Product / Offer
  ↓
Canonical Firestore
  ↓
ERP Public Projection
  ↓
Projection Release
  ↓
Read API
  ↓
ERP.com consumer
```

그리고 Console:

```
Product Detail
  ↓
Price Edit Command
  ↓
Validation
  ↓
Firestore Transaction
  ↓
Audit + Outbox
  ↓
Projection Rebuild
  ↓
New Release
  ↓
Activate
  ↓
ERP.com
```

이 vertical slice가 통과한 뒤 Admin / Estimate / Sales로 확장한다.

---

# 37. Recommended Implementation Order

```
01 contracts
02 domain model
03 Firestore logical schema
04 command infrastructure
05 auth / authority
06 revision / idempotency
07 audit
08 outbox
09 source registry
10 legacy read-only adapter
11 normalizer / validator
12 canonicalizer
13 projection engine
14 release engine
15 read API
16 data SDK
17 console data explorer
18 console entity detail
19 console command edit
20 lineage
21 shadow comparison
22 ERP.com pilot
23 Admin pilot
24 Estimate pilot
25 Sales catalog pilot
```

Sales customer/workflow migration은 Catalog 안정화 이후 별도 설계한다.

---

# 38. Deliberate Non-Goals for V1

V1에서 하지 않는다.

- 전면 microservice
- Kafka 도입
- 전면 event sourcing
- 모든 FreePass domain migration
- Sales 고객 DB 즉시 이전
- Contract/Settlement 즉시 이전
- 범용 ETL DSL
- 모든 consumer 실시간 websocket
- AI 자동 canonical commit
- 운영 데이터를 GitHub에 저장

확장성을 이유로 현재 필요 없는 운영 복잡성을 먼저 만들지 않는다.

---

# 39. Review Questions

다른 AI/개발 세션은 최소 아래 질문에 답해야 한다.

## Architecture
1. Modular Monolith 시작이 적절한가?
2. domain 경계가 충분한가?
3. Data와 업무 logic 경계가 모호한 곳은 없는가?

## Data Integrity
4. Canonical / Projection / Historical Snapshot 구분이 충분한가?
5. Offer 단위 조건 결합 무결성이 보장되는가?
6. override 정책이 source refresh와 충돌하지 않는가?

## Migration
7. read switch와 write authority 이전 절차가 충분한가?
8. 기존 writer 재실행을 실제로 차단할 수 있는가?
9. shadow parity 기준은 무엇이어야 하는가?

## Failure
10. outbox/retry/dead-letter 전략이 충분한가?
11. projection build 중 실패 시 atomic activation이 가능한가?
12. partial source failure에서 기존 정상 data를 잘못 삭제하지 않는가?

## Security
13. Firebase Admin SDK 사용 시 사용자 권한 검사가 충분한가?
14. public/private projection 정보 누출 방지가 충분한가?
15. partner/organization scope 확장을 수용할 수 있는가?

## AI Core
16. AI Core contract와 중복 정의한 부분은 없는가?
17. AI Core 변경이 runtime 장애로 전파되지 않는가?
18. conformance proof를 어떤 방식으로 남길 것인가?

## Product
19. Console에서 기술 정보가 운영자에게 과도하지 않은가?
20. 직접 수정이 업무 command와 override를 혼동하지 않는가?

---

# 40. Approval Gate

구현 시작 전 다음이 충족되어야 한다.

- [ ] 최소 2개 독립 리뷰 관점 확보
- [ ] 중대한 반론/충돌 항목 정리
- [ ] Canonical V1 entity 확정
- [ ] Product / Offer / PriceTerm schema 확정
- [ ] Field Authority rule 확정
- [ ] Projection V1 계약 확정
- [ ] ERP Public Projection pilot 확정
- [ ] Write Command / Revision / Idempotency 규칙 확정
- [ ] Audit / Outbox / Release 규칙 확정
- [ ] Security boundary 확정
- [ ] Legacy read-only source 목록 확정
- [ ] AI Core pinned revision / conformance 방식 확정

승인 후 Status를:

```
APPROVED FOR IMPLEMENTATION
```

으로 변경한다.

---

# 41. Final Design Principle

**앱은 Firebase를 소유하지 않는다.**

**FreePass Data가 Firebase를 소유한다.**

**앱은 FreePass Data의 계약을 소비한다.**

**Canonical은 업무 사실의 정본이다.**

**Projection은 소비용 파생물이다.**

**업무 의미와 workflow의 결정권은 각 domain이 유지한다.**

**AI Core는 전체 구조의 공통 표준과 검증 체계를 제공한다.**

그리고 가장 중요한 원칙:

> 확장성이란 처음부터 모든 것을 크게 만드는 것이 아니라,
> 나중에 바꾸기 어려운 경계를 지금 정확히 정의하는 것이다.
