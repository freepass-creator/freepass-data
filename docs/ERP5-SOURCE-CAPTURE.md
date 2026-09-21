# ERP5 읽기 전용 원문 캡처·매핑 점검

상태: **원문 캡처/로컬 진단 검증, 운영 전환 HOLD**. 2026-09-21.
선행: `9895b518675e75b9371bdf169e7f11ffb5d88198`의 순수 상품 매퍼.

## 담당 경계

`보완할 작업 찾기`와 `클론하기`가 2026-09-21 분담을 확인했다.
이 단위는 `erp5-source-capture.ts`, `inspect-erp5-source.ts`, 신규 테스트, 이 문서만 담당한다.
PR23의 Firebase binding/gateway/auth, 계약·정산 연결지도, 공용 root의 미커밋 작업은 수정하지 않는다.
원문 수집을 위해 다른 collector나 운영 writer를 동시에 실행하지 않는다.

## 동작

1. 고정 프로젝트 `freepasserp5`, 기본 DB의 `products`와 `policy`만 대상으로 한다.
2. `beginTransaction`에 `options.readOnly`를 명시하고, 같은 transaction에서 각 컬렉션의
   독립 COUNT(*)와 제한/필터 없는 runQuery를 수행한다. 응답 readTime 불일치, 누락·중복 문서,
   count 불일치, 잘못된 경로, 오류 응답은 전체 실패다. 마지막에는 rollback으로 읽기 transaction을 닫는다.
3. Firestore REST document의 name/createTime/updateTime/typed fields를 그대로 복사해 보존한다.
   transaction ID와 access token은 캡처 파일이나 로그에 넣지 않는다.
4. 원문은 사용자 홈 `.codex/private/freepass-data-source-captures/<unique-run>/capture.json`에만
   새로 쓴다. 기존 파일 덮어쓰기, Git 경로·하위 경로 리디렉션, 서버 쓰기/전환은 허용하지 않는다.
   저장 후 새 파일 읽기로 SHA-256 및 전체 건수/문서 경계를 재검증한다.
5. JSON으로 손실 없이 해석 가능한 각 상품만 기존 순수 매퍼에 넘긴다. 최상위 메타데이터
   `policy_reference_checked_at`/`updated_at`의 Timestamp만 RFC3339 검증 후 원문 문자열 그대로
   사용한다. 나노초/시간대 표기는 보존하고 업무 필드에 그 의미를 옮기지 않는다. 기타 미지원 자료형은
   해당 상품을 decode HOLD로 세고 원문은 보존한다. stdout은 수치·사유 코드·증거 경로만 제공한다.

현재 CLI는 다음 고정 호출만 지원한다.

```powershell
# 기존 로그인에서 확보한 토큰을 이 실행의 프로세스 환경에만 주입한다.
# 토큰을 출력하거나 명령행 인수/파일/Git에 기록하지 않는다.
node --import tsx src/jobs/inspect-erp5-source.ts --live-read-only
```

인증 변수는 `FREEPASS_ERP5_READ_ACCESS_TOKEN`이다. 종료 후 이전 환경을 복구한다.
CLI는 캡처가 성공해도 운영 미준비를 나타내는 **exit 2/HOLD**를 반환한다.
고정 Google API endpoint만 사용하고 redirect를 거부한다. 허용 RPC는 beginTransaction/runQuery/
runAggregationQuery/rollback뿐이며 commit/batchWrite 등 문서 변경 경로는 없다.
오류 응답 본문/토큰/원문은 stderr에 출력하지 않는다.

Windows Codex 패키지의 LocalAppData 가상화로 인해 최초 경로 검사는 네트워크 호출 전에
중단됐다. 이를 우회 허용하지 않고 저장 위치를 가상화되지 않는 사용자 홈의 전용 비공개 경로로 옮겼다.
이 경로는 OS 사용자 권한을 상속하며 Windows에서 POSIX mode만으로 암호화/추가 ACL을 보장하지 않는다.

## 실제 읽기 증거

동일 transaction readTime: **2026-09-21T09:06:44.344978Z (18:06:44 KST)**.
source capture digest: `ad67d6f5ef2914b90dc682704f1894105079ebbbbc0d8be44269cf69c68e735f`.
비공개 실행 디렉터리 식별자: `8b56806f-9b94-40c4-87db-fea6391145d5`.
원문/실제 차량번호/상품·정책 본문은 이 저장소에 넣지 않았다.

| 범위 | 실제 관측 |
|---|---:|
| products 문서 / 독립 COUNT | 1,659 / 1,659 |
| policy 문서 / 독립 COUNT | 81 / 81 |
| MAPPED_FOR_REVIEW | 0 |
| 의미/필수값 mapping HOLD | 1,659 |
| Firestore typed decode HOLD | 0 |
| 전체 상품 분류 합계 | 0 + 1,659 + 0 = 1,659 |
| 차량번호 별도 읽기 성공 / 미해석 | 1,659 / 0 |
| 차량번호 공백 제거 기준 중복 | 0 |

