# 공급사 공통 사본 서빙 — 구현 ① 기록 (2026-10-15)

설계 승인: 커맨드 센터 2026-10-15(설계 `SUPPLIER-PHOTO-INTAKE-AUTOMATION-DESIGN-20261015`, 가지 supplier-photo-intake-design-20261015). 이 문서는 구현 ①(서빙·카운트 일반화)만 기록한다.

## 무엇이 바뀌었나
- 이안카(#651) 한정이던 «사본 우선 서빙»·`photo_approved_count` 를 **허용표 안의 공급사 불문**으로 일반화.
- 도메인(`src/domain/consumer-output-contract.ts`): `isSupplierCopyPhotoProduct(product, suppliers)`, `approvedPhotoCount(product, suppliers)`, `parsePhotoCopySuppliers(text)`, `createVehiclePhotoReader(..., copySuppliers)`. `isIancarCopyPhotoProduct`·`approvedIancarPhotoCount` 는 이안카 한정 호환 이름으로 남김.
- 읽기 서비스(`erp5-compat-catalog-reader`)와 공개 피드(`public-product-feed`)가 **같은 허용표**(환경변수 `FREEPASS_DATA_PHOTO_COPY_SUPPLIERS`)를 써서 «세어 놓고 못 서빙»하지 않는다.

## 허용표
- 환경변수 `FREEPASS_DATA_PHOTO_COPY_SUPPLIERS=RP031,RP0xx,…`(쉼표). 비어 있으면 이안카(RP031)만 = 종전 동작. RP031 은 항상 포함. 형식(`RP###`)이 틀린 항목은 무시.
- 정책(커맨드 센터 결정): freepasspics 아래 공급사 폴더가 있는 공급사 전부, 단 공급사미확인·SA 같은 미확정 폴더 제외, 아이카는 대표 확인 전 제외. 값(코드 목록)은 운영이 환경에 설정한다 — 코드는 값을 하드코딩하지 않는다.

## 사본 상품 조건
허용표 안의 공급사 + `isApprovedVehiclePhotoProduct` 조건 + 모든 refs 가 그 공급사의 허용 방법 + ONE 결속 refs(`sourceKind`) 아님.
- 이안카: `IANCAR_COMPRESSED_COPY` 만(종전).
- 그 밖: `SUPPLIER_FOLDER_COPY`(구현 ②③ 인입 잡이 쓸 방법 코드)·`AUTO_KAKAO_COLLECT`(기존 카톡 수집 등록). 방법 코드는 공존.

## 효과
- 허용 공급사 상품은 기계 소비처(`erp5-public-media`)도 드라이브 사본(sha256 검증)으로 서빙, 외부 원천 호출 0.
- 허용표 밖 공급사는 종전 동작(기계 소비처 거절, 내부 소비처는 승인 refs 서빙) — 불변 시험 포함.

## 켜는 순서(운영)
1. 배포(환경변수 미설정 = 동작 불변).
2. `FREEPASS_DATA_APPROVED_PHOTO_READER`(drive-api) 확인.
3. `FREEPASS_DATA_PHOTO_COPY_SUPPLIERS` 설정.
4. ERP5(ERP·개발)가 `photo_approved_count > 0` 규칙으로 전환(RP031 한정 해제).

## 시험
`tests/supplier-copy-serving.test.ts`(허용표 파싱·공급사별 허용 방법·카운트·허용/비허용 서빙·sha256 불일치/404/리더 꺼짐/비적격·이안카 불변), `tests/iancar-copy-first-serving.test.ts`(종전 이안카), `tests/public-product-feed.test.ts`.
