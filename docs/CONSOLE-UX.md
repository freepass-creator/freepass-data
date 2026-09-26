# FreePass Data Console UX

Status: DOMAIN UX REFERENCE — NOT IMPLEMENTATION AUTHORITY
AI Core consumer: YES

> 이 문서는 FreePass Data가 소유하는 데이터 의미·상태·증거 표현 규칙을 정의한다.
> 실제 page shell, route, component, design token의 구현 정본은 해당 제품 UI 저장소가 소유한다.
> FreePass Admin의 CI/BI와 공통 디자인 언어는 참고하지만, Data Console은 데이터 관제·검증 업무에 맞는 정보 밀도와 composition을 우선한다.

## 1. 정보 구조

```
홈
데이터
흐름
원천
연결
변경이력
규칙
설정
```

## 2. 홈

목적: 데이터 관제실.

표시:
- canonical entity count
- validation warning/error
- source freshness — source runtime evidence가 있을 때만 값 표시, 없으면 `NOT_EVALUATED`
- active ingestion
- consumer lag — delivery/ack evidence가 있을 때만 값 표시, 없으면 `NOT_EVALUATED`
- failed deliveries
- recent changes
- health coverage — evaluated / not evaluated 차원을 함께 표시

원칙:
- overall health가 `HEALTHY`여도 평가하지 않은 차원이 있으면 이를 숨기지 않는다.
- `SOURCE_FRESHNESS`, `SOURCE_TO_CANONICAL_PARITY`, `CONSUMER_MIGRATION_STATE`처럼 현재 health contract가 평가하지 않는 항목을 정상/초록 상태로 추정 표시하지 않는다.
- 숫자를 만들 수 없는 상태는 0으로 보정하지 말고 `미평가`, `증거 없음`, `관측 필요`처럼 근거 부족 상태를 명시한다.

중앙 pipeline:

```
Sources → RAW → Normalize → Canonical → Projection → Consumers
```

각 노드를 누르면 해당 목록으로 이동한다.

## 3. 데이터

Domain tabs:
- 상품
- 차량
- 오퍼
- 가격
- 정책
- 이후 고객/접수/계약/정산

AI Core:
- data.table
- data.filter
- data.sort
- navigation.restore

목록 기본 필드:
- canonical name
- entity id
- availability / business gate
- validation
- source head / freshness evidence
- revision
- updated
- publication / consumer evidence

금지:
- 여러 의미를 한 개의 generic `status` 컬럼이나 한 개의 색으로 합치지 않는다.
- Product `HOLD`, Source `STALE`, Health `BLOCKED`, Validation `INVALID`를 같은 "문제 상태"로 평탄화하지 않는다.

## 4. Entity Detail

Header:
- entity name
- id
- revision
- validation
- freshness

Tabs:
1. 현재값
2. 원문
3. 변환
4. 출처
5. 소비처
6. 변경이력

필드 하나를 누르면 provenance drawer:

- canonical value
- raw value(s)
- transform rule
- authority
- active override
- source revision
- canonical revision
- consumer projections

## 5. 직접 수정

수정 가능 필드만 edit affordance를 제공한다.

저장 전:
- before / after diff
- authority
- 영향 consumer
- validation
- reason

쓰기:
- expected_revision 필수
- stale revision이면 conflict 화면
- retry가 duplicate write를 만들지 않음

저장 후 상태:
- Canonical 저장
- Projection 생성
- Consumer delivery/ack

Critical failure는 toast로 끝내지 않고 inline status로 유지한다.

## 6. 흐름

Data Lineage graph:

```
source
  ↓
adapter
  ↓
raw snapshot
  ↓
normalizer
  ↓
validator
  ↓
canonical
  ↓
projection
  ↓
consumer
```

각 node:
- status
- last run
- revision
- input/output count
- error count
- duration
- evidence

Release node detail:
- exact Canonical input entity/revision set
- manifest
- input digest / data digest
- field evidence count
- field별 SOURCE_LINEAGE / REVISION_HISTORY 근거

## 7. 연결

Consumer table:
- consumer
- contract version
- domains
- mode
- health
- canonical revision
- consumed revision
- active release ID / manifest ID
- input digest / data digest
- lag
- last acknowledged

상태:
CONNECTED / DEGRADED / LAGGING / ERROR / MIGRATING / LEGACY_DIRECT

## 8. 변경이력

append-only audit surface.