위 셋의 상품 결과 범주는 상호 배타적이다. decode HOLD는 운영 데이터 오류·삭제 사유가 아니다.
차량번호 점검은 다른 필드의 decode 실패와 독립적으로 전수를 수행했다. 중복 0은 상품/오퍼 등
다른 업무 키의 통합이 완료됐다는 뜻이 아니다.

최초 점검의 893건 해석 보류 원인은 모두 `UNSUPPORTED_FIRESTORE_VALUE`였다. 원문 typed tag 조사에서
timestampValue 1,030개(`policy_reference_checked_at` 887개 + `updated_at` 143개)를 확인했다.
한 문서에 두 timestamp가 있을 수 있으므로 필드 개수와 문서 개수는 다르다.
referenceValue/geoPointValue/bytesValue는 관측된 상품 원문에서 0개였다.
관측된 두 메타데이터 필드만 해석하도록 보완한 뒤 같은 캡처를 다시 읽어 893건 모두 의미 검사에
포함했다. 원문형은 capture.json에 그대로 남으며 digest가 동일함을 확인했다.
임의 업무필드(model/year 등)나 중첩 Timestamp를 일반 문자열로 바꾸는 완화는 하지 않았다.

최종 1,659건 전수 의미 HOLD의 상위 사유는 다음과 같다. **한 상품에 여러 사유가 있으므로 합산하면 안 된다.**
최초 부분 해석 결과(summary/summary-v2) 대신 전수 의미 검사 결과(summary-v3)를 사용한다.

| 사유 | 상품 수 |
|---|---:|
| 연간 주행거리 의미 미확인 | 1,466 |
| 정책 연결 검토 필요 | 1,342 |
| 보증금 규칙 글자 의미 보존 필요 | 1,018 |
| 보증금 금액/상태 미확인 | 1,014 |
| 손오공 bucket 분류 증거 부족 | 736 |
| 미지원 가격 키 | 720 |

policy 81건은 **동일 시점 원문 캡처·건수 검증만** 했다. 정책 내용·고유키·가격 계산·상품별 연결을
검증하거나 Canonical Policy로 반영하지 않았다. 이를 정책 정합성 PASS로 보고하지 않는다.

readTime은 DB의 일관된 관측 시점이지 공급사 최신 수집 시각이 아니다. digest는 capturedAt까지
포함한 해당 증거 묶음의 무결성 식별자이며, 원문 서명/공급사 revision 또는 여러 회차의 내용 동일성 키가 아니다.
공급사 API/원천 → ERP5, ERP5 → Canonical, Release → 소비처의 정합성은 각각 미검증이다.

## 검증·검토와 남은 작업

### Canonical DRY RUN 후보 묶음

기존 캡처와 `erp5-product-mapping/2`를 재사용하는
`npm run dry-run:erp5-canonical -- --capture <private capture.json>` 명령을 추가했다.
신규 job이 필요한 이유는 기존 매퍼가 단건 순수 변환만 제공하고 전체 캡처의 건수 고정,
건별 HOLD 사유, 결과 digest, 비공개 파일 readback을 하나의 실행 증거로 만들지 않았기 때문이다
(`CREATE_NEW_JUSTIFIED`: private orchestration only; mapping logic is reused).

최신 캡처의 DRY RUN 결과는 source 1,659건과 candidate 1,659건이 일치하고,
`mappedForReview=0`, `hold=1659`, `canonicalWriteAuthorized=false`다. 결과 원문은
캡처와 같은 Git 외부 비공개 실행 디렉터리에 새 파일로 저장하며 기존 파일을 덮어쓰지 않는다.
각 후보에는 중복 가능한 검토 축(`IDENTITY`, `CLASSIFICATION`, `PRICE_STRUCTURE`,
`DEPOSIT`, `MILEAGE`, `POLICY`, `OTHER_DATA_QUALITY`)을 붙인다. 한 차량의 여러 문제를
임의로 한 사유로 축소하지 않으며, stdout에는 축별 건수와 복잡도만 출력한다.

같은 비공개 산출물에는 products 원문을 중첩 map/array까지 재귀적으로 해부한 field profile을
포함한다. 경로별 존재/누락 문서 수, 반복 출현 수, Firestore 자료형 분포, null/빈 문자열 수,
값 fingerprint 기준 고유값 수, 문자열 최소/최대 길이를 기록하되 실제 scalar 값은 프로파일에
복사하지 않는다. 현재 1,659건에서 508개 field path가 관측됐다. 이는 구조 파악 증거이며 필드의
업무 의미나 쓰기 권한을 자동 확정하지 않는다. 의미·단위·authority·소비처 매핑은 경로별로 별도
검토해 데이터 사전에 승격한다.

