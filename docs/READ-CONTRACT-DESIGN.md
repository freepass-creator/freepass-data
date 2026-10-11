# 상품 중심 Firestore 직접 읽기 — 기존 구현 확장

상태: CODED / TESTED / INTERNAL_DIRECT_READ_VERIFIED. 운영 배포·각 소비처 화면 전환은 미검증이다.
목적: 상품 전체 정보를 온라인에서 직접 읽고, 공급사/차명/차량번호를 검색조건으로 사용한다. 사용자 최신 지시가 이전 설계의 신규 계약·reader 제안보다 우선한다.

## 실행 진입점과 권한

- 기존 `FirestoreCatalogCompatibilityReader.readStoredProducts` → 기존 application `readStoredConsumerProducts` → 기존 `query-canonical-by-plate` job을 재사용한다. 새 reader/API/요율/계약 파일/저장소 없음.
- 실행: 기존 job에 `--firestore --direct --stored-products --search-file <private-json> --local-output <private-file>`. 검색키 productId/supplierId/supplierName/vehicleName/plate, `{}`는 저장 상품 전체다.
- trusted server-only 구현이다. 호출 서버 자신의 승인된 읽기 credential과 중앙 `getTargetFirebaseApp`을 사용한다. consumerId 문자열 검사는 실제 IAM/인증 승인이 아니며 credential을 복사·발급하지 않는다. 공개/ERP consumerId는 이 내부 진입점에서 거부한다.
- 원천행은 호출 서버가 기존 권한을 검증한 뒤 전달하는 `sourceGrant`가 없으면 읽지 않고 HOLD한다. COLLECTED + supplierIds로 범위를 제한하며 빈 배열은 읽기0, null은 명시적인 전체 원천 범위다. 사용자 HTTP 본문을 grant로 넘기지 않는다. 내부 운영자 CLI만 자신의 Firestore 권한으로 전체 원천을 요청하며 소비처 토큰/IAM 승인을 대체하지 않는다.
- 공급사 검색은 기존 등록부/F04의 명시적 별칭과 법인 표식만 정규화한다. 부분 이름으로 ID를 추정하지 않으며 복수 공급사 연결은 HOLD다. 사진 접근은 NOT_CHECKED, ledger 관측 시각·digest와 canonical/원천 시점은 각각 보존한다.
- 상품의 원문 자유문장 전체, 고객·계약·정산사건·사용자 모음, 파트너 연락처를 반환하지 않는다. 내부 수수료를 공개 서비스에 내보내지 않는다. 원본/사람 입력/가격 변경과 쓰기는 없다.

## 서로 다른 저장·관측 영역

- `products` 전체와 `policy`, 이름 권위 `partner`, 저장 `period_fee_ledger`, `catalog_offers`를 같은 read-only 트랜잭션으로 읽는다. 상품 ID로만 저장 offer/ledger를 연결한다. 기존 코드 형식이나 차번/이름으로 ID를 추정하지 않는다.
- `canonicalProducts`는 기존 `queryFirestoreProducts` callback으로 별도 조회한다. 저장 model/asset/product/offer/policy, 기간별 저장 economics와 UNKNOWN 진단을 보존한다. canonical과 legacy를 추정 병합하지 않는다.
- `sourceRows`는 기존 source store와 `readCurrentReferenceObservations`로 현재 봉인 원천행 전체를 읽는다. REJECTED도 숨기지 않는다. CURRENT는 canonical 최신화 증거가 아니며 원천행 ID는 영구 상품 ID가 아니다.
- 세 영역은 각각의 authority와 관측 시각을 보존한다. source는 별도로 봉인하며 canonical도 별도 읽기다. 하나의 원자적 snapshot이나 실물 차량 합산으로 표시하지 않는다.

## 저장 사실과 결측

- 기존 상품의 가격·제원·옵션·색상·연식·주행거리·최초등록일·상태를 허용 필드로 보존한다. 빈 값/미연결은 null/UNKNOWN와 이유를 표시한다. 0과 미확정을 구분한다.
- 공급사 이름은 partner 레코드 기준이며 검색은 기존 sharedSheetRegisteredChannels의 명시 이름/코드도 재사용한다. 법인명과 등록명을 fuzzy 추정하지 않고, 여러 supplierId가 같은 검색명에 대응하면 HOLD다. 이름이나 정책 연결이 복수/미확인인 경우 선택하지 않는다. 검색 빈 결과는 NOT_OBSERVED이며 존재하지 않는다는 증거가 아니다.
- 조회 중 요율 계산 없음. 저장 ledger 이력과 현재 확정 수수료를 구분한다. 활성 ledger 기준 미검증/미저장은 UNKNOWN, source-only preview fee도 UNKNOWN이다. canonical 저장 economics는 기존 순수 mapper로 반환한다.
- photo_original_refs의 기존 검토표식/수와 상품·index 검토 metadata 참조를 반환한다. 원본 주소·공급사 키·승인 ref ID를 노출하지 않는다. 사진 링크 계열은 STORED_UNVERIFIED/UNKNOWN를 구분하며 기존 사진 투영을 통해 접근한다. 내부 소비처의 serving grant는 미승인으로 명시하며 readerMethod는 null이다. 기존 resolveReferenceVehiclePhotos의 허용 imageUrls/representativeUrl은 accessVerification NOT_CHECKED와 함께 재사용한다. 저장51은 bytes/대표사진/공개화면 검증 완료가 아니다.

## 2026-10-11 구현 검증과 인계

- 기존 branch에 operator 조회 commit `1dac5cf` 결합(merge base `c968bbd2`). Academy READY; 기존 파일 확장만 수행.
- 관련234시험/build/architecture/data-access-boundary PASS. standards15시험 PASS이나 기존 capability 상태는 PARTIAL이다. Claude 첫 검토 REVIEW_TIMEOUT; 좁힌 후속 검토 진행 중이며 PASS로 계산하지 않는다.
- 23:05 KST 직접 온라인 조회: legacy products1776/policy82/partner64/catalog offers160/ledger0, canonical160상품568기간, source175행. 정확 legacy productId로 연결된 catalog offers0; 가격 미관측52, 공급사명 미확인7. 영역 차이를 누락대수로 계산하지 않는다.
- 저장 사진51 상품을 정확 상품 검색으로 재조회해 count51/serving references51 일치. source GET/DB쓰기0. 공개화면 미실행.
- 공급사별 분모 legacy21/canonical13/source14그룹과 비공개 증거: `C:/Users/admin/.codex/private/freepass-data-direct-read-20261011/consumer-readback-complete.json`, `stored-products-readback-complete.json`. 개인정보/차번/시트ID 공개0.
- next_start_here: PR465 정확 head → 금액 담당의 저장값 exact join → 기존 소비처 호출 연결 → 동일 상품 실제 출력. ledger 미저장/원천과 canonical freshness/운영 IAM·배포·화면은 남음. main 반영은 지휘 책임 방이 통제한다.

- 후속 통합: 저장 economics helper 50be05ce/db509e2a와 exact historical no-write guard 9cf139bc 결합. f1be248e 전체2391 PASS/18skip, 관련285 PASS. 이후 공급사 등록명 검색 보완 관련286 PASS; 최신 main의 photo 성능 변경은 별도 책임자가 통합한 코드를 보존했으며 이 조회 작업의 배포 완료로 세지 않는다.
- Claude ANSWERED/exit0에서 반환 수/canonical callback 상태/photo-serving 권한 3반례를 찾아 수정·회귀시험했다. 두 재검토 timeout은 PASS가 아니다. latest exact head를 지휘·품질 역할에서 독립 검증한다.
