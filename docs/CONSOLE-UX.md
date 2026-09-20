# FreePass Data Console UX

Status: DESIGN BASELINE
AI Core consumer: YES

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
- source freshness
- active ingestion
- consumer lag
- failed deliveries
- recent changes

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
- status
- canonical name
- entity id
- source
- validation
- revision
- updated
- consumer coverage

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

## 10. 추가 / 수정 UX

직접 추가는 Firestore document editor를 노출하지 않는다.

- "직접 추가"는 Manual Source/Command를 생성
- 지원하는 도메인별 입력 Form 제공
- 저장 전 validation + authority + 영향 범위 확인
- 저장 후 canonical revision / audit / lineage / receipt 표시

수정도 Field Authority에 등록된 필드와 Command만 편집 가능하게 한다.

## 11. 접근성 / 상호작용

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
