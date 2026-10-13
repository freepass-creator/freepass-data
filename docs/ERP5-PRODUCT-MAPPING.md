# ERP5 상품 입력 매핑 — 독립 준비 단위

상태: 로컬 순수 변환 구현, **운영 연결/Canonical 반영 HOLD**.
기준: FreePass Data `04cd7b9`, branch `codex/erp5-product-mapping-20260921`.

## 세션 소유권

2026-09-21 사용자 중복 방지 요청에 따라 다음 분담을 상대 작업과 확인했다.

- `보완할 작업 찾기` (`01a0c306-6305-7600-a08c-a782b2825ed0`):
  `src/adapters/erp5-product-mapping.ts`, `tests/erp5-product-mapping.test.ts`, 이 문서만 담당.
  worktree: `C:/Users/admin/.codex/worktrees/erp5-product-mapping/freepass-data`.
- `클론하기` (`01a0c2ce-94b7-7153-a9a6-2b62d4770cc7`):
  `codex/erp5-consumer-runtime-20260921`에서 Firebase binding, bootstrap/API, infra stores,
  환경설정, 연결 검사 담당. 공용 root의 미커밋 파일을 서로 포함하지 않는다.

이 단위에는 수집 CLI·Firebase SDK·네트워크·저장소 쓰기·배포·스케줄 변경이 없다.
상대 작업이 실제 입력 수집과 통합을 맡는다. 중복 수집기/정규화기 또는 별도 writer를 만들지 않는다.

## 조사 근거와 의미 차이

조사한 ERP 앱 로컬 HEAD: `31c4504b8712dcbd6ec56673a76156bc227b5d65`.
운영 엔진 계열은 `C:/dev/worktrees/freepasserp4/f01-f86-online-20260921`의 다음 파일도 읽었다.
이 코드를 읽은 사실은 배포 버전 또는 라이브 데이터의 현재 정확성을 보증하지 않는다.

- `lib/domain/erp5-product-ssot.ts`: 제품은 `price` 외에도 `adapter_pricing`,
  `offer_terms`, `rent_variants`/`rentVariants`에 요금·보증금 의미를 가질 수 있다.
- `lib/domain/inventory-contract.ts`: 등록 재고와 가격 완성도는 별개이며 출고불가도 보존한다.
  `listable`과 `status_kind`는 `vehicle_status`로부터 파생되는 재고 캐시다.
  `listable=true`만으로 고객 공개 가능·필수 가격 완성·계약 가능을 보증하지 않는다.
- `lib/domain/sales-published-tabs.ts`: 손오공은 보증금을 규칙 글자로 보존하며
  `price[기간].deposit=0`이 규칙과 함께 존재할 수 있다. 이 숫자만 읽어 무보증으로 판단하면 오류다.
- `lib/server/sales-publish-snapshot.ts`: products/policy/partner를 같은 읽기 전용 트랜잭션으로
  캡처하고 document ID를 `_key`에 보존한다. 원천 최신성은 캡처 시각 자체와 다르다.
- 이 저장소의 기존 `legacy-freepasserp3.ts`와 legacy normalizer는 ERP3 출처/가격 의미를
  전제로 한다. 프로젝트 환경변수만 ERP5로 바꾸는 연결을 대체하지 못한다.

## 입력과 출력

```ts
import { mapErp5Product } from './src/adapters/erp5-product-mapping.js';

const result = mapErp5Product({
  projectId: 'freepasserp5',
  collection: 'products',
  documentId: 'actual-document-id',
  sourceRevision: 'actual-pinned-snapshot-revision',
  observedAt: '2026-09-21T10:00:00.000Z',
  data: originalJsonProduct
});
```

이는 호출 형식 예시다. 위 ID·시각으로 실제 데이터를 인증하지 않는다.
입력의 프로젝트·컬렉션·문서 ID·revision·밀리초 UTC 시각을 검사한다.
잘못된 envelope는 `INVALID_ERP5_PRODUCT_ENVELOPE`로 중단한다.
미확인 개별 필드는 원문을 그대로 둔 채 HOLD와 사유를 반환한다.

- `raw`: 전체 입력의 독립 복사. 소비처에 공개하거나 외부 AI 프롬프트/Git으로 보내지 않는다.
- `sourceId`: `freepasserp5/firestore/products`. ERP3 이름으로 오기하지 않는다.
- `candidate.sourceFingerprint`: 키 순서에 독립적인 JSON 원문 SHA-256. source authenticity 증거는 아니다.
- `candidate`: 명시된 상품 사실과 안전하게 읽을 수 있는 가격 후보. 최종 ID를 새로 발급하지 않는다.
- `inventory`: 원래 vehicle_status/status/status_kind/listable 축을 각각 보존한다.
- `fieldSources`: envelope 기준 JSON Pointer 경로. 최종 영구 lineage record를 대체하지 않는다.
- `status`: `MAPPED_FOR_REVIEW` 또는 `HOLD`. **모든 결과에 `canonicalWriteAuthorized=false`.**

Firestore Timestamp/GeoPoint/DocumentReference 등 SDK 객체를 `JSON.stringify`만 해서
조용히 손실시키지 않는다. 이 매퍼는 JSON만 받으므로 수집기에서 SDK 타입의 보존 직렬화와
원문 증거를 따로 정의해야 한다. 실제 document readTime/updateTime 및 수집 전체 범위 증거도
수집기 책임이다. 미래/오래된 원천인지와 sourceRevision의 진위는 이 순수 매퍼가 판정하지 않는다.