같은 명령에 `--previous <previous capture.json>`을 붙이면 검증된 두 FULL 캡처의 products 전체를
문서 ID와 원문 fields fingerprint로 비교한다. 결과는 `ADDED`, `CHANGED`, `UNCHANGED`,
`MISSING_FROM_SOURCE`로 전수 분류하고 `vehicle_status`/`listable` 변화는 별도 inventory transition으로
보존한다. `MISSING_FROM_SOURCE`는 삭제·판매·출고불가를 뜻하지 않으며 결과와 각 레코드 모두
`destructiveActionAuthorized=false`다. 상세 ID와 전환 전후 값은 Git 밖의 별도 비공개 delta 파일에만
저장하고 stdout에는 건수·digest·관측 시각만 출력한다. 이전 캡처보다 과거인 current 입력은 거부한다.

최초 검토 축 감사에서 IDENTITY 24건은 모두 차량번호가 아니라 maker/model 공란이었다.
22건은 maker와 model이 모두 공란이고 2건은 model만 공란이다. 같은 캡처의 productCode,
carNumber에는 완전한 형제 레코드가 없었고 providerCompanyCode는 대부분 다건 공급사라
차종을 결정할 근거가 아니다. 따라서 자동 복구하지 않고 `SOURCE_EVIDENCE_REQUIRED`로
유지한다. 공급사 분포는 RP023 10, RP020 3, RP004/RP013/RP018/RP012 각 2,
PT-0023/PT-0001/RP022 각 1이다. 다음 조회는 이 공급사별 원천에서 차량번호를 키로
maker/model을 확인하는 읽기 전용 대조이며, ERP5의 빈 값을 추정으로 채우지 않는다.

CLASSIFICATION 903건을 원문 필드 존재 여부로 다시 감사했다. `source_bucket`은 RP012 문제
736건뿐 아니라 캡처 1,659건 전체에서 누락되어 있었다. 따라서 공급사 코드나 현재 상품명만으로
`SON_NO_KONG`/`TCAR_EXTERNAL`을 역추정하지 않고 736건을
`SONOGONG_CLASSIFICATION_EVIDENCE_MISSING`으로 유지한다. 미인식 상품종류 167건 중 155건은
RP023의 명시적 `오플구독`, 11건은 필드 누락, 1건은 빈 문자열이었다. 매퍼 v2는 155건을
`OPLUS_SUBSCRIPTION` 후보로 보존하되 현재 Canonical 계약에 없는 값이므로
`CATALOG_COMMERCIAL_TYPE_EXTENSION_REQUIRED` HOLD로 분류한다. RP023 이외 공급사의 같은 표기는
추가로 `SUBSCRIPTION_SUPPLIER_REVIEW_REQUIRED`다. 나머지 12건은 계속 원천 증거가 필요하다.

- `npm run check`: architecture/TypeScript build, Vitest 290건, emulator-only 4건 skip,
  read-runtime smoke 5건, shadow 10건, Sheets 20건 통과.
- 실패 반례: 잘린 쿼리, 다른 프로젝트/중첩 경로, 중복 문서, readTime 불일치, 정책 읽기 실패,
  저장 후 손상, count 재작성, 미지원/부정확 자료형, 원문 없는 차량번호, 중복 차량번호, write RPC 차단.
- 실제 capture 후 저장 파일을 다시 읽어 요약 v2/v3를 생성했다. 원문 파일과 이전 요약은 덮어쓰지 않았다.
- Cursor 읽기 전용 검토: 같은 transaction/count 검증, 원문 보존, 고정 API, HOLD 경계에 동의했다.
  Timestamp 증분 검토에서 나노초 문자열의 수용 여부가 Date.parse 구현에 의존할 수 있음을 지적해,
  메타데이터는 정규식과 달력 범위로만 검증하고 원문 문자열을 유지하도록 반영했다.
  업무필드/중첩 Timestamp는 지원 범위로 확대하지 않는 반례도 검사했다.
  제안 중 빈 배열도 정상 빈 조회로 허용하는 완화는 채택하지 않았다. 공식 runQuery 계약은
  빈 결과에도 readTime 응답을 제공하며, 증거가 없는 빈 응답은 HOLD가 맞다.
  rollback 실패 무시는 채택하지 않았다. 정리 실패는 성공으로 표시하지 않는다.
  digest에서 capturedAt을 빼자는 제안은 증거파일 식별자라는 현재 목적과 달라 채택하지 않았다.
  대량 응답은 별도 페이지 수집을 아직 구현하지 않았다. 전체 count와 다르면 중단하며 부분 캡처를 성공으로 보지 않는다.
- Claude 주간 한도, Gemini 인증 403으로 검토 UNAVAILABLE. 두 결과를 PASS로 계산하지 않는다.
- 다음 순서: 가격/보증금/정책/분류의 원천 근거 대조
  → 검토된 Canonical 반영안. 실제 DB 쓰기/소비처 전환은 해당 단위의 별도 승인과 검증을 거친다.

공식 API 근거:
[beginTransaction](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/beginTransaction),
[runQuery](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/runQuery),
[runAggregationQuery](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/runAggregationQuery).
