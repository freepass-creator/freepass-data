# FreePass Data Architecture v1

Status: DESIGN BASELINE
Date: 2026-09-20

## 1. 목표

최종 목표는 모든 FreePass consumer가 각자 Firebase collection을 직접 읽는 구조에서 벗어나, **FreePass Data의 versioned contract를 통해 동일한 업무 사실을 소비**하는 것이다.

```
Sources
  ↓
Ingestion
  ↓
RAW Snapshot (immutable)
  ↓
Normalize / Map / Validate
  ↓
Canonical SSOT
  ↓
Projection / Distribution
  ↓
Admin / Sales / ERP.com / Estimate / Partner
```

Firebase는 계속 사용할 수 있다. 단, Firebase의 물리 collection 구조는 FreePass Data 내부 구현이 되고 consumer의 public contract가 되어서는 안 된다.

---

## 2. 소유권 경계

### FreePass Data가 소유
- Entity identity
- Canonical schema
- Source registry
- RAW snapshot
- Mapping / normalization
- Field authority
- Manual override
- Revision
- Data validation
- Lineage
- Projection
- Distribution contract
- Change event
- Audit / receipt
- Freshness / sync health

### 각 제품이 계속 소유
- Admin: 운영 workflow와 관리자 use case
- Sales: 영업 workflow, 상태 의미, 화면/행동
- Estimate: 견적 계산 엔진과 견적 기능
- ERP.com: 공개 상품 경험과 presentation
- AI Core: 공통 UI/UX, interaction, workflow, contract/governance 표준

즉 **Data가 업무 앱을 흡수하지 않는다. 데이터 사실과 전달 계약만 중앙화한다.**

---

## 3. 논리 데이터 계층

### 3.1 Source Registry
모든 입력원을 등록한다.

예:
- Google Sheet
- Existing Firestore
- Existing RTDB (migration only)
- Partner feed
- Encar
- Admin command
- Sales command

필수 metadata:
- source_id
- source_type
- owner
- authority_scope
- polling_or_push
- expected_freshness
- schema_version
- last_observed_at
- health

### 3.2 RAW Snapshot
수집 당시 원문을 그대로 보존한다.

원칙:
- immutable
- source timestamp와 ingestion timestamp 분리
- source record key 보존
- source revision/hash 보존
- 재처리 가능
- 운영자 UI에서 수정 금지

### 3.3 Normalize Candidate
Parser / normalizer / mapper 결과.

상태:
- candidate
- valid
- warning
- rejected
- conflict

이 단계에서 공급사별 필드명을 canonical field로 바꾸고 타입/단위/코드/금액을 정규화한다.

### 3.4 Canonical SSOT
소비 앱이 신뢰하는 업무 사실.

초기 domain:
- product
- vehicle
- offer
- pricing
- policy

확장 domain:
- customer
- sales_activity
- application
- contract
- settlement
- document metadata

모든 canonical entity 공통 envelope:

```json
{
  "entity_type": "product",
  "entity_id": "prod_...",
  "schema_version": "1.0",
  "revision": 128,
  "status": "ACTIVE",
  "validation_status": "VALID",
  "freshness": {
    "observed_at": "...",
    "materialized_at": "..."
  },
  "source_refs": [],
  "lineage_id": "lin_...",
  "updated_at": "...",
  "updated_by": "..."
}
```

### 3.5 Override Layer
운영자가 Data Console에서 직접 바꾸는 값은 RAW를 고치지 않고 override로 남긴다.

```json
{
  "override_id": "ovr_...",
  "entity_type": "product",
  "entity_id": "prod_...",
  "field": "deposit.amount",
  "before": 3000000,
  "after": 4000000,
  "reason": "운영 조건 변경",
  "authority": "FREEPASS",
  "expected_revision": 128,
  "effective_at": "...",
  "expires_at": null,
  "actor": "user:...",
  "created_at": "..."
}
```

Materializer는:
`normalized candidate + authority rule + active override = canonical value`
순으로 최종 값을 만든다.

이 구조 때문에 다음 source sync가 와도 승인된 FreePass override가 이유 없이 사라지지 않는다.

### 3.6 Projection
consumer별로 필요한 데이터만 제공한다.

예:
- public_catalog
- admin_catalog
- sales_catalog
- estimate_inputs
- partner_export

Projection은 Canonical의 복사 정본이 아니다. **특정 revision에서 파생된 읽기 모델**이다.

---

## 4. Field Authority

각 canonical field는 authority 정책을 가진다.

- SOURCE_WINS
- FREEPASS_WINS
- CALCULATED
- SYSTEM
- MANUAL_OVERRIDE_ALLOWED
- REVIEW_REQUIRED

예:

| Field | Authority | Manual edit |
|---|---|---|
| source_vehicle_id | SOURCE_WINS | no |
| display_name | FREEPASS_WINS | yes |
| monthly_price | FREEPASS_WINS | yes |
| calculated_discount | CALCULATED | no |
| created_at | SYSTEM | no |
| supplier_cost | REVIEW_REQUIRED | controlled |

Authority는 UI 권한이 아니라 데이터 무결성 규칙이다.