각 row:
- time
- actor
- entity
- action
- before → after
- reason
- canonical revision
- affected projections
- receipt

Compare revision 제공.

Revision detail은 queryable Canonical Revision Snapshot을 기준으로 r1/r2/r3 상태를 재현한다.
Audit은 왜/누가 바꿨는지, Revision Snapshot은 그 시점의 상태가 무엇이었는지를 담당한다.

Rollback은 즉시 destructive revert 대신 rollback candidate 생성 후 적용한다.

## 9. 모바일

모바일은 관제 전체 graph를 억지로 축소하지 않는다.

- 홈: 핵심 health cards + 최근 오류
- 데이터: 1-column list
- 상세: tab/section 순차
- edit: bottom action boundary
- lineage: 단계형 vertical flow

데스크톱:
- table + split detail
- wider lineage graph
- persistent filters

## 10. Source 변경 검수

Source fingerprint 변경이 감지된 기존 binding은 Review Queue에 노출한다.

검수 화면:
- source before / after fingerprint
- accepted source-head run
- Canonical revision baseline
- field diff
- before / after
- REVIEWABLE / BLOCKED
- Authority rule
- candidate issue
- 영향 entity

BLOCKED 변경이 하나라도 있으면 "반영" 버튼을 비활성화한다.
REVIEWABLE 변경은 현재 diff 전체를 승인해야 binding을 새 source fingerprint로 전진시킨다.

## 11. 추가 / 수정 UX

직접 추가는 Firestore document editor를 노출하지 않는다.

- "직접 추가"는 Manual Source/Command를 생성
- 지원하는 도메인별 입력 Form 제공
- 저장 전 validation + authority + 영향 범위 확인
- 저장 후 canonical revision / audit / lineage / receipt 표시

수정도 Field Authority에 등록된 필드와 Command만 편집 가능하게 한다.


## 12. 상태 / 오류 표현 규격

FreePass Data는 상태 축이 많으므로 **상태의 의미를 먼저 분리**한다.

### 상태 축

- Domain / Asset availability: `AVAILABLE / PARTIAL / HOLD / UNAVAILABLE`
- Canonical validation: `VALID / WARNING / INVALID`
- Source health: `HEALTHY / DEGRADED / ERROR / UNKNOWN`
- Source run: `RUNNING / COMPLETED / FAILED`
- Source head: `PENDING / CURRENT / STALE / INELIGIBLE`
- Catalog health: `HEALTHY / DEGRADED / BLOCKED`
- Health check: `PASS / WARN / FAIL`
- Projection release: `BUILDING / VALIDATING / READY / ACTIVE / FAILED`
- Coverage / evidence: `ATOMIC / PARTIAL_MULTI_READ / NOT_EVALUATED / NOT_APPLICABLE`

### 의미 규칙

- `HOLD`: 권한·검수·가용성 gate. 시스템 오류와 동일시하지 않는다.
- `BLOCKED`: 현재 health scope에서 integrity error가 있어 진행 불가.
- `STALE`: 시간/순서상 최신 head가 아님. 실패와 동일하지 않다.
- `UNKNOWN`, `NOT_EVALUATED`: 근거 부족. 성공처럼 초록색으로 보이지 않는다.
- `NOT_APPLICABLE`: 해당 조건 자체가 적용되지 않음. 미평가와 구분한다.
- `ERROR`, `FAILED`, `FAIL`: 실제 실행/검증 실패.

### 화면 규칙

- 한 행에는 필요한 상태 축만 1~3개 노출하고, 나머지는 Inspector에서 상세 제공한다.
- 상태는 색 + 텍스트로 표현하며 색만으로 의미를 전달하지 않는다.
- health summary 옆에는 항상 coverage를 확인할 수 있어야 한다.
- 오류는 `code + 사람이 읽는 message + entity/context + evidence` 순으로 제공한다.
- 복구 가능한 일시 오류는 retry affordance를 제공하되, authority/integrity gate는 원인을 해결하기 전까지 retry 버튼으로 우회하지 않는다.
- critical error는 toast만으로 끝내지 않고 해당 row/panel/Inspector에 지속 표시한다.

## 13. 접근성 / 상호작용

AI Core 기준:
- WCAG 2.2 AA
- keyboard complete
- visible focus
- color-only status 금지
- loading/empty/error/populated 분리
- IME safe
- search/filter context restore
- async write receipt
- conflict explicit