## 보존·HOLD 기준

- 정수 숫자 또는 정확한 정수/천 단위 쉼표 문자열만 금액으로 허용한다.
  `미확인`, `75만원`, 소수, 지수, 음수, 빈 값, boolean/배열/객체를 0이나 숫자로 추측하지 않는다.
  명시적 0은 다른 의미 증거가 없을 때 그대로 보존한다.
- `24_2만`과 `24_3만`을 다른 termKey로 유지한다. 지원하지 않는 인수형/반납형 키는
  원문에 남기고 HOLD한다. 알아볼 수 있는 일부 가격만으로 전체 후보를 통과시키지 않는다.
- deposit_note/offer_terms/adapter_pricing/rent variant가 있으면 의미 확인 전 HOLD다.
  이 경우 후보 보증금은 UNKNOWN으로 두고 규칙을 임의 계산하거나 ZERO로 내리지 않는다.
- fee/commission/fee_memo는 공개 후보에 복사하지 않으며 원문에 보존하고 HOLD한다.
  메모에 별도 조건이 있을 수 있어 부분 가격만 보고 무보증으로 판정하지 않는다.
  별도 deposit/pricing_rules/quotes와 KRW 외 명시 통화도 검토 전 HOLD다.
- 정책 코드가 있으면 같은 관측 회차의 policy 증거/정본 binding 검토 전 HOLD다.
- 기간만 있고 연주행거리 증거가 없으면 HOLD다. 무제한/미확인을 0으로 채우지 않는다.
- RP012의 공급사 축을 유지한다. 상품 유형은 원문을 정확히 읽고 bucket·차량번호와 모순이면
  HOLD한다. bucket이 없으면 분류를 추정하지 않는다. 손오공상품의 중고렌트/오공구독 및
  TCAR_EXTERNAL 픽업구독을 합치지 않는다.
- 출고불가·가격 미완성·삭제 표식 원자도 반환한다. `출고불가`를 SOLD로 추정하지 않는다.
  원본과 어긋나는 listable/status_kind는 고쳐 덮지 않고 HOLD다.
- 공급사 별칭 충돌·_key와 document ID 불일치·미확인 상태는 별도 검토한다.

## 통합 시 남은 조건

1. 모든 원천 레코드를 이 함수에 전달하고 HOLD/오류 건수를 함께 집계한다.
   오류 레코드를 skip해 남은 건만 성공으로 보고하지 않는다.
2. 입력 전체 문서 수·중복 문서/차량 키·동일 snapshot/policy/partner 연결은 수집/배치 단계에서 검증한다.
3. 최신 공급사 원천과 ERP5 원자가 일치하는지 별도 비교한다. 원자 매핑 성공은 원천 최신화가 아니다.
4. 현재 Catalog PriceTerm으로 표현 못 하는 정책/보증금 규칙/가격변형은 별도 계약 확장과 검토가 필요하다.
   OGONG_SUBSCRIPTION은 base domain에는 있으나 ERP public 계약에 없고, OPLUS_SUBSCRIPTION은
   base domain과 public 계약 모두에 없다. 두 값은 계약 전체가 합의될 때까지 HOLD하며 캐스팅으로
   소비처 검증을 우회하지 않는다.
5. Canonical 입력은 기존 검토/권한/lineage/expectedRevision 경로로만 반영한다.
   이 결과를 곧바로 ERP·화이트라벨·F01·F86·Admin에 발행하지 않는다.

원본과 실제 운영 소비자 검증은 이 로컬 단위에서 하지 않았다. 합성 시험 통과를 운영 전환
또는 전체 매핑 완료로 표현하지 않는다.

## 검증 기록

- 최종 `npm run check`: architecture/TypeScript build 통과, Vitest 290건(매핑 65건 포함),
  emulator-only 4건 skip, read-runtime smoke 5건, shadow 10건, Sheets Node 20건 통과.
- Cursor 읽기 전용 코드 검토에서 보증금 0과 수수료 메모의 의미 누락, 오공구독의
  Catalog 계약 누락, 삭제표식 대소문자 우회를 지적했다. HOLD/UNKNOWN 처리와 회귀시험에 반영했다.
- Codex와 Cursor는 원문 보존·엄격 숫자 파싱·복잡한 요금 의미의 HOLD·쓰기 승인 금지에 동의했다.
- Cursor의 재렌트/중고렌트 매핑 자체를 금지하자는 제안은 기존
  `docs/LEGACY-NORMALIZATION-RULES.md`의 확정 매핑과 원문 보존 근거로 채택하지 않았다.
  출고불가라는 이유만으로 매핑을 무조건 HOLD하자는 제안도 채택하지 않았다.
  등록 사실을 변환하는 것과 판매/공개 승인은 별개이며 원문 상태를 보존하는 회귀시험으로 확인했다.
- Claude: 주간 사용 한도로 UNAVAILABLE. Gemini: 인증 단계 서비스 비활성화 403으로 UNAVAILABLE.
  두 검토를 PASS로 계산하지 않는다. 운영 변경 승인 또는 필수 운영 검증을 대체하지 않는다.