---

## 5. Read Gateway

장기적으로 consumer는 Firebase collection을 직접 읽지 않는다.

권장 contract:

- `GET /v1/catalog/products`
- `GET /v1/catalog/products/{id}`
- `GET /v1/vehicles/{id}`
- `GET /v1/offers/{id}`
- `GET /v1/pricing/{id}`
- `GET /v1/lineage/{entityType}/{id}`
- `GET /v1/meta/schema/{entityType}`

모든 응답은:
- schema_version
- revision
- generated_at
- freshness
- request_id
를 포함한다.

Consumer는 물리 DB path가 아니라 이 contract에 의존한다.

고빈도 공개 상품 조회는 projection/cache/CDN을 사용할 수 있지만 contract 의미는 동일하게 유지한다.

---

## 6. Write / Command Gateway

직접 Firestore update를 public write contract로 사용하지 않는다.

예:
- `POST /v1/commands/product/{id}/override`
- `POST /v1/commands/product/{id}/publish`
- `POST /v1/commands/application/{id}/transition`

필수 입력:
- command_id
- idempotency_key
- expected_revision
- actor
- reason
- patch/intent

처리:
1. authn/authz
2. expected revision 검사
3. schema validation
4. authority validation
5. domain validation
6. transaction
7. revision increment
8. event append
9. projection rebuild
10. delivery receipt
11. response

충돌 시 silent overwrite 금지. `409 revision conflict`로 반환하고 UI는 AI Core `workflow.conflict`를 사용한다.

---

## 7. Event Contract

최소 이벤트:

- source.observed
- ingestion.started
- ingestion.completed
- ingestion.failed
- candidate.normalized
- candidate.rejected
- entity.changed
- override.created
- override.revoked
- projection.published
- consumer.acknowledged
- delivery.failed

공통 필드:
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

---

## 8. Consumer Contract

각 consumer를 registry에 등록한다.

예:

```json
{
  "consumer_id": "freepass-sales",
  "domains": ["product", "vehicle", "pricing"],
  "projection": "sales_catalog",
  "mode": "PULL",
  "contract_version": "v1",
  "last_ack_revision": 128,
  "health": "HEALTHY"
}
```

상태:
- CONNECTED
- DEGRADED
- LAGGING
- ERROR
- MIGRATING
- LEGACY_DIRECT

Data Console은 consumer가 어느 revision까지 읽었는지 보여준다.

---

## 9. Data Console

메뉴:
- 홈
- 데이터
- 흐름
- 원천
- 연결
- 변경이력
- 규칙
- 설정

Entity Detail 탭:
- 현재값
- 원문
- 변환
- 출처
- 소비처
- 변경이력

필드 클릭 시 반드시 아래를 설명할 수 있어야 한다.
- current value
- source value
- source location/key
- transform rule
- authority
- override
- canonical revision
- consumers

---

## 10. AI Core UI/UX 적용

FreePass Data Console은 AI Core를 소비한다.

필수 feature:
- navigation.header
- data.table
- data.filter
- data.sort
- data.detail
- data.definition
- data.audit
- workflow.explicit-save
- workflow.conflict
- workflow.permission
- integration.sync
- integration.import
- feedback.progress
- feedback.inline-error

규칙:
- 한 section에 primary action 1개
- 중요 상태는 toast-only 금지
- save 요청 / server commit / projection publish / consumer ack를 서로 다른 상태로 취급
- search/filter 닫아도 selection/scroll/draft 복원
- mobile은 desktop 축소판으로 만들지 않음
- WCAG 2.2 AA

---

## 11. 완료 의미

수정 UX는 다음을 구분한다.

```
EDITED
  ↓
VALIDATED
  ↓
CANONICAL_COMMITTED
  ↓
PROJECTION_PUBLISHED
  ↓
CONSUMER_VISIBLE / ACKNOWLEDGED
```

화면은 최소한 Canonical commit까지 성공해야 "저장됨"으로 표시한다.
중요한 배포 대상은 projection/consumer 상태를 별도 표시한다.

즉 "버튼을 눌렀음"과 "업무 데이터가 반영됨"을 같은 의미로 사용하지 않는다.

---

## 12. 보안 / 개인정보

- GitHub repo에는 실제 고객 데이터와 secret을 저장하지 않는다.
- PII domain은 public projection에 포함하지 않는다.
- service identity별 read/write scope 분리
- field/domain별 authority 적용
- audit event append-only
- export는 scope/revision/expiry 명시
- production connector secret은 secret manager/environment binding 사용

현재 `freepass-data` repository는 생성 시 public으로 확인되었다. 운영 connector와 내부 schema가 들어가기 전에 repository visibility와 secret policy를 재확인해야 한다.

---

## 13. 비목표

- 모든 업무 로직을 FreePass Data로 이동하지 않는다.
- Estimate 계산 엔진을 Data가 소유하지 않는다.
- Sales pipeline 의미를 Data가 임의 재정의하지 않는다.
- Admin workflow를 Data가 재정의하지 않는다.
- 기존 Firebase를 하루에 한 번에 폐기하지 않는다.
